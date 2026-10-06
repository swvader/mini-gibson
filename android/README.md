# Mini Gibson Android app (native shell)
WebView running the same web app (copied into `app/src/main/assets/web`) plus native helpers in `MainActivity.java`:
Kokoro voice via sherpa-onnx 1.13.8 (kokoro-int8-multi-lang-v1_0, Gibson blends baked into speakers 0-14 of voices.bin, same order as NEURAL_VOICES),
quiet Android SpeechRecognizer (beeps muted), CameraX + ML Kit face tracking, camera snapshots for vision questions. Bridge: `native.js`.
Build: put `sherpa-onnx-1.13.8.aar` in `app/libs`, the model files in `app/src/main/assets/kokoro`, web files in `assets/web`, a `keystore.properties` (not in git), then `gradle assembleRelease`.
