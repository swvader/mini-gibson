import sys, time
from playwright.sync_api import sync_playwright
exec(open('tools/convo_test.py').read().split("errs, logs")[0].split("URL = sys.argv[1]")[1])
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    ctx = b.new_context(); ctx.grant_permissions(['microphone']); ctx.add_init_script(FAKE_SR); pg = ctx.new_page()
    t0=time.time()
    pg.on('console', lambda m: print(f'{time.time()-t0:6.1f} {m.type}: {m.text[:160]}', flush=True) if '[gibson]' in m.text or m.type=='error' else None)
    pg.goto(sys.argv[1], wait_until='networkidle')
    pg.evaluate("localStorage.setItem('gibson.app.v1', JSON.stringify({wake: true, convo: true, convoTimeout: 10, vEngine: 'neural', vEngineV: 2}))"); pg.reload(wait_until='networkidle')
    pg.click('#start')
    pg.wait_for_function("GibsonApp.state().neural=='ready' && !GibsonApp.state().busy", timeout=120000)
    pg.wait_for_timeout(8000)
    for t in ["Okay. Call me if you need me.", "I would tell you a UDP joke, but you might not get it.", "Hello Lenny! I am Gibson. I polished my pixels just for you, and I am ready for anything. What should we build today?"]:
        a=time.time(); pg.evaluate("t => GibsonApp.speakOut(t)", t); print(f'   spoke in {time.time()-a:.1f}s  rtf={pg.evaluate("GibsonApp.state().rtf")}', flush=True)
    b.close()
