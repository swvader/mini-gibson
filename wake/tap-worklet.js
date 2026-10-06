// AudioWorklet: mic -> 16 kHz mono chunks of 1280 samples (80 ms), posted to the wake worker port.
class Tap extends AudioWorkletProcessor {
  constructor() {
    super(); this.ratio = sampleRate / 16000; this.pos = 0; this.buf = new Float32Array(1280); this.n = 0; this.port2 = null; this.on = true;
    this.port.onmessage = e => { if (e.data.port) this.port2 = e.data.port; if ('on' in e.data) this.on = e.data.on; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; if (!ch || !this.on) return true;
    // linear-interpolation resampler (input is already low-passed by the browser's mic path; good enough for 16 kHz speech features)
    while (this.pos < ch.length - 1) {
      const i = Math.floor(this.pos), f = this.pos - i;
      this.buf[this.n++] = (ch[i] * (1 - f) + ch[i + 1] * f) * 32767;
      if (this.n === 1280) { const out = this.buf; this.buf = new Float32Array(1280); this.n = 0; (this.port2 || this.port).postMessage(out, [out.buffer]); }
      this.pos += this.ratio;
    }
    this.pos -= ch.length - 1;   // carry fractional position into the next block (keeps 1-sample overlap simple)
    return true;
  }
}
registerProcessor('gibson-tap', Tap);
