# Auto engine: with a stored slow speed (rtf 1.5) replies use the phone voice; with a fast one (0.6) they use neural.
import sys, time
from playwright.sync_api import sync_playwright
exec(open('tools/convo_test.py').read().split("errs, logs")[0].split("URL = sys.argv[1]")[1])
URL = sys.argv[1]; errs = []
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    ctx = b.new_context(); ctx.grant_permissions(['microphone']); ctx.add_init_script(FAKE_SR); pg = ctx.new_page()
    logs = []; pg.on('console', lambda m: (logs.append(m.text) if '[gibson]' in m.text else None, errs.append(m.text) if m.type in ('error','warning') and 'content-length' not in m.text and 'No available adapters' not in m.text else None))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(URL, wait_until='networkidle')
    pg.evaluate("localStorage.setItem('gibson.app.v1', JSON.stringify({vEngine: 'neural', convo: true}))"); pg.reload(wait_until='networkidle')   # old saved setting -> migrated to auto
    print('migrated engine:', pg.evaluate('GibsonApp.settings().vEngine' if False else "JSON.parse(localStorage.getItem('gibson.app.v1')||'{}').vEngine"), pg.input_value('#vEngine'))
    pg.click('#start'); pg.wait_for_function("GibsonApp.state().neural=='ready' && !GibsonApp.state().busy", timeout=120000); pg.wait_for_timeout(5000)
    print('measured rtf on this box:', round(pg.evaluate('GibsonApp.state().rtf') or 0, 2))
    for rtf in (1.5, 0.6):
        pg.evaluate(f"GibsonApp.Neural.rtf = {rtf}"); n0 = pg.evaluate('window.__phoneSpeak'); l0 = len(logs)
        a = time.time(); pg.evaluate("GibsonApp.speakOut('Why did the robot go on holiday? It needed to recharge.')")
        used = 'phone' if pg.evaluate('window.__phoneSpeak') > n0 else ('neural' if any('neural:' in l for l in logs[l0:]) else '?')
        print(f'rtf {rtf}: engine={used}, done in {time.time()-a:.1f}s')
    pg.click('#gear'); pg.wait_for_timeout(500); print('voice state shown:', pg.inner_text('#nState'))
    b.close()
print('ERRORS:', errs)
