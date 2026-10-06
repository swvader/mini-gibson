// Android app bridge (only active inside the Mini Gibson APK, where window.GibsonNative exists).
// Gives the web app: quiet native speech recognition (as a SpeechRecognition look-alike), the native Kokoro voice
// (as a tts-worker look-alike), face tracking (Gibson's eyes follow your face) and camera snapshots for "what do you see?".
(function () {
  const N = window.GibsonNative; if (!N) return;
  window.GIBSON_NATIVE = true;
  document.documentElement.classList.add('native');
  const opt = (() => { try { return Object.assign({ faceTrack: true, quietMic: true }, JSON.parse(localStorage.getItem('gibson.native') || '{}')); } catch (e) { return { faceTrack: true, quietMic: true }; } })();
  const saveOpt = () => localStorage.setItem('gibson.native', JSON.stringify(opt));
  const H = { sr: new Set() };
  let srCur = null, ttsW = null, snapId = 0, camErr = '', camOffT = 0; const snaps = new Map();
  window.__nativeEvt = (type, d) => {
    if (type === 'sr') { if (srCur) srCur._evt(d); }
    else if (type.startsWith('tts')) { if (ttsW) ttsW._evt(type, d); }
    else if (type === 'face') {
      if (!opt.faceTrack || !window.Gibson) return;
      if (d.none) Gibson.lookAt(null); else Gibson.lookAt(Math.max(-1, Math.min(1, d.x * 1.3)), Math.max(-1, Math.min(1, d.y * 1.1)));
    } else if (type === 'snap') { const f = snaps.get(d.id); if (f) { snaps.delete(d.id); f(d.b64 || null); } }
    else if (type === 'http') { const f = https.get(d.id); if (f) f(d); }
    else if (type === 'say') window.__nativeSayDone(d);
    else if (type === 'cam') { if (d.error) { console.warn('[gibson] camera: ' + d.error); camErr = d.error; } }
    else if (type === 'perm') { if (opt.faceTrack) N.camStart(); }
  };
  window.__nativeBack = () => { const s = document.getElementById('settings'); if (s && !s.hidden) document.getElementById('sClose').click(); else N.exit(); };

  // SpeechRecognition look-alike backed by Android's recognizer (start/stop beeps muted when "quiet" is on)
  class NativeSR {
    constructor() { this.lang = 'en-US'; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this._on = false; }
    start() { if (srCur && srCur !== this) srCur._kill(); srCur = this; this._on = true; N.srStart(this.lang || 'en-US', !!this.continuous, !!opt.quietMic); }
    stop() { if (srCur === this && this._on) N.srStop(); }
    abort() { if (srCur === this) { this._on = false; srCur = null; N.srAbort(); } }
    _kill() { this._on = false; }
    _evt(d) {
      if (d.type === 'start') { this.onstart && this.onstart(); this.onaudiostart && this.onaudiostart(); }
      else if (d.type === 'speechstart') this.onspeechstart && this.onspeechstart();
      else if (d.type === 'result') {
        const results = d.results.map(r => { const a = [{ transcript: r.t, confidence: 0.9 }]; a.isFinal = r.f; a.item = i => a[i]; return a; });
        results.item = i => results[i];
        let ri = results.findIndex(r => !r.isFinal); if (ri < 0) ri = results.length - 1;
        this.onresult && this.onresult({ results, resultIndex: Math.max(0, ri) });
      } else if (d.type === 'error') this.onerror && this.onerror({ error: d.error });
      else if (d.type === 'end') { this._on = false; if (srCur === this) srCur = null; this.onend && this.onend(); }
    }
  }
  window.SpeechRecognition = window.webkitSpeechRecognition = NativeSR;

  // tts-worker look-alike: same messages as tts-worker.js; reply chunks jump ahead of queued warm-ups
  class NativeTts {
    constructor() { ttsW = this; this.jobs = []; this.busy = null; this.minEpoch = 0; }
    postMessage(m) {
      if (m.type === 'load') { this.t0 = performance.now(); N.ttsInit(); }
      else if (m.type === 'gen') {
        if (!m.bench) for (let i = this.jobs.length - 1; i >= 0; i--) if (this.jobs[i].bench >= 1) { this._post({ type: 'error', id: this.jobs[i].id, msg: 'skipped warm-up' }); this.jobs.splice(i, 1); }
        if (m.bench) this.jobs.push(m); else { const i = this.jobs.findIndex(j => j.bench); i < 0 ? this.jobs.push(m) : this.jobs.splice(i, 0, m); }
        this._pump();
      } else if (m.type === 'cancel') { this.minEpoch = m.epoch; }
    }
    terminate() {}
    _post(d) { setTimeout(() => this.onmessage && this.onmessage({ data: d }), 0); }
    _pump() {
      if (this.busy) return;
      const m = this.jobs.shift(); if (!m) return;
      if ((m.epoch || 0) < this.minEpoch) { this._post({ type: 'error', id: m.id, msg: 'cancelled' }); return this._pump(); }
      const V = (window.GibsonApp && GibsonApp.NEURAL_VOICES) || []; const sid = Math.max(0, V.findIndex(v => v.id === (m.voice && m.voice.id)));
      this.busy = m; N.tts(m.id, String(m.text), sid, +m.speed || 1);
    }
    async _evt(type, d) {
      if (type === 'tts-ready') this._post({ type: 'ready', device: 'native', dtype: 'int8', threads: d.threads, ms: d.ms });
      else if (type === 'tts-error') this._post({ type: 'loaderror', msg: d.msg });
      else if (type === 'tts-done') {
        const m = this.busy; this.busy = null;
        try {
          if (d.error) throw new Error(d.error);
          if ((m.epoch || 0) < this.minEpoch) throw new Error('cancelled');
          const buf = await (await fetch(d.url)).arrayBuffer(); const pcm = new Int16Array(buf, 44, (buf.byteLength - 44) >> 1);
          const audio = new Float32Array(pcm.length); for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768;
          this._post({ type: 'audio', id: d.id, audio, sr: d.sr, ms: d.ms });
        } catch (e) { this._post({ type: 'error', id: d.id, msg: String(e.message || e) }); }
        this._pump();
      }
    }
  }
  window.GibsonNativeTts = NativeTts;

  // brain requests through the app's own networking (streams like fetch; sends the GitHub Pages site as referrer)
  const https = new Map(); let httpId = 0;
  window.GibsonNativeFetch = (url, opts) => new Promise((resolve, reject) => {
    opts = opts || {}; const id = ++httpId; let ctl = null, done = false;
    const stream = new ReadableStream({ start(c) { ctl = c; } });
    const fail = e => { if (done) return; done = true; https.delete(id); try { ctl.error(e); } catch (x) {} reject(e); };
    https.set(id, d => {
      if (d.error) return fail(new TypeError('network: ' + d.error));
      if (d.status) resolve(new Response(stream, { status: d.status, headers: { 'content-type': d.ctype || 'application/json' } }));
      if (d.chunk) ctl.enqueue(new TextEncoder().encode(d.chunk));
      if (d.done) { done = true; https.delete(id); try { ctl.close(); } catch (x) {} }
    });
    if (opts.signal) opts.signal.addEventListener('abort', () => { N.httpAbort(id); fail(new DOMException('aborted', 'AbortError')); });
    N.http(id, url, opts.method || 'GET', JSON.stringify(opts.headers || {}), opts.body || '');
  });

  const says = new Map(); let sayId = 0;
  function wavToFloat(buf) {
    const v = new DataView(buf); let sr = 22050, off = 12, data = null;
    while (off + 8 <= buf.byteLength) { const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3)), n = v.getUint32(off + 4, true);
      if (id === 'fmt ') sr = v.getUint32(off + 12, true); if (id === 'data') { data = [off + 8, Math.min(n, buf.byteLength - off - 8)]; break; } off += 8 + n + (n & 1); }
    if (!data) return null; const pcm = new Int16Array(buf.slice(data[0], data[0] + (data[1] & ~1)));
    const a = new Float32Array(pcm.length); for (let i = 0; i < pcm.length; i++) a[i] = pcm[i] / 32768; return { a, sr };
  }
  async function phoneSay(text, o) {
    const id = ++sayId; text = String(text || '').trim(); if (!text) return;
    const d = await new Promise(res => { says.set(id, res); N.say(id, text, (o && o.rate) || 1, (o && o.pitch) || 1); setTimeout(() => { if (says.has(id)) { says.delete(id); res({ error: 'timeout' }); } }, 15000); });
    if (d.error || id !== sayId) return;
    const w = wavToFloat(await (await fetch(d.url)).arrayBuffer()); if (!w || id !== sayId) return;
    return window.GibsonApp.AudioOut.play(w.a, w.sr);
  }
  window.__nativeSayDone = d => { const f = says.get(d.id); if (f) { says.delete(d.id); f(d); } };
  const hookSpeak = () => { if (!window.Gibson || Gibson.__nat) return; const sp0 = Gibson.speak.bind(Gibson), st0 = Gibson.stop.bind(Gibson);
    Gibson.speak = (t, o) => (o && o.silent) ? sp0(t, o) : phoneSay(t, o); Gibson.stop = () => { sayId++; return st0(); }; Gibson.__nat = true; };

  // camera snapshot (JPEG base64) for vision questions; null if the camera isn't available
  // (the app keeps a fresh photo while the camera runs; if the camera was off it starts and waits for the first frame)
  window.GibsonSnap = () => new Promise(res => {
    const id = ++snapId; snaps.set(id, res); N.snap(id);
    setTimeout(() => { if (snaps.has(id)) { snaps.delete(id); console.warn('[gibson] camera photo timed out'); res(null); } }, 5000);
    if (!opt.faceTrack) { clearTimeout(camOffT); camOffT = setTimeout(() => { if (!opt.faceTrack) N.camStop(); }, 30000); }
  });
  // tiny debug line in Settings: camera + wake word state
  setInterval(() => {
    const el = document.getElementById('natDiag'); if (!el || !window.GibsonApp) return;
    let c = {}; try { c = JSON.parse(N.camInfo()); } catch (e) {}
    const W = GibsonApp.Wake;
    el.textContent = `Camera: ${c.on ? 'on' : 'off'}, frames ${c.frames || 0}, last photo ${c.photoAge >= 0 ? (c.photoAge / 1000).toFixed(1) + ' s ago' : 'none'}${c.err || camErr ? ' · error: ' + (c.err || camErr) : ''}\nWake word: armed ${W.armed() ? 'yes' : 'no'} · peak score ${(W.peak || 0).toFixed(2)} · audio frames ${W.frames || 0}`;
  }, 1000);

  addEventListener('DOMContentLoaded', () => {
    hookSpeak();
    const ve = document.getElementById('vEngine');   // app: Gibson voice always; the phone voice only as a hand-picked last resort
    if (ve) ve.innerHTML = '<option value="neural">Gibson voice always (wait for it)</option><option value="browser">Phone voice (last resort: robotic, not recommended)</option>';
    if (ve) try { ve.value = window.GibsonApp && GibsonApp.settings().vEngine === 'browser' ? 'browser' : 'neural'; } catch (e) {}
    for (const [id, k] of [['faceTrack', 'faceTrack'], ['quietMic', 'quietMic']]) {
      const el = document.getElementById(id); if (!el) continue; el.checked = !!opt[k];
      el.addEventListener('change', () => { opt[k] = el.checked; saveOpt(); if (k === 'faceTrack') { if (el.checked) N.camStart(); else { N.camStop(); window.Gibson && Gibson.lookAt(null); } } });
    }
    if (opt.faceTrack) N.camStart();
  });
})();
