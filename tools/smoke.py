# Headless smoke test (phone landscape). Fake mic plays a held-out "Hey Gibson" clip to test the wake word end-to-end.
import sys, json, time
from playwright.sync_api import sync_playwright
URL = sys.argv[1]; MIC = sys.argv[2] if len(sys.argv) > 2 else None
errs, logs = [], []
args = ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
if MIC: args.append('--use-file-for-fake-audio-capture=' + MIC)
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=args)
    ctx = b.new_context(viewport={'width': 915, 'height': 412}, device_scale_factor=2, is_mobile=True, has_touch=True,
        user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36')
    ctx.grant_permissions(['microphone'])
    pg = ctx.new_page()
    def onc(m):
        if m.type in ('error', 'warning') and 'content-length' not in m.text: errs.append(m.type + ': ' + m.text)
        if '[gibson]' in m.text: logs.append(m.text)
    pg.on('console', onc); pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
    pg.goto(URL, wait_until='networkidle'); pg.wait_for_timeout(500)
    print('isolated:', pg.evaluate('crossOriginIsolated'), '| expressions:', pg.evaluate('Gibson.expressions.length'))
    pg.click('#start'); pg.wait_for_timeout(1500)
    print('after start:', pg.evaluate('Gibson.state.expression'), pg.evaluate('GibsonApp.state()'))
    # 1) typed message -> demo brain -> expression tag drives the face (phone/silent voice while neural loads)
    pg.click('#gear'); pg.fill('#chatIn', 'tell me a joke'); pg.click('#chatGo')
    seen = set()
    for i in range(30): seen.add(pg.evaluate('Gibson.state.expression')); pg.wait_for_timeout(100)
    print('typed joke -> expressions seen:', sorted(seen)); print('status:', pg.inner_text('#status').replace('\n', ' | '))
    pg.click('#sClose')
    # 2) neural voice
    for i in range(180):
        st = pg.evaluate('GibsonApp.state()')
        if st['neural'] in ('ready', 'error'): break
        pg.wait_for_timeout(1000)
    print('neural:', st['neural'], st['neuralMsg'])
    pg.wait_for_function('!document.body.dataset.busy', timeout=60000)
    r = pg.evaluate('''async () => { const lv = []; let t = setInterval(() => lv.push(GibsonApp.AudioOut.lvl), 50);
        const t0 = performance.now(); let first = 0;
        await GibsonApp.speakOut('Hello Lenny. I am Gibson, and I am ready for anything.', () => { first = performance.now() - t0; Gibson.setExpression('happy'); });
        clearInterval(t); return { firstAudioMs: Math.round(first), totalMs: Math.round(performance.now() - t0), mouthMax: Math.max(...lv).toFixed(2), mouthFramesOpen: lv.filter(x => x > .15).length, samples: lv.length, rtf: GibsonApp.Neural.rtf }; }''')
    print('neural speak:', r)
    r = pg.evaluate('''async () => { GibsonApp.AudioOut.setRobot(true); const t0 = performance.now(); await GibsonApp.speakOut('Robot warm mode.', null); GibsonApp.AudioOut.setRobot(false); return Math.round(performance.now() - t0); }''')
    print('robot-warm speak ms:', r)
    # 3) neural failure -> clean fallback to phone voice
    r = pg.evaluate('''async () => { const N = GibsonApp.Neural, g = N.gen; N.gen = () => Promise.reject(new Error('simulated failure'));
        const t0 = performance.now(); await GibsonApp.speakOut('Fallback test.', null); N.gen = g; return Math.round(performance.now() - t0); }''')
    print('fallback speak ms:', r, '| status:', pg.inner_text('#status').split('\n')[-1])
    # 4) wake word end-to-end via fake mic
    if MIC:
        pg.evaluate("() => { const S = JSON.parse(localStorage.getItem('gibson.app.v1')); }")
        pg.click('#gear'); pg.check('#wake'); pg.click('#sClose')
        woke = None
        for i in range(40):
            st = pg.evaluate('GibsonApp.state()')
            if st['busy'] == 'listening' or any('wake word' in l for l in logs): woke = st; break
            pg.wait_for_timeout(500)
        pg.evaluate("GibsonApp.Wake.worker && GibsonApp.Wake.worker.postMessage({type:'stats'})"); pg.wait_for_timeout(300)
        print('wake:', 'TRIGGERED' if woke else 'not triggered', woke or pg.evaluate('GibsonApp.state()'), '| stats:', pg.evaluate('GibsonApp.Wake.stats'))
        print('logs:', [l for l in logs if 'wake' in l][:3])
        pg.evaluate('GibsonApp.stopSpeech()'); pg.click('#gear'); pg.uncheck('#wake'); pg.click('#sClose'); pg.wait_for_timeout(500)
    # screenshots
    pg.evaluate("() => { Gibson.setExpression('happy', 0); }"); pg.wait_for_timeout(900)
    pg.screenshot(path='/workspace/gibson-app/screenshots/app.png')
    pg.click('#gear'); pg.wait_for_timeout(300)
    pg.evaluate("document.querySelector('#vEngine').closest('.grid').scrollIntoView({block:'start'})"); pg.wait_for_timeout(300)
    pg.screenshot(path='/workspace/gibson-app/screenshots/settings.png')
    print('sw:', pg.evaluate('navigator.serviceWorker.controller ? "controlling" : "registered"'), '| head default off:', not pg.evaluate('document.getElementById("head").checked'))
    b.close()
print('ERRORS:', json.dumps(errs, indent=1))
