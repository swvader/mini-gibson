# Headless check of the in-browser wake pipeline: feed held-out clips through wake-worker.js and compare to the Python reference.
import sys, json
from playwright.sync_api import sync_playwright
URL = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True)
    pg = b.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(URL, wait_until='networkidle')
    r = pg.evaluate('''async () => {
      const w = new Worker('wake/wake-worker.js'); const out = {}; let cur = null, max = 0, wakes = 0;
      await new Promise((res, rej) => { w.onmessage = e => { const m = e.data; if (m.type === 'ready') res(); else if (m.type === 'error') rej(m.msg);
        else if (m.type === 'score') max = Math.max(max, m.s); else if (m.type === 'wake') wakes++; };
        w.postMessage({ type: 'init', base: new URL('wake/', location.href).href, model: 'hey_gibson.json' }); });
      w.postMessage({ type: 'threshold', v: 0.5 });
      for (const n of ['pos_am_michael', 'neg_am_michael', 'pos_af_heart']) {
        const buf = new Int16Array(await (await fetch('tools/testclips/' + n + '.raw')).arrayBuffer());
        const pk = buf.reduce((a, x) => Math.max(a, Math.abs(x)), 1);
        const x = new Float32Array(32000 + buf.length + 16000); for (let i = 0; i < buf.length; i++) x[32000 + i] = buf[i] * 12000 / pk;
        max = 0; wakes = 0; w.postMessage({ type: 'pause', on: false });
        const t0 = performance.now();
        for (let i = 0; i + 1280 <= x.length; i += 1280) w.postMessage({ type: 'audio', data: x.slice(i, i + 1280) });
        await new Promise(r => setTimeout(r, 2500));
        out[n] = { max: +max.toFixed(3), wakes, ms: Math.round(performance.now() - t0) };
        w.postMessage({ type: 'pause', on: true });
      }
      return out; }''')
    print(json.dumps(r)); print('errors', errs); b.close()
