# Voice speed + time-to-first-audio benchmark (headless Chrome).
# usage: perf.py URL ENGINE [--cap N] [--throttle 4] [--device wasm|webgpu|auto] [--brain demo|gemini-mock]
#  --cap N      : put Chrome in a cgroup limited to N CPUs total (CDP throttling can't slow Web Workers, where the voices run)
#  --throttle 4 : CDP CPU throttling of the page main thread (UI / audio scheduling)
import sys, json, time, argparse, subprocess, os
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('url'); ap.add_argument('engine'); ap.add_argument('--cap', type=float, default=0)
ap.add_argument('--throttle', type=float, default=1); ap.add_argument('--device', default='wasm'); ap.add_argument('--brain', default='demo')
ap.add_argument('--voice', default=''); ap.add_argument('--turns', type=int, default=3)
a = ap.parse_args()
FAKE = r'''
window.__m = { final: 0, audio: 0, how: '' };
class FakeSR { constructor() { this.continuous = false; this.interimResults = false; }
  start() { const q = (window.__q || []).shift(); this._t = [setTimeout(() => this.onstart && this.onstart(), 30)];
    if (q) this._t.push(setTimeout(() => { this.onspeechstart && this.onspeechstart(); window.__m.final = performance.now(); window.__m.audio = 0;
      this.onresult && this.onresult({ resultIndex: 0, results: [{ 0: { transcript: q }, isFinal: true, length: 1 }] }); if (!this.continuous) this._end(); }, 400));
    else this._t.push(setTimeout(() => { this.onerror && this.onerror({ error: 'no-speech' }); this._end(); }, 1500)); }
  _end() { if (this._ended) return; this._ended = true; this._t.forEach(clearTimeout); setTimeout(() => this.onend && this.onend(), 20); }
  stop() { this._end(); } abort() { this._end(); } }
window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
const _sp = speechSynthesis.speak.bind(speechSynthesis);
speechSynthesis.speak = u => { if (window.__m.final && !window.__m.audio && u.text.trim()) { window.__m.audio = performance.now(); window.__m.how = 'phone'; } return _sp(u); };
window.__hookAudio = () => { const A = GibsonApp.AudioOut, p = A.play.bind(A);
  A.play = (au, sr, tag) => { if (window.__m.final) { if (tag === 'filler') { if (!window.__m.filler) window.__m.filler = performance.now(); }
    else if (!window.__m.audio) { window.__m.audio = performance.now(); window.__m.how = GibsonApp.pickEngine(); } } return p(au, sr, tag); }; };
'''
# simulated Gemini (no real key or network): same server latency model for both APIs.
# non-streaming: whole answer after 1.6 s.  streaming: first sentence after 0.7 s, the rest 0.45 s apart.
REPLY = ['[happy] Why did the robot go on vacation? ', 'It needed to recharge its batteries. ', 'Get it? Recharge!']
GEMREQ = []
def gem(route):
    u = route.request.url; GEMREQ.append((u.split('/models/')[1].split('?')[0], json.loads(route.request.post_data or '{}').get('generationConfig'), 'tools' in json.loads(route.request.post_data or '{}')))
    if 'streamGenerateContent' in u:
        time.sleep(0.7); body = ''
        for i, t in enumerate(REPLY): body += 'data: ' + json.dumps({'candidates': [{'content': {'parts': [{'text': t}], 'role': 'model'}}]}) + '\r\n\r\n'
        route.fulfill(status=200, headers={'content-type': 'text/event-stream', 'access-control-allow-origin': '*'}, body=body)   # (Playwright can't trickle; see note)
    else:
        time.sleep(1.6); route.fulfill(status=200, headers={'content-type': 'application/json', 'access-control-allow-origin': '*'},
            body=json.dumps({'candidates': [{'content': {'parts': [{'text': ''.join(REPLY)}], 'role': 'model'}}]}))
