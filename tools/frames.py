# Face smoothness while Gibson answers: main-thread frame times (rAF deltas) + the face's own fps, on a phone profile.
# usage: frames.py URL ENGINE(auto|neural|piper) [--throttle 4] [--cap N]
import sys, json, time, argparse, subprocess
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('url'); ap.add_argument('engine'); ap.add_argument('--throttle', type=float, default=4); ap.add_argument('--cap', type=float, default=0); ap.add_argument('--nocap', action='store_true'); ap.add_argument('--device', default='auto')
a = ap.parse_args()
UA = 'Mozilla/5.0 (Linux; Android 14; SM-F731U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36'
FAKE = open('tools/perf.py').read().split("FAKE = r'''")[1].split("'''")[0]
REC = r'''window.__ft = null; (function loop(t) { if (window.__ft) { if (window.__lt) window.__ft.push(t - window.__lt); window.__lt = t; } requestAnimationFrame(loop); })(0);
window.__fps = []; setInterval(() => { if (window.__ft && window.Gibson) window.__fps.push(Gibson.state.fps); }, 250);'''
def stats(d):
    d = sorted(d); n = len(d)
    if not n: return {}
    return {'frames': n, 'p50_ms': round(d[n // 2], 1), 'p95_ms': round(d[int(n * .95)], 1), 'max_ms': round(d[-1], 1), 'over50ms': sum(x > 50 for x in d), 'over100ms': sum(x > 100 for x in d)}
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True, args=['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    if a.cap:
        cg = '/sys/fs/cgroup/gibsonperf'; subprocess.run(['sudo', 'mkdir', '-p', cg]); subprocess.run(['sudo', 'sh', '-c', f'echo "{int(a.cap*100000)} 100000" > {cg}/cpu.max'])
        for pid in subprocess.run("ps -eo pid,args | grep '[c]hrome' | grep -i headless | awk '{print $1}'", shell=True, capture_output=True, text=True).stdout.split():
            subprocess.run(['sudo', 'sh', '-c', f'echo {pid} > {cg}/cgroup.procs'], stderr=subprocess.DEVNULL)
    ctx = b.new_context(user_agent=UA, viewport={'width': 915, 'height': 412}, is_mobile=True, has_touch=True, device_scale_factor=2.6)
    ctx.grant_permissions(['microphone']); ctx.add_init_script(FAKE); ctx.add_init_script(REC)
    if a.nocap: ctx.add_init_script("addEventListener('DOMContentLoaded', () => { if (window.Gibson) Gibson.setFpsCap = () => {}; })")
    pg = ctx.new_page()
    pg.goto(a.url, wait_until='networkidle'); pg.wait_for_timeout(1500)
    pg.evaluate(f"localStorage.setItem('gibson.app.v1', JSON.stringify({{vEngine: '{a.engine}', vEngineV: 2, convo: false, wake: false, nDevice: '{a.device}'}}))"); pg.reload(wait_until='networkidle')
    pg.tap('#start'); pg.evaluate('window.__hookAudio()')
    pg.wait_for_function("(GibsonApp.Piper.state=='ready' || GibsonApp.Neural.state=='ready') && !GibsonApp.state().busy", timeout=300000); pg.wait_for_timeout(8000)
    if a.throttle > 1: pg.context.new_cdp_session(pg).send('Emulation.setCPUThrottlingRate', {'rate': a.throttle})
    pg.wait_for_timeout(1500)
    pg.evaluate('window.__ft = []; window.__fps = []'); pg.wait_for_timeout(4000)
    idle = pg.evaluate('window.__ft'); idle_fps = pg.evaluate('window.__fps')
    pg.evaluate("window.__ft = []; window.__fps = []; window.__q = ['tell me a joke']; window.__m = {final: 0, audio: 0}")
    pg.tap('#face'); pg.wait_for_function('window.__m.audio > 0', timeout=90000)
    ttfa = pg.evaluate('window.__m.audio - window.__m.final')
    pg.wait_for_function('!GibsonApp.state().busy', timeout=120000)
    talk = pg.evaluate('window.__ft'); talk_fps = pg.evaluate('window.__fps'); S = pg.evaluate('GibsonApp.state()')
    out = {'engine': a.engine, 'used': S['engine'], 'kokoro': S.get('kokoroBackend'), 'piper': S.get('piperMsg'), 'throttle': a.throttle, 'cap': a.cap, 'fpsCap': not a.nocap,
           'idle': stats(idle), 'answering': stats(talk), 'face_fps_idle_min': min(idle_fps or [0]), 'face_fps_answering_min': min(talk_fps or [0]), 'ttfa_ms': round(ttfa)}
    print(json.dumps(out)); b.close()
