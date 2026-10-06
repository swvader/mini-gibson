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
- tools/neural_test.py, tools/wake_test.py, tools/convo_test.py, tools/perf.py

## Serving (GitHub Pages)
Live at https://swvader.github.io/mini-gibson/ from the repo swvader/mini-gibson, branch main. To deploy: bump VERSION in sw.js, commit, `git push`, then check that the live sw.js shows the new version (Pages takes about 30-60 s).
Pages can't send headers, so sw.js adds `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` to every same-origin response (the coi-serviceworker approach, merged into our one service worker). On the first visit the page reloads once when the worker takes over. After that `crossOriginIsolated` is true and the voices run multi-threaded WASM. Cross-origin CORS fetches (Hugging Face models, Gemini, Open-Meteo, the jsdelivr ORT runtime) keep working under `credentialless`.
For local tests, `python3 -m http.server` works too, because the service worker adds the headers.

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

## Voices and speed
- **Kokoro** (tts-worker.js): the Gibson blends. It runs on WebGPU when the phone has a real GPU (fp16 when supported, else fp32; q8 is selectable), otherwise on the CPU (WASM q8). Settings → Voice shows which backend is in use and the measured speed.
- **Piper** (piper-worker.js + piper-core.js + vendor/phonemizer.js + wake/ort.wasm.min.mjs): fast VITS voices on the CPU, with eSpeak-NG phonemes (the same as piper-phonemize).
  - Voices: Norman and John by Bryce Beattie (https://brycebeattie.com/files/tts/). Both are public domain and were trained only on public-domain LibriVox recordings; Norman was trained from scratch and John was fine-tuned from Kristin, which is also public domain. Models load from huggingface.co/rhasspy/piper-voices.
  - Avoided: voices that are fine-tuned from lessac, whose Blizzard 2013 dataset license is restrictive, and voices on NC datasets (ryan, hfc_*, l2arctic).
- **Auto** (default) uses Kokoro, the Gibson blends, on every device. The phone voice is only used while Kokoro is still loading, or for a single reply if Kokoro can't start it within 6 s. Piper is an optional extra (Lenny prefers Kokoro). Kokoro is pre-warmed at start with three silent renders (short, medium and long), which also compiles the GPU shaders before the first reply.
- **Face smoothness:** while any voice is being generated, the face is capped at 30 fps and refreshes its big bloom layer every other frame (tools/build.py hook `Gibson.setFpsCap`). CPU voice workers use at most cores-2 threads (max 4).
- **Streaming:** Gemini uses `streamGenerateContent` (SSE) and the OpenAI-style providers use `stream: true`. The voice starts on the first finished sentence while the rest is still arriving.
  - Thinking is set to minimal (`thinkingLevel: minimal`, `thinkingBudget: 0` on 2.5 Flash, `low` where minimal isn't allowed), and the setting that works is cached per model.
  - `google_search` is only sent when the question sounds live (news, scores, prices, hours, today, latest, ...). Weather still comes from Open-Meteo.
- **"Hmm." filler:** if no answer has arrived after 1.2 s, Gibson says a short "Hmm." in the current voice. It never holds the answer back more than 0.2 s.
- tools/perf.py URL ENGINE [--cap N] [--throttle 4] [--brain gemini-mock]: speed and time-to-first-audio benchmark.

## Conversation mode and voice speed
- After "Hey Gibson" or a tap, Gibson keeps listening after every reply with no wake word needed. A faint red glow at the screen edge means the mode is on. To end it, say "stop listening", "that's all", "never mind", "goodbye Gibson", "go to sleep" and so on, or just stay quiet for the timeout (Settings → Conversation mode, 10-60 s, default 25 s). You can interrupt him by tapping, or by saying "Hey Gibson" when the on-device wake word is on.
- Voice engine choice (Settings → Voice): **Auto** (default, see above), **Kokoro always**, **Piper always**, **Phone voice**.
- Each reply uses one engine from start to finish, and nothing is ever said twice. If the neural voice can't produce the first audio in time (6 s on Auto, 20 s when an engine is forced), the whole reply goes to the phone voice. With Kokoro forced on a slow phone, playback starts only once the rest will render without gaps of more than about 1 s.
