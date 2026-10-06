// Gibson neural voice worker: Kokoro-82M (Apache-2.0) via kokoro-js / transformers.js.
// Runs off the main thread so the face animation never stutters while audio is generated.
// Voices can be single Kokoro voicepacks or weighted BLENDS of them (original "Gibson" voices).
import { KokoroTTS, env } from './vendor/kokoro.web.js';
// CPU (WASM) threads: leave at least 2 cores for the face, audio and the browser ('onnx' getter added to the vendored bundle)
try { env.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)) : 1; } catch (e) {}
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const vurl = n => `https://huggingface.co/${MODEL}/resolve/main/voices/${n}.bin`;
let tts = null, loading = null;
const packs = new Map(), blends = new Map();

async function pack(name) {               // one 510x256 style table, cached in Cache Storage after first download
  if (packs.has(name)) return packs.get(name);
  const url = vurl(name); let c = null, buf = null;
  try { c = await caches.open('gibson-voices'); const hit = await c.match(url); if (hit) buf = await hit.arrayBuffer(); } catch (e) {}
  if (!buf) { const r = await fetch(url); if (!r.ok) throw new Error('voice ' + name + ' HTTP ' + r.status); buf = await r.arrayBuffer(); try { c && await c.put(url, new Response(buf.slice(0))); } catch (e) {} }
  const f = new Float32Array(buf); packs.set(name, f); return f;
}
async function styleFor(v) {               // v = {id, mix:{voiceName: weight}}
  if (blends.has(v.id)) return blends.get(v.id);
  const parts = Object.entries(v.mix), tot = parts.reduce((a, [, w]) => a + w, 0);
  let out = null;
  for (const [n, w] of parts) { const p = await pack(n); if (!out) out = new Float32Array(p.length); for (let i = 0; i < p.length; i++) out[i] += p[i] * (w / tot); }
  blends.set(v.id, out); return out;
}
let curStyle = null;
async function load({ device, dtype }) {
  const t0 = performance.now();
  tts = await KokoroTTS.from_pretrained(MODEL, { dtype, device, progress_callback: p => {
    if (p.status === 'progress' && p.total > 1e6) postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
  } });
  // use our own (possibly blended) style vector instead of a named voice
  tts._validate_voice = lang => lang;      // generate(text,{voice:'a'|'b'}) -> phonemizer language
  tts.generate_from_ids = async function (ids, { speed = 1 } = {}) {
    const T = ids.constructor, off = 256 * Math.min(Math.max(ids.dims.at(-1) - 2, 0), 509);
    const { waveform } = await this.model({ input_ids: ids, style: new T('float32', curStyle.slice(off, off + 256), [1, 256]), speed: new T('float32', [speed], [1]) });
    return { audio: waveform.data, sampling_rate: 24000 };
  };
  if (device === 'webgpu') {   // some mobile GPUs return silence/NaN: verify once, else the app falls back to CPU
    curStyle = await styleFor({ id: 'am_michael', mix: { am_michael: 1 } });
    const r = await tts.generate('Hello there.', { voice: 'a', speed: 1 }); let pk = 0, bad = 0;
    for (const x of r.audio) { if (!Number.isFinite(x)) bad++; else pk = Math.max(pk, Math.abs(x)); }
    if (bad || pk < .01) { tts = null; throw new Error('GPU produced invalid audio'); }
  }
  return { device, dtype, ms: Math.round(performance.now() - t0), threads: self.crossOriginIsolated ? (env.onnx && env.onnx.wasm.numThreads) || true : 0 };
}
// real reply chunks jump ahead of the start-up warm-up renders; queued warm-ups are dropped once a reply needs the voice
let minEpoch = 0, running = false;
const jobs = [];
async function pump() {
  if (running) return; running = true;
  while (jobs.length) {
    const m = jobs.shift();
    if ((m.epoch || 0) < minEpoch) { postMessage({ type: 'error', id: m.id, msg: 'cancelled' }); continue; }
    try {
      await loading; curStyle = await styleFor(m.voice);
      const t0 = performance.now();
      const r = await tts.generate(m.text, { voice: m.voice.lang || 'a', speed: m.speed || 1 });
      const audio = new Float32Array(r.audio);
      postMessage({ type: 'audio', id: m.id, audio, sr: r.sampling_rate, ms: Math.round(performance.now() - t0) }, [audio.buffer]);
    } catch (err) { postMessage({ type: 'error', id: m.id, msg: String(err && err.message || err) }); }
  }
  running = false;
}
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'load') {
    if (!loading) loading = load(m).catch(err => { loading = null; throw err; });
    loading.then(info => postMessage({ type: 'ready', ...info }), err => postMessage({ type: 'loaderror', msg: String(err && err.message || err) }));
  } else if (m.type === 'gen') {
    if (!m.bench) for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].bench >= 1) { postMessage({ type: 'error', id: jobs[i].id, msg: 'skipped warm-up' }); jobs.splice(i, 1); }
    jobs.push(m); pump();
  } else if (m.type === 'cancel') { minEpoch = m.epoch;
  } else if (m.type === 'prefetch') { styleFor(m.voice).catch(() => {}); }
};
