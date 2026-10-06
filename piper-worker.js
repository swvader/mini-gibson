// Piper (VITS) voice worker: fast neural TTS on the phone CPU. onnxruntime-web (WASM, multi-threaded when the page is
// cross-origin isolated) + eSpeak-NG phonemes. Voice models come from Hugging Face (rhasspy/piper-voices) and are cached.
import * as ort from './wake/ort.wasm.min.mjs';
import { textToIds } from './piper-core.js';
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
ort.env.wasm.wasmPaths = new URL('./wake/', import.meta.url).href;
// leave at least 2 cores free for the face, audio and the browser
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)) : 1;
const voices = new Map();   // id -> {s: InferenceSession, cfg}
async function getBuf(url, report) {
  let c = null;
  try { c = await caches.open('gibson-piper'); const hit = await c.match(url); if (hit) return await hit.arrayBuffer(); } catch (e) {}
  const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url.split('/').pop());
  const total = +r.headers.get('content-length') || 0, rd = r.body.getReader(), chunks = []; let got = 0, last = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); got += value.length;
    if (report && total > 1e6 && got - last > 2e6) { last = got; postMessage({ type: 'progress', loaded: got, total }); } }
  const buf = new Uint8Array(got); let o = 0; for (const ch of chunks) { buf.set(ch, o); o += ch.length; }
  try { c && await c.put(url, new Response(buf.slice(0))); } catch (e) {}
  return buf.buffer;
}
async function voice(v) {
  if (voices.has(v.id)) return voices.get(v.id);
  const p = (async () => {
    const cfg = JSON.parse(new TextDecoder().decode(await getBuf(HF + v.path + '.onnx.json')));
    const s = await ort.InferenceSession.create(new Uint8Array(await getBuf(HF + v.path + '.onnx', true)), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return { s, cfg };
  })();
  voices.set(v.id, p); p.catch(() => voices.delete(v.id)); return p;
}
async function synth(v, text, speed) {
  const { s, cfg } = await voice(v), ids = await textToIds(text, cfg), inf = cfg.inference || {};
  const feeds = { input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? .667, (inf.length_scale ?? 1) / (speed || 1), inf.noise_w ?? .8]), [3]) };
  if (s.inputNames.includes('sid')) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(v.sid || 0)]), [1]);
  const r = await s.run(feeds); const out = r[s.outputNames[0]];
  return { audio: new Float32Array(out.data), sr: cfg.audio.sample_rate };
}
let queue = Promise.resolve(), minEpoch = 0;
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'load') {
    const t0 = performance.now();
    voice(m.voice).then(() => synth(m.voice, 'Hi.', 1)).then(() => postMessage({ type: 'ready', ms: Math.round(performance.now() - t0), threads: ort.env.wasm.numThreads }),
      err => postMessage({ type: 'loaderror', msg: String(err && err.message || err) }));
  } else if (m.type === 'gen') {
    queue = queue.then(async () => {
      if ((m.epoch || 0) < minEpoch) return postMessage({ type: 'error', id: m.id, msg: 'cancelled' });
      try { const t0 = performance.now(), r = await synth(m.voice, m.text, m.speed);
        postMessage({ type: 'audio', id: m.id, audio: r.audio, sr: r.sr, ms: Math.round(performance.now() - t0) }, [r.audio.buffer]);
      } catch (err) { postMessage({ type: 'error', id: m.id, msg: String(err && err.message || err) }); }
    });
  } else if (m.type === 'cancel') minEpoch = m.epoch;
  else if (m.type === 'prefetch') voice(m.voice).catch(() => {});
};
