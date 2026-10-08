// On-device "Hey Gibson" wake word: openWakeWord-style pipeline (Apache-2.0 code design).
//   16 kHz audio -> melspectrogram.onnx -> embedding_model.onnx (Google speech_embedding, Apache-2.0)
//   -> our own tiny classifier (hey_gibson.json, trained on the box from synthetic Kokoro voices + LibriSpeech).
// Nothing leaves the phone.
importScripts('ort.wasm.min.js');
ort.env.wasm.wasmPaths = new URL('./', self.location.href).href;
ort.env.wasm.numThreads = 1;
let mel = null, emb = null, clf = null, ready = false;
let raw = new Float32Array(0);            // pending samples
let tail = new Float32Array(480);         // 3 hops of context for the mel model
let melBuf = [], feat = [];               // mel frames (32) and embeddings (96)
let runMax = 0, threshold = 0.5, cooldownUntil = 0, frames = 0, paused = false, run = 0, need = 2, echo = false, block = false, testMode = false;
for (let i = 0; i < 76; i++) melBuf.push(new Float32Array(32).fill(1));

function dense(x, W, b, act) {            // W: [out][in]
  const y = new Float32Array(b.length);
  for (let o = 0; o < b.length; o++) { let s = b[o]; const w = W[o]; for (let i = 0; i < x.length; i++) s += w[i] * x[i]; y[o] = act ? Math.max(0, s) : s; }
  return y;
}
function classify(x) {                     // x: Float32Array(16*96)
  let h = x;
  if (clf.mean) { h = new Float32Array(x.length); for (let i = 0; i < x.length; i++) h[i] = (x[i] - clf.mean[i]) / clf.std[i]; }
  for (let l = 0; l < clf.layers.length; l++) h = dense(h, clf.layers[l].W, clf.layers[l].b, l < clf.layers.length - 1);
  return 1 / (1 + Math.exp(-h[0]));
}
async function init(m) {
  const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  let stage = 'fetch model files';
  try {   // 1.0.14: each load stage is reported, so a failure names the exact step
    const get = (f, kind) => fetch(m.base + f).then(r => { if (!r.ok) throw new Error(f + ' HTTP ' + r.status); return kind === 'json' ? r.json() : r.arrayBuffer(); });
    const [melB, embB, c] = await Promise.all([get('melspectrogram.onnx'), get('embedding_model.onnx'), get(m.model, 'json')]);
    postMessage({ type: 'stage', s: 'files ok (mel ' + melB.byteLength + ' B, emb ' + embB.byteLength + ' B, threads ' + ort.env.wasm.numThreads + ', isolated ' + !!self.crossOriginIsolated + ')' });
    stage = 'ORT wasm init + mel session'; mel = await ort.InferenceSession.create(new Uint8Array(melB), opt);
    postMessage({ type: 'stage', s: 'mel session ok' });
    stage = 'embedding session'; emb = await ort.InferenceSession.create(new Uint8Array(embB), opt);
    clf = c;
  } catch (err) { throw new Error(stage + ': ' + (err && err.message || err)); }
  need = Math.max(clf.need || 2, 4); ready = true;   // 1.0.9: score must stay high for 4+ frames in a row (~0.3 s)
  postMessage({ type: 'ready', name: clf.name || 'hey gibson', version: clf.version });   // 1.0.14 FIX: this was accidentally inside the comment above since 1.0.9, so the page never heard "ready" and timed out
}
async function step(chunk) {               // chunk: 1280 samples (int16 scale)
  const x = new Float32Array(1760); x.set(tail, 0); x.set(chunk, 480); tail = chunk.slice(800);
  const mo = await mel.run({ input: new ort.Tensor('float32', x, [1, 1760]) });
  const md = mo[mel.outputNames[0]].data;  // [1,1,8,32]
  for (let f = 0; f < md.length / 32; f++) { const fr = new Float32Array(32); for (let j = 0; j < 32; j++) fr[j] = md[f * 32 + j] / 10 + 2; melBuf.push(fr); }
  while (melBuf.length > 76) melBuf.shift();
  const win = new Float32Array(76 * 32); melBuf.forEach((fr, i) => win.set(fr, i * 32));
  const eo = await emb.run({ input_1: new ort.Tensor('float32', win, [1, 76, 32, 1]) });
  feat.push(Float32Array.from(eo[emb.outputNames[0]].data)); while (feat.length > 16) feat.shift();
  frames++;
  if (frames % 12 === 0) postMessage({ type: 'alive', frames });
  if (feat.length < 16 || frames < 14) return;   // warm-up (~1.1 s) so start-up noise never triggers
  const v = new Float32Array(16 * 96); feat.forEach((e, i) => v.set(e, i * 96));
  const s = classify(v);
  if (s > 0.15) postMessage({ type: 'score', s });
  const now = performance.now();
  // while Gibson's own voice plays: much stricter (score and length), and muted when the line contains his name
  const th = echo ? Math.max(0.97, threshold) : threshold, nd = echo ? need + 3 : need;
  if (s >= th && !block) { run++; runMax = Math.max(runMax, s); } else { run = 0; runMax = 0; }   // sustained: consecutive frames only
  if (run >= nd && now > cooldownUntil) { cooldownUntil = now + 4000; postMessage({ type: 'wake', s: runMax, frames: run }); run = 0; runMax = 0; }
}
let busy = Promise.resolve(), pending = 0, stepMs = 0;
function onAudio(chunk) {
  if (!ready || paused) return;
  if (pending > 25) { postMessage({ type: 'slow', ms: stepMs }); return; }   // >2 s behind: drop audio rather than lag forever
  pending++;
  busy = busy.then(async () => { const t0 = performance.now(); await step(chunk); stepMs = stepMs * .9 + (performance.now() - t0) * .1; })
    .catch(e => postMessage({ type: 'error', msg: String(e.message || e) })).finally(() => { pending--; });
}
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') init(m).catch(err => postMessage({ type: 'error', fatal: true, msg: String(err.message || err) }));
  else if (m.type === 'port') m.port.onmessage = ev => { if (!testMode) onAudio(ev.data); };
  else if (m.type === 'echo') { echo = m.on; block = m.block; if (!echo) run = 0; }
  else if (m.type === 'testmode') testMode = m.on;
  else if (m.type === 'audio') onAudio(m.data);                      // test hook: feed samples directly
  else if (m.type === 'threshold') threshold = m.v;
  else if (m.type === 'cool') cooldownUntil = performance.now() + m.ms;
  else if (m.type === 'stats') postMessage({ type: 'stats', stepMs, pending, threshold, need });
  else if (m.type === 'pause') { paused = !!m.on; if (!paused) { frames = 0; feat = []; run = 0; cooldownUntil = 0; melBuf = []; for (let i = 0; i < 76; i++) melBuf.push(new Float32Array(32).fill(1)); } }
};
