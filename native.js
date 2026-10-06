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
  let srCur = null, ttsW = null, snapId = 0; const snaps = new Map();
  window.__nativeEvt = (type, d) => {
    if (type === 'sr') { if (srCur) srCur._evt(d); }
    else if (type.startsWith('tts')) { if (ttsW) ttsW._evt(type, d); }
    else if (type === 'face') {
      if (!opt.faceTrack || !window.Gibson) return;
      if (d.none) Gibson.lookAt(null); else Gibson.lookAt(Math.max(-1, Math.min(1, d.x * 1.3)), Math.max(-1, Math.min(1, d.y * 1.1)));
    } else if (type === 'snap') { const f = snaps.get(d.id); if (f) { snaps.delete(d.id); f(d.b64 || null); } }
    else if (type === 'cam') { if (d.error) console.warn('[gibson] camera: ' + d.error); }
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
        this.jobs.push(m); this._pump();
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

  // camera snapshot (JPEG base64) for vision questions; null if the camera isn't available
  window.GibsonSnap = () => new Promise(res => { const id = ++snapId; snaps.set(id, res); N.snap(id); setTimeout(() => { if (snaps.has(id)) { snaps.delete(id); res(null); } }, 3000); });

  addEventListener('DOMContentLoaded', () => {
    for (const [id, k] of [['faceTrack', 'faceTrack'], ['quietMic', 'quietMic']]) {
      const el = document.getElementById(id); if (!el) continue; el.checked = !!opt[k];
      el.addEventListener('change', () => { opt[k] = el.checked; saveOpt(); if (k === 'faceTrack') { if (el.checked) N.camStart(); else { N.camStop(); window.Gibson && Gibson.lookAt(null); } } });
    }
    if (opt.faceTrack) N.camStart();
  });
})();
