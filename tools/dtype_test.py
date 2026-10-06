import sys, json
from playwright.sync_api import sync_playwright
URL = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome', headless=True); pg = b.new_page(); pg.goto(URL, wait_until='networkidle')
    for dt in sys.argv[2:]:
        r = pg.evaluate('''async (dt) => { const w = new Worker('tts-worker.js', {type:'module'}); const t0 = performance.now();
          await new Promise((res, rej) => { w.onmessage = e => { if (e.data.type === 'ready') res(); if (e.data.type === 'loaderror') rej(e.data.msg); }; w.postMessage({type:'load', device:'wasm', dtype: dt}); });
          const load = performance.now() - t0; const out = [];
          for (let i = 0; i < 2; i++) { const t1 = performance.now();
            const m = await new Promise(res => { w.onmessage = e => { if (e.data.type === 'audio' || e.data.type === 'error') res(e.data); }; w.postMessage({type:'gen', id: 1, text: 'Hello Lenny. I am Gibson, and I am ready for anything.', voice: {id:'g', lang:'a', mix:{am_michael:.45, bm_fable:.35, am_puck:.2}}, speed: 1}); });
            out.push(m.audio ? +((performance.now() - t1) / 1000 / (m.audio.length / m.sr)).toFixed(2) : m.msg); }
          w.terminate(); return { dt, loadMs: Math.round(load), rtf: out, threads: navigator.hardwareConcurrency }; }''', dt)
        print(json.dumps(r), flush=True)
    b.close()
