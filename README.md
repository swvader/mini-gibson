# Mini Gibson phone app (PWA)

Static app built on the face engine from ../gibson-face/index.html. `tools/build.py` copies the engine into face.js and face.css; the original file is never edited.

## Files
- index.html, app.js: the app (brains, settings, conversation flow, voice in/out, wake word, head stub)
- tts-worker.js + vendor/kokoro.web.js: the neural voice. Kokoro-82M (Apache-2.0) via kokoro-js 1.2.1 runs in a Web Worker. The first time, the model (q8, about 92 MB) downloads from Hugging Face and is then cached by the browser.
  - "Gibson" voices are weighted blends of Kokoro voicepacks (style-vector mixing), defined in NEURAL_VOICES in app.js.
- wake/: the on-device "Hey Gibson" detector
  - tap-worklet.js: mic → 16 kHz chunks of 80 ms
  - wake-worker.js: onnxruntime-web runs melspectrogram.onnx and embedding_model.onnx (the openWakeWord front-end; the embedding model is Google speech_embedding, Apache-2.0), then hey_gibson.json, our own small classifier.
- voice-samples/: MP3 demos (see "Voices" below)
- sw.js: bump VERSION on every change. It only deletes its own old gibson-vN caches.
- tools/smoke.py URL [fake_mic.wav]: headless test, including the wake word end to end through Chrome's fake mic
- tools/neural_test.py, tools/wake_test.py

## Serving
`/workspace/gibson-run/serve.py` adds `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. These enable multi-threaded WASM, which makes the neural voice much faster. If you move the app to GitHub Pages (which can't set headers), the voice still works but runs single-threaded and slower.

To restart:
  cd /workspace/gibson-run && nohup python3 serve.py 8765 /workspace/gibson-app > http.log 2>&1 &
  nohup /workspace/gibson-run/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8765 > /workspace/gibson-run/tunnel.log 2>&1 &   # new URL each time

## Wake word model (trained on the box, no accounts)
Everything is in /workspace/gibson-lab:
- gen_piper.py: 3000 "hey gibson" clips from Piper libritts_r (904 synthetic speakers), plus 1500 sound-alike phrases ("hey jason", "hey gibbs", ...) and 3000 generic sentences
- build_ds.py, build_extra.py: augmentation (reverb, EQ, noise, background speech, level)
- libri.py, libri100.py: negatives from about 37 h of LibriSpeech (CC BY 4.0)
- train2.py: numpy MLP with hard-negative mining → hey_gibson.json
- stream_eval.py: reference implementation of the browser streaming pipeline

Training data is synthetic or CC BY, so the classifier is ours.

## Keys
Keys live only in the phone's localStorage (key gibson.app.v1). None are in the code.
Head movement (ESP32) is off by default; see the `Head` object in app.js.

## Conversation mode and voice speed
- After "Hey Gibson" or a tap, Gibson keeps listening after every reply with no wake word needed. A faint red glow at the screen edge means the mode is on. To end it, say "stop listening", "that's all", "never mind", "goodbye Gibson", "go to sleep" and so on, or just stay quiet for the timeout (Settings → Conversation mode, 10-60 s, default 25 s). You can interrupt him by tapping, or by saying "Hey Gibson" when the on-device wake word is on.
- Voice engine choice (Settings → Voice): **Auto** (the default) times the neural voice on this phone and uses it only if it renders at least as fast as real time; otherwise it uses the phone voice. **Neural always** keeps the Kokoro voice even when it's slow. **Phone voice (fast)** always replies instantly.
- Each reply uses one engine from start to finish. Neural audio starts only once the rest of the reply will render without gaps of more than about 1 s. If no neural audio is ready in time (8 s on Auto, 20 s on Neural always), the whole reply goes to the phone voice. Nothing is ever said twice.
