# Listening robustness (Android-like recognizer behaviour, scripted): no cut-offs on short pauses, no beep loops.
import sys, json, time
from playwright.sync_api import sync_playwright
URL = sys.argv[1]
FAKE = r'''
window.__starts = []; window.__plans = [];
class FakeSR { constructor() { this.continuous = false; this.interimResults = false; }
  start() { window.__starts.push(performance.now()); const plan = window.__plans.shift() || [[1500, 'error', 'no-speech'], [1520, 'end']];
    this._t = [setTimeout(() => this.onstart && this.onstart(), 20)]; const res = [];
    for (const [ms, kind, txt] of plan) this._t.push(setTimeout(() => {
      if (kind === 'end') return this._end();
      if (kind === 'error') return this.onerror && this.onerror({ error: txt });
      if (kind === 'interim') { if (res.length && !res[res.length - 1].isFinal) res.pop(); res.push({ 0: { transcript: txt }, isFinal: false, length: 1 }); }
      if (kind === 'final') { if (res.length && !res[res.length - 1].isFinal) res.pop(); res.push({ 0: { transcript: txt }, isFinal: true, length: 1 }); }
      this.onresult && this.onresult({ resultIndex: res.length - 1, results: res.slice() });
    }, ms)); }
  _end() { if (this._ended) return; this._ended = true; this._t.forEach(clearTimeout); setTimeout(() => this.onend && this.onend(), 20); }
  stop() { this._end(); } abort() { this._end(); } }
window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
'''
def ok(c, m): print(('PASS ' if c else 'FAIL ') + m, flush=True)
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    ctx = b.new_context(); ctx.grant_permissions(['microphone']); ctx.add_init_script(FAKE); pg = ctx.new_page()
    logs, errs = [], []
    pg.on('console', lambda m: (logs.append(m.text) if '[gibson]' in m.text else None, errs.append(m.text) if m.type == 'error' else None))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(URL, wait_until='networkidle'); pg.wait_for_timeout(1200)
    pg.evaluate("localStorage.setItem('gibson.app.v1', JSON.stringify({vEngine: 'piper', vEngineV: 2, convo: true, convoTimeout: 25, wake: false}))"); pg.reload(wait_until='networkidle')
    pg.click('#start'); pg.wait_for_function("GibsonApp.Piper.state == 'ready' && !GibsonApp.state().busy", timeout=120000); pg.wait_for_timeout(2500)
    st = lambda: pg.evaluate('GibsonApp.state()')
    asked = lambda: [l.split('You: ')[1].split('\n')[0] for l in logs if 'You: ' in l]
    def wait(cond, ms):
        t = time.time()
        while time.time() - t < ms / 1000:
            if cond(): return True
            pg.wait_for_timeout(100)
        return False
    # 1) Android-style: phrase marked final at a short pause, then he keeps talking 1.0 s later
    pg.evaluate("""window.__plans = [[[300,'interim','what is'],[600,'interim','what is the'],[800,'final','what is the'],
        [1800,'interim','weather'],[2100,'final','weather like today']], [[200,'interim','stop listening'],[500,'final','stop listening']]]""")
    n0 = len(asked()); pg.click('#face')
    wait(lambda: len(asked()) > n0, 15000)
    ok(asked()[n0:n0 + 1] == ['what is the weather like today'], f'1 s pause mid-sentence is not cut off: heard {asked()[n0:n0 + 1]}')
    wait(lambda: not st()['convo'], 30000)
    # 2) recognizer ends by itself right in the middle of a sentence: one quiet restart, words kept
    pg.wait_for_timeout(1500)
    pg.evaluate("""window.__plans = [[[300,'interim','tell me'],[700,'interim','tell me a'],[900,'end']], [[400,'interim','joke about robots'],[700,'final','joke about robots']],
        [[200,'final','never mind']]]""")
    n0 = len(asked()); s0 = pg.evaluate('__starts.length'); pg.click('#face')
    wait(lambda: len(asked()) > n0, 15000)
    ok(asked()[n0:n0 + 1] == ['tell me a joke about robots'], f'session ended mid-sentence: restarted once and kept the words: {asked()[n0:n0 + 1]} (starts: {pg.evaluate("__starts.length") - s0})')
    wait(lambda: not st()['convo'], 30000)
    # 3) machine-gun guard: recognizer dies instantly every time (as when the mic is busy)
    pg.wait_for_timeout(1500)
    pg.evaluate("window.__plans = Array(30).fill([[50, 'end']])")
    s0 = pg.evaluate('__starts.length'); t0 = time.time(); pg.click('#face')
    wait(lambda: not st()['convo'] and not st()['busy'], 30000); pg.wait_for_timeout(4000)
    n = pg.evaluate('__starts.length') - s0
    ok(n <= 2, f'instant-fail recognizer: {n} starts in {time.time() - t0:.0f} s, then standby (no beep loop)')
    # 4) pure silence in conversation mode: at most one restart for the turn
    pg.evaluate("window.__plans = []"); pg.wait_for_timeout(1000)
    s0 = pg.evaluate('__starts.length'); pg.click('#face')
    wait(lambda: not st()['convo'] and not st()['busy'], 40000); pg.wait_for_timeout(3000)
    n = pg.evaluate('__starts.length') - s0
    ok(n <= 2 and not st()['convo'], f'silence: {n} recognizer starts for the turn, then the conversation ends with a chime')
    # 5) normal two-turn conversation still works, next turn starts only after his voice ends
    pg.evaluate("""window.__plans = [[[300,'final','what is your name']], [[300,'final','how are you']], [[300,'final','goodbye gibson']]]""")
    n0 = len(asked()); pg.click('#face')
    wait(lambda: len(asked()) >= n0 + 2, 60000)
    ok(asked()[n0:n0 + 2] == ['what is your name', 'how are you'], f'two turns without the wake word: {asked()[n0:n0 + 2]}')
    wait(lambda: not st()['convo'], 30000); ok(not st()['convo'], '"goodbye gibson" ends the conversation')
    total = pg.evaluate('__starts.length'); print('   total recognizer starts in this test:', total)
    b.close()
print('ERRORS:', [e for e in errs if 'content-length' not in e][:5])