out = {'engine': a.engine, 'cap': a.cap, 'throttle': a.throttle, 'device': a.device}
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-webgpu'])
    if a.cap:
        cg = f'/sys/fs/cgroup/gibsonperf'; subprocess.run(['sudo', 'mkdir', '-p', cg]); subprocess.run(['sudo', 'sh', '-c', f'echo "{int(a.cap*100000)} 100000" > {cg}/cpu.max'])
        pids = subprocess.run("ps -eo pid,args | grep '[c]hrome' | grep -i headless | awk '{print $1}'", shell=True, capture_output=True, text=True).stdout.split()
        for pid in pids: subprocess.run(['sudo', 'sh', '-c', f'echo {pid} > {cg}/cgroup.procs'], stderr=subprocess.DEVNULL)
    ctx = b.new_context(); ctx.grant_permissions(['microphone']); ctx.add_init_script(FAKE)
    if a.brain == 'gemini-mock': ctx.route('https://generativelanguage.googleapis.com/**', gem)
    pg = ctx.new_page(); errs = []; logs = []
    pg.on('console', lambda m: (logs.append(m.text) if '[gibson]' in m.text else None, errs.append(m.text) if m.type == 'error' else None))
    pg.on('pageerror', lambda e: errs.append(str(e)))
    if a.throttle > 1: pg.context.new_cdp_session(pg).send('Emulation.setCPUThrottlingRate', {'rate': a.throttle})
    pg.goto(a.url, wait_until='networkidle'); pg.wait_for_timeout(1500)
    st = {'vEngine': a.engine, 'vEngineV': 2, 'convo': False, 'wake': False, 'nDevice': a.device}
    if a.voice: st['nVoice' if a.engine in ('neural', 'auto') else 'pVoice'] = a.voice
    if a.brain == 'gemini-mock': st.update({'primary': 'gemini', 'keys': {'gemini': 'SIMULATED-NOT-A-KEY'}})
    pg.evaluate(f"localStorage.setItem('gibson.app.v1', JSON.stringify({json.dumps(st)}))"); pg.reload(wait_until='networkidle'); pg.wait_for_timeout(1000)
    out['crossOriginIsolated'] = pg.evaluate('crossOriginIsolated'); out['sw'] = pg.evaluate('!!navigator.serviceWorker.controller')
    t0 = time.time(); pg.click('#start'); pg.evaluate('window.__hookAudio()')
    has_piper = pg.evaluate('!!GibsonApp.Piper')
    if a.engine != 'browser':
        cond = "GibsonApp.Neural.state=='ready'||GibsonApp.Neural.state=='error'" if a.engine == 'neural' else ("GibsonApp.Piper.state=='ready'||GibsonApp.Piper.state=='error'" if a.engine == 'piper' else "(GibsonApp.Piper.state=='ready'||GibsonApp.Piper.state=='error') && ['ready','error','skipped'].includes(GibsonApp.Neural.state)")
        try: pg.wait_for_function(cond, timeout=300000)
        except Exception as e: out['loadTimeout'] = True
        out['loadSec'] = round(time.time() - t0, 1)
        pg.wait_for_timeout(9000)          # let the built-in speed check finish
    S = pg.evaluate('GibsonApp.state()'); out['state'] = {k: S.get(k) for k in ('neural', 'neuralMsg', 'rtf', 'kokoroBackend', 'piper', 'piperMsg', 'piperRtf', 'engine', 'coi')}
    # direct RTF: render a standard sentence 3x with each loaded engine
    for name, obj in (('kokoro', 'Neural'), ('piper', 'Piper')):
        if not pg.evaluate(f"!!GibsonApp.{obj} && GibsonApp.{obj}.state=='ready'"): continue
        r = pg.evaluate("""async (o) => { const E = GibsonApp[o], v = o == 'Neural' ? (GibsonApp.nvoice ? GibsonApp.nvoice() : GibsonApp.NEURAL_VOICES[0]) : GibsonApp.pvoice(); const res = [];
            for (let i = 0; i < 3; i++) { const t = performance.now(); const m = await E.gen('I would tell you a joke about UDP, but you might not get it.', v, 1); res.push((performance.now() - t) / 1000 / (m.audio.length / m.sr)); } return res; }""", obj)
        out['rtf_' + name] = [round(x, 2) for x in r]
    # time to first audio: fake speech-recognition result -> first sound
    pg.wait_for_function('!GibsonApp.state().busy', timeout=60000)
    ttfa = []
    for q in ['tell me a joke', 'what is your name', 'how are you today'][:a.turns]:
        pg.evaluate(f"window.__q = [{json.dumps(q)}]; window.__m = {{final: 0, audio: 0, how: ''}}"); pg.click('#face')
        try: pg.wait_for_function('window.__m.audio > 0', timeout=60000)
        except Exception: ttfa.append(None); continue
        m = pg.evaluate('window.__m'); ttfa.append({'ms': round(m['audio'] - m['final']), 'how': m['how'], 'hmm_ms': round(m['filler'] - m['final']) if m.get('filler') else None})
        pg.wait_for_function('!GibsonApp.state().busy', timeout=90000); pg.wait_for_timeout(800)
    out['ttfa'] = ttfa
    import re as _re; out['brain_ms'] = [int(x.group(1)) for x in (_re.search(r'\((\d+) ms', l) for l in logs if ' via ' in l) if x][-a.turns:]
    out['errors'] = [e for e in errs if 'content-length' not in e and 'No available adapters' not in e][:5]
    out['gemini_requests'] = GEMREQ[:4]
    b.close()
print(json.dumps(out))
