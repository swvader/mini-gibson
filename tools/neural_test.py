# Headless check: neural voice loads in Chrome (WASM), generates clean audio, reports speed.
import sys, json
from playwright.sync_api import sync_playwright
URL = sys.argv[1]; dev = sys.argv[2] if len(sys.argv) > 2 else 'wasm'
errs = []
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_context(viewport={'width': 915, 'height': 412}, is_mobile=True, has_touch=True).new_page()
    pg.on('console', lambda m: errs.append(m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
    pg.goto(URL, wait_until='networkidle')
    print('isolated:', pg.evaluate('crossOriginIsolated'))
    pg.click('#start')
    for i in range(240):
        st = pg.evaluate('GibsonApp.state()')
        if st['neural'] in ('ready', 'error'): break
        pg.wait_for_timeout(1000)
    print('neural:', st)
    r = pg.evaluate('''async () => { const out = [];
      for (const v of [GibsonApp.NEURAL_VOICES[0], GibsonApp.NEURAL_VOICES[1]]) {
        const t0 = performance.now(); const m = await GibsonApp.Neural.gen('Hello Lenny. I am Gibson, and I am ready for anything.', v, 1);
        let nan = 0, mx = 0; for (const x of m.audio) { if (isNaN(x)) nan++; else mx = Math.max(mx, Math.abs(x)); }
        out.push({ voice: v.id, sec: +(m.audio.length / m.sr).toFixed(2), genMs: Math.round(performance.now() - t0), nan, peak: +mx.toFixed(3) }); }
      return out; }''')
    print('gen:', json.dumps(r))
    b.close()
print('ERRORS:', json.dumps(errs[:20], indent=1))
