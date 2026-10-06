# Headless conversation-mode test. Speech recognition is replaced by a scripted fake (headless Chrome has no speech service);
# the wake word runs the REAL on-device detector, fed with held-out "Hey Gibson" audio through the worker test hook.
import sys, json, time
from playwright.sync_api import sync_playwright
URL = sys.argv[1]
FAKE_SR = r'''
window.__sr = { queue: [], log: [] };
class FakeSR { constructor() { this.continuous = false; this.interimResults = false; }
  start() { const q = window.__sr.queue.shift(); window.__sr.log.push('start:' + (q === undefined ? 'silence' : q)); this._t = [];
    this._t.push(setTimeout(() => this.onstart && this.onstart(), 30));
    if (q) { this._t.push(setTimeout(() => { this.onspeechstart && this.onspeechstart();
        const res = [{ 0: { transcript: q }, isFinal: true, length: 1 }]; this.onresult && this.onresult({ resultIndex: 0, results: res }); if (!this.continuous) this._end(); }, 500)); }
    else this._t.push(setTimeout(() => { this.onerror && this.onerror({ error: 'no-speech' }); this._end(); }, 1500)); }
  _end() { if (this._ended) return; this._ended = true; this._t.forEach(clearTimeout); setTimeout(() => this.onend && this.onend(), 20); }
  stop() { this._end(); } abort() { this._end(); } }
window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
window.__bl = []; const __t0 = window.__t0 = Date.now(); setInterval(() => { const b = document.body && document.body.dataset.busy || '-'; if (window.__bl[window.__bl.length-1]?.[1] !== b) window.__bl.push([((Date.now()-__t0)/1000).toFixed(1), b]); }, 20);
window.__phoneSpeak = 0; const _sp = speechSynthesis.speak.bind(speechSynthesis); speechSynthesis.speak = u => { if (u.text.trim()) window.__phoneSpeak++; return _sp(u); };
'''
errs, logs = [], []
def ok(c, msg): print(('PASS ' if c else 'FAIL ') + msg, flush=True)
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    ctx = b.new_context(viewport={'width': 915, 'height': 412}, is_mobile=True, has_touch=True); ctx.grant_permissions(['microphone'])
    ctx.add_init_script(FAKE_SR)
    pg = ctx.new_page()
    pg.on('console', lambda m: (errs.append(m.type + ': ' + m.text) if m.type in ('error', 'warning') and 'content-length' not in m.text and 'No available adapters' not in m.text else None, logs.append(m.text) if '[gibson]' in m.text else None))
    pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
    pg.goto(URL, wait_until='networkidle')
    pg.evaluate("localStorage.setItem('gibson.app.v1', JSON.stringify({wake: true, convo: true, convoTimeout: 10, vEngine: (window.__ENG || 'auto'), vEngineV: 2}))"); pg.reload(wait_until='networkidle')
    pg.click('#start')
    st = lambda: pg.evaluate('GibsonApp.state()')
    def wait(cond, ms=60000, step=100):
        t0 = time.time()
        while time.time() - t0 < ms / 1000:
            s = st()
            if cond(s): return s
            pg.wait_for_timeout(step)
        return st()
    s = wait(lambda s: (s.get('piper') == 'ready' or s['neural'] == 'ready') and not s['busy'] and s['wakeReady'], 120000); pg.wait_for_timeout(4000)
    print('ready:', s)
    pg.evaluate("GibsonApp.Wake.worker.postMessage({type:'testmode', on:true})")
    FEED = '''async (name) => { const buf = new Int16Array(await (await fetch('tools/testclips/' + name + '.raw')).arrayBuffer());
      const pk = buf.reduce((a, x) => Math.max(a, Math.abs(x)), 1); const x = new Float32Array(16000 + buf.length + 12000);
      for (let i = 0; i < buf.length; i++) x[16000 + i] = buf[i] * 12000 / pk;
      for (let i = 0; i + 1280 <= x.length; i += 1280) { GibsonApp.Wake.worker.postMessage({ type: 'audio', data: x.slice(i, i + 1280) }); await new Promise(r => setTimeout(r, 80)); } }'''
    pg.wait_for_timeout(2000)
    # 1) wake -> first turn
    pg.evaluate("window.__sr.queue.push('tell me a joke', 'what is your name', 'stop listening')")
    t0 = time.time(); pg.evaluate(FEED, 'pos_am_michael')
    s = wait(lambda s: s['busy'] == 'speaking', 20000); ok(s['busy'] == 'speaking' and s['convo'], f'wake -> heard "tell me a joke" -> speaking, conversation mode on ({time.time() - t0:.1f}s)')
    # 2) auto-listen after reply, second turn without wake word
    s = wait(lambda s: s['busy'] == 'listening', 40000, 30); t1 = time.time(); ok(s['busy'] == 'listening' and s['convo'], 'reply finished -> listening immediately (no wake word)')
    s = wait(lambda s: s['busy'] == 'speaking', 20000); ok(s['busy'] == 'speaking', 'second turn "what is your name" answered')
    s = wait(lambda s: s['busy'] == 'listening', 40000, 30); ok(s['busy'] == 'listening', 'listening again for turn 3')
    # 3) exit phrase -> sign-off -> standby
    s = wait(lambda s: not s['convo'] and s['busy'] is None, 30000)
    expr = pg.evaluate('Gibson.state.expression'); ok(not s['convo'] and s['busy'] is None and s['wake'], f'"stop listening" -> sign-off -> standby (expression {expr}, wake detector on: {s["wake"]})')
    print('   status:', pg.inner_text('#status'))
    # 4) barge-in by wake word while speaking
    pg.wait_for_timeout(1800)
    pg.evaluate("window.__sr.queue.push('tell me a joke', 'stop listening')"); pg.evaluate(FEED, 'pos_af_heart')
    s = wait(lambda s: s['busy'] == 'speaking', 20000)
    pg.wait_for_timeout(2200)    # let the detector warm up while he talks
    speaking_before = st()['busy'] == 'speaking'
    pg.evaluate("window.__sr.queue.unshift(null)")   # the barge-in listen hears nothing at first
    mark = pg.evaluate('(Date.now() - window.__t0) / 1000')
    pg.evaluate(FEED, 'pos_am_michael')
    wait(lambda s: s['busy'] != 'speaking', 8000, 50)
    seq = [b for t, b in json.loads(pg.evaluate('JSON.stringify(window.__bl)')) if float(t) >= mark - 0.05]
    s = {'busy': 'listening' if 'listening' in seq[:3] else seq}
    ok(speaking_before and s['busy'] == 'listening', 'barge-in: "Hey Gibson" while he was speaking -> speech stopped, listening'); print('   state:', speaking_before, s, pg.evaluate('JSON.stringify(window.__bl.slice(-12))'), pg.evaluate('window.__sr.log.slice(-4)'))
    print('   logs:', [l for l in logs if 'barge' in l][-1:])
    s = wait(lambda s: not s['convo'], 30000)
    # 5) barge-in by tap while speaking
    pg.wait_for_timeout(500)
    pg.evaluate("window.__sr.queue.push('tell me a joke', 'never mind')"); pg.click('#face')
    s = wait(lambda s: s['busy'] == 'speaking', 20000); pg.wait_for_timeout(600)
    pg.click('#face'); s2 = st(); ok(s['busy'] == 'speaking' and s2['busy'] == 'listening' and not pg.evaluate('!!GibsonApp.AudioOut.src'), 'barge-in: tap while speaking -> audio stopped, listening')
    s = wait(lambda s: not s['convo'], 30000); ok(not s['convo'], '"never mind" -> standby')
    # 6) echo protection: his own line containing "Gibson" must not wake him
    pg.wait_for_timeout(1800); print('   before echo test:', st())
    wait(lambda s: s['busy'] is None and not s['convo'], 30000); pg.wait_for_timeout(2500)
    pg.evaluate("GibsonApp.Wake.echo(true, 'I am Gibson')"); pg.evaluate(FEED, 'pos_am_michael'); pg.wait_for_timeout(600)
    s = st(); ok(s['busy'] is None, 'echo protection: wake audio during his own "...Gibson..." line ignored'); print('   after:', s, logs[-3:]); pg.evaluate("GibsonApp.Wake.echo(false)")
    # 7) silence timeout
    pg.wait_for_timeout(2200)
    pg.evaluate("window.__sr.queue.push('tell me a joke')"); pg.click('#face')
    s = wait(lambda s: s['busy'] == 'listening' and pg.evaluate('window.__sr.log.length') > 0 and s['convo'], 40000)
    s = wait(lambda s: s['busy'] == 'speaking', 20000); s = wait(lambda s: s['busy'] == 'listening', 40000, 30)
    t2 = time.time(); s = wait(lambda s: not s['convo'], 20000)
    ok(not s['convo'] and s['busy'] is None, f'silence: conversation ended by itself after {time.time() - t2:.1f}s (timeout set to 10s)')
    print('   SR sessions:', pg.evaluate('window.__sr.log'))
    fb = len([l for l in logs if 'phone voice for this WHOLE reply' in l]); print('   neural timing:', [l[9:] for l in logs if 'neural:' in l])
    ok(pg.evaluate('window.__phoneSpeak') <= 1 + fb, f"no reply spoken twice / no engine switching (phone-voice utterances: {pg.evaluate('window.__phoneSpeak')}, only the start greeting may use it)")
    b.close()
print('ERRORS:', json.dumps(errs, indent=1))
