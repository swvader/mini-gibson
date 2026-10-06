package net.swvader.gibson;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.ComponentActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Mini Gibson native shell: the face + brain are the same web app (bundled in assets/web), plus native helpers:
//  - Kokoro voice via sherpa-onnx (int8, CPU) with the Gibson blends baked into voices.bin
//  - quiet speech recognition (Android SpeechRecognizer, start/stop beeps muted)
//  - face tracking (CameraX + ML Kit) and camera snapshots for "what do you see?" questions
public class MainActivity extends ComponentActivity {
  static final String HOST = "appassets.androidplatform.net";
  WebView web;
  final Handler main = new Handler(Looper.getMainLooper());
  final ExecutorService ttsExec = Executors.newSingleThreadExecutor();
  final ExecutorService camExec = Executors.newSingleThreadExecutor();
  OfflineTts tts; int ttsThreads;
  SpeechRecognizer sr; boolean srStarted, srWanted, srContinuous, srQuiet = true, srHadResult; String srLang = "en-US"; int srRestarts;
  final List<String> srFinals = new ArrayList<>();
  AudioManager am; boolean muted;
  TextToSpeech phone; boolean phoneReady; final List<Runnable> phonePending = new ArrayList<>();
  ProcessCameraProvider camProvider; ImageAnalysis analysis; FaceDetector faceDet; volatile boolean faceBusy, faceOn; volatile int snapWanted = 0; long lastFaceSent, lastFaceSeen;
  volatile String lastJpeg; volatile long lastJpegAt; volatile int camFrames; volatile String camErr = ""; int srRetry;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    am = (AudioManager) getSystemService(AUDIO_SERVICE);
    setVolumeControlStream(AudioManager.STREAM_MUSIC);
    web = new WebView(this);
    setContentView(web);
    immersive();
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false); s.setAllowFileAccess(false);
    final File ttsDir = new File(getCacheDir(), "tts"); ttsDir.mkdirs();
    final WebViewAssetLoader loader = new WebViewAssetLoader.Builder().setDomain(HOST)
        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
        .addPathHandler("/tts/", path -> {
          try { File f = new File(ttsDir, new File(path).getName()); return new WebResourceResponse("audio/wav", null, new FileInputStream(f)); }
          catch (Exception e) { return null; }
        }).build();
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return loader.shouldInterceptRequest(r.getUrl()); }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(PermissionRequest r) { main.post(() -> r.grant(r.getResources())); }
    });
    web.addJavascriptInterface(new Bridge(), "GibsonNative");
    List<String> need = new ArrayList<>();
    for (String p : new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA})
      if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) need.add(p);
    if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), 1);
    web.loadUrl("https://" + HOST + "/assets/web/index.html");
  }
  void immersive() {
    web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
  }
  @Override public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) immersive(); }
  @Override public void onRequestPermissionsResult(int c, String[] p, int[] g) { super.onRequestPermissionsResult(c, p, g); emit("perm", new JSONObject()); }
  @Override protected void onPause() { super.onPause(); srWanted = false; if (sr != null) sr.cancel(); unmute(); }
  @Override protected void onDestroy() { super.onDestroy(); if (phone != null) phone.shutdown(); if (sr != null) sr.destroy(); unmute(); if (tts != null) tts.release(); }
  @Override public void onBackPressed() { web.evaluateJavascript("window.__nativeBack && window.__nativeBack()", null); }

  void emit(String type, JSONObject o) {
    final String js = "window.__nativeEvt && window.__nativeEvt(" + JSONObject.quote(type) + "," + o.toString() + ")";
    main.post(() -> web.evaluateJavascript(js, null));
  }
  static JSONObject J(Object... kv) { JSONObject o = new JSONObject(); try { for (int i = 0; i < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]); } catch (Exception e) {} return o; }

  // ------------------------------------------------------------------ Kokoro (sherpa-onnx)
  void copyAssetDir(AssetManager a, String path, File dst) throws Exception {
    String[] list = a.list(path);
    if (list == null || list.length == 0) {
      dst.getParentFile().mkdirs();
      try (InputStream in = a.open(path); OutputStream out = new FileOutputStream(dst)) { byte[] buf = new byte[65536]; int n; while ((n = in.read(buf)) > 0) out.write(buf, 0, n); }
      return;
    }
    dst.mkdirs(); for (String f : list) copyAssetDir(a, path + "/" + f, new File(dst, f));
  }
  void ttsLoad() {
    if (tts != null) { emit("tts-ready", J("ms", 0, "threads", ttsThreads, "sr", tts.sampleRate(), "speakers", tts.numSpeakers())); return; }
    long t0 = System.currentTimeMillis();
    try {
      File data = new File(getFilesDir(), "espeak-ng-data"), mark = new File(getFilesDir(), "espeak.v1");
      if (!mark.exists()) { copyAssetDir(getAssets(), "kokoro/espeak-ng-data", data); mark.createNewFile(); }
      OfflineTtsKokoroModelConfig k = new OfflineTtsKokoroModelConfig();
      k.setModel("kokoro/model.int8.onnx"); k.setVoices("kokoro/voices.bin"); k.setTokens("kokoro/tokens.txt");
      k.setDataDir(data.getAbsolutePath()); k.setLexicon("kokoro/lexicon-us-en.txt"); k.setLang("en-us");
      OfflineTtsModelConfig m = new OfflineTtsModelConfig(); m.setKokoro(k);
      ttsThreads = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() - 2));
      m.setNumThreads(ttsThreads); m.setDebug(false); m.setProvider("cpu");
      OfflineTtsConfig c = new OfflineTtsConfig(); c.setModel(m);
      tts = new OfflineTts(getAssets(), c);
      emit("tts-ready", J("ms", System.currentTimeMillis() - t0, "threads", ttsThreads, "sr", tts.sampleRate(), "speakers", tts.numSpeakers()));
    } catch (Throwable e) { emit("tts-error", J("msg", String.valueOf(e))); }
  }
  void ttsGen(int id, String text, int sid, float speed) {
    try {
      long t0 = System.currentTimeMillis();
      GeneratedAudio g = tts.generate(text, sid, speed);
      float[] a = g.getSamples(); int rate = g.getSampleRate();
      File f = new File(new File(getCacheDir(), "tts"), "t" + (id % 50) + ".wav");
      writeWav(f, a, rate);
      emit("tts-done", J("id", id, "url", "https://" + HOST + "/tts/" + f.getName() + "?" + id, "ms", System.currentTimeMillis() - t0, "sr", rate, "n", a.length));
    } catch (Throwable e) { emit("tts-done", J("id", id, "error", String.valueOf(e))); }
  }
  static void writeWav(File f, float[] a, int rate) throws Exception {
    ByteBuffer bb = ByteBuffer.allocate(44 + a.length * 2).order(ByteOrder.LITTLE_ENDIAN);
    bb.put("RIFF".getBytes()).putInt(36 + a.length * 2).put("WAVE".getBytes()).put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1)
      .putInt(rate).putInt(rate * 2).putShort((short) 2).putShort((short) 16).put("data".getBytes()).putInt(a.length * 2);
    for (float x : a) bb.putShort((short) Math.max(-32767, Math.min(32767, Math.round(x * 32767))));
    try (FileOutputStream o = new FileOutputStream(f)) { o.write(bb.array()); }
  }

  // ------------------------------------------------------------------ phone voice (last resort): Android TextToSpeech rendered to a WAV
  void phoneSay(int id, String text, float rate, float pitch) {
    Runnable job = () -> {
      File f = new File(new File(getCacheDir(), "tts"), "p" + (id % 20) + ".wav");
      phone.setSpeechRate(rate); phone.setPitch(pitch);
      Bundle b = new Bundle();
      int r = phone.synthesizeToFile(text, b, f, "s" + id);
      if (r != TextToSpeech.SUCCESS) emit("say", J("id", id, "error", "synth failed"));
    };
    if (phone == null) {
      phonePending.add(job);
      phone = new TextToSpeech(this, st -> {
        phoneReady = st == TextToSpeech.SUCCESS;
        if (phoneReady) { try { phone.setLanguage(java.util.Locale.US); } catch (Exception e) {} for (Runnable j : phonePending) j.run(); }
        else for (int i = 0; i < phonePending.size(); i++) emit("say", J("id", id, "error", "no phone voice"));
        phonePending.clear();
      });
      phone.setOnUtteranceProgressListener(new UtteranceProgressListener() {
        public void onStart(String u) {}
        public void onDone(String u) { int i = Integer.parseInt(u.substring(1)); emit("say", J("id", i, "url", "https://" + HOST + "/tts/p" + (i % 20) + ".wav?" + i)); }
        public void onError(String u) { emit("say", J("id", Integer.parseInt(u.substring(1)), "error", "phone voice error")); }
      });
    } else if (!phoneReady) phonePending.add(job); else job.run();
  }

  // ------------------------------------------------------------------ quiet speech recognition
  static final int[] BEEP_STREAMS = { AudioManager.STREAM_MUSIC, AudioManager.STREAM_NOTIFICATION, AudioManager.STREAM_SYSTEM };
  final Runnable unmuteR = this::unmute;
  void mute() {
    main.removeCallbacks(unmuteR);
    if (!srQuiet || muted) return; muted = true;
    for (int s : BEEP_STREAMS) try { am.adjustStreamVolume(s, AudioManager.ADJUST_MUTE, 0); } catch (Exception e) {}
  }
  void unmute() {
    if (!muted) return; muted = false;
    for (int s : BEEP_STREAMS) try { am.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, 0); } catch (Exception e) {}
  }
  void srBegin() {
    if (sr == null) { sr = SpeechRecognizer.createSpeechRecognizer(this); sr.setRecognitionListener(listener); }
    Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
    i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
    i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, srLang);
    i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
    i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
    i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
    i.putExtra("android.speech.extra.SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS", 2500);
    i.putExtra("android.speech.extra.SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS", 2000);
    mute();
    sr.startListening(i);
  }
  void srEnded(String error) {   // the platform session is over: restart quietly in continuous mode, else tell JS
    if (srWanted && srContinuous && srRestarts < 40 && (error == null || "no-speech".equals(error) || (srHadResult && "aborted".equals(error)))) {
      srRestarts++; main.postDelayed(() -> { if (srWanted) srBegin(); }, 60); return;
    }
    boolean was = srWanted; srWanted = false;
    main.postDelayed(unmuteR, 400);
    if (error != null && !(srHadResult && "no-speech".equals(error))) emit("sr", J("type", "error", "error", error));
    if (was || error != null) emit("sr", J("type", "end"));
  }
  JSONArray srList(String interim) {
    JSONArray a = new JSONArray();
    for (String f : srFinals) a.put(J("t", f, "f", true));
    if (interim != null && !interim.isEmpty()) a.put(J("t", interim, "f", false));
    return a;
  }
  final RecognitionListener listener = new RecognitionListener() {
    public void onReadyForSpeech(Bundle p) { srRetry = 0; if (!srStarted) { srStarted = true; emit("sr", J("type", "start")); } }
    public void onBeginningOfSpeech() { emit("sr", J("type", "speechstart")); }
    public void onRmsChanged(float v) {}
    public void onBufferReceived(byte[] b) {}
    public void onEndOfSpeech() {}
    public void onError(int e) {
      String m;
      switch (e) {
        case SpeechRecognizer.ERROR_NO_MATCH: case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: m = "no-speech"; break;
        case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: m = "not-allowed"; break;
        case SpeechRecognizer.ERROR_NETWORK: case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: case SpeechRecognizer.ERROR_SERVER: m = "network"; break;
        case SpeechRecognizer.ERROR_AUDIO: m = "audio-capture"; break;
        default: m = "aborted";
      }
      if (!srWanted) { main.postDelayed(unmuteR, 400); return; }
      // transient: the mic hasn't been released yet (wake detector / last session) or the service is busy. Retry quietly.
      boolean transientErr = e == SpeechRecognizer.ERROR_AUDIO || e == SpeechRecognizer.ERROR_CLIENT || e == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || e == 10 || e == 11;
      if (transientErr && srRetry < 5) {
        srRetry++;
        if (e != SpeechRecognizer.ERROR_AUDIO && sr != null) { try { sr.destroy(); } catch (Exception x) {} sr = null; }
        main.postDelayed(() -> { if (srWanted) srBegin(); }, 250L + 200L * srRetry); return;
      }
      srEnded(m);
    }
    public void onResults(Bundle r) {
      ArrayList<String> l = r.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
      String t = l != null && !l.isEmpty() ? l.get(0) : "";
      if (!t.trim().isEmpty()) { srFinals.add(t); srHadResult = true; emit("sr", J("type", "result", "results", srList(null))); }
      if (!srWanted) { main.postDelayed(unmuteR, 400); return; }
      srEnded(null);
    }
    public void onPartialResults(Bundle r) {
      ArrayList<String> l = r.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
      String t = l != null && !l.isEmpty() ? l.get(0) : "";
      if (!t.trim().isEmpty() && srWanted) emit("sr", J("type", "result", "results", srList(t)));
    }
    public void onEvent(int t, Bundle p) {}
  };

  // ------------------------------------------------------------------ camera: face tracking + snapshots
  void camStart() {
    if (camProvider != null) return;
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) { camErr = "camera permission not granted"; emit("cam", J("error", camErr)); if (snapWanted > 0) { emit("snap", J("id", snapWanted, "error", camErr)); snapWanted = 0; } return; }
    if (faceDet == null) faceDet = FaceDetection.getClient(new FaceDetectorOptions.Builder().setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST).setMinFaceSize(0.12f).build());
    ListenableFuture<ProcessCameraProvider> f = ProcessCameraProvider.getInstance(this);
    f.addListener(() -> {
      try {
        camProvider = f.get();
        ImageAnalysis an = analysis = new ImageAnalysis.Builder().setTargetResolution(new android.util.Size(640, 480))
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888).build();
        an.setTargetRotation(getWindowManager().getDefaultDisplay().getRotation());
        an.setAnalyzer(camExec, this::analyze);
        CameraSelector sel = camProvider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) ? CameraSelector.DEFAULT_FRONT_CAMERA : CameraSelector.DEFAULT_BACK_CAMERA;
        camProvider.unbindAll(); camProvider.bindToLifecycle(this, sel, an);
        camErr = ""; emit("cam", J("on", true));
      } catch (Exception e) { camProvider = null; camErr = String.valueOf(e); emit("cam", J("error", camErr)); }
    }, ContextCompat.getMainExecutor(this));
  }
  void camStop() { if (camProvider != null) { camProvider.unbindAll(); camProvider = null; } lastJpeg = null; emit("cam", J("on", false)); }
  @Override public void onConfigurationChanged(android.content.res.Configuration c) {   // keep photos upright when the phone turns
    super.onConfigurationChanged(c);
    if (analysis != null) try { analysis.setTargetRotation(getWindowManager().getDefaultDisplay().getRotation()); } catch (Exception e) {}
  }
  void analyze(ImageProxy img) {
    try {
      camFrames++;
      final int rot = img.getImageInfo().getRotationDegrees();
      long now = System.currentTimeMillis();
      boolean wantJpeg = snapWanted > 0 || now - lastJpegAt > 300;
      boolean wantFace = faceOn && !faceBusy && now - lastFaceSent >= 90;
      if (!wantJpeg && !wantFace) return;
      Bitmap bm = img.toBitmap();
      if (wantJpeg) {
        Matrix mx = new Matrix(); mx.postRotate(rot);
        float sc = 640f / Math.max(bm.getWidth(), bm.getHeight()); if (sc < 1) mx.postScale(sc, sc);
        Bitmap out = Bitmap.createBitmap(bm, 0, 0, bm.getWidth(), bm.getHeight(), mx, true);
        ByteArrayOutputStream bo = new ByteArrayOutputStream(); out.compress(Bitmap.CompressFormat.JPEG, 70, bo);
        lastJpeg = Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP); lastJpegAt = now;
        int id = snapWanted; if (id > 0) { snapWanted = 0; emit("snap", J("id", id, "b64", lastJpeg, "w", out.getWidth(), "h", out.getHeight())); }
      }
      if (wantFace) {
        faceBusy = true;
        final int w = (rot % 180 == 0) ? bm.getWidth() : bm.getHeight(), h = (rot % 180 == 0) ? bm.getHeight() : bm.getWidth();
        faceDet.process(InputImage.fromBitmap(bm, rot)).addOnSuccessListener(faces -> {
          long t = System.currentTimeMillis(); lastFaceSent = t;
          Face best = null; for (Face fc : faces) if (best == null || fc.getBoundingBox().width() > best.getBoundingBox().width()) best = fc;
          if (best != null) {
            Rect r = best.getBoundingBox(); lastFaceSeen = t;
            double x = -((r.centerX() / (double) w) * 2 - 1), y = (r.centerY() / (double) h) * 2 - 1;   // front camera: his left is our right
            emit("face", J("x", Math.round(x * 100) / 100.0, "y", Math.round(y * 100) / 100.0, "s", Math.round(100.0 * r.width() / w) / 100.0));
          } else if (t - lastFaceSeen > 1200 && lastFaceSeen != 0) { lastFaceSeen = 0; emit("face", J("none", true)); }
        }).addOnCompleteListener(x -> faceBusy = false);
      }
    } catch (Throwable e) {
      camErr = String.valueOf(e); faceBusy = false;
      int id = snapWanted; if (id > 0) { snapWanted = 0; emit("snap", J("id", id, "error", camErr)); }
    } finally { img.close(); }
  }

  // ------------------------------------------------------------------ brain HTTP (streamed back to JS)
  final ExecutorService httpExec = Executors.newCachedThreadPool();
  final java.util.concurrent.ConcurrentHashMap<Integer, java.net.HttpURLConnection> conns = new java.util.concurrent.ConcurrentHashMap<>();
  String certSha1;
  String certSha1() {
    if (certSha1 != null) return certSha1;
    try {
      android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
      byte[] d = java.security.MessageDigest.getInstance("SHA-1").digest(pi.signingInfo.getApkContentsSigners()[0].toByteArray());
      StringBuilder b = new StringBuilder(); for (byte x : d) b.append(String.format("%02X", x)); certSha1 = b.toString();
    } catch (Throwable e) { certSha1 = ""; }
    return certSha1;
  }
  void http(int id, String url, String method, String headers, String body) {
    httpExec.execute(() -> {
      java.net.HttpURLConnection c = null;
      try {
        c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection(); conns.put(id, c);
        c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setRequestMethod(method);
        JSONObject h = new JSONObject(headers); java.util.Iterator<String> it = h.keys();
        while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, h.getString(k)); }
        // same identity as the web version (keys restricted to the GitHub Pages site keep working) + Android app identity
        c.setRequestProperty("Referer", "https://swvader.github.io/mini-gibson/");
        c.setRequestProperty("X-Android-Package", getPackageName()); c.setRequestProperty("X-Android-Cert", certSha1());
        if (body != null && !body.isEmpty()) { c.setDoOutput(true); try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes("UTF-8")); } }
        int st = c.getResponseCode();
        emit("http", J("id", id, "status", st, "ctype", String.valueOf(c.getContentType())));
        InputStream in = st >= 400 ? c.getErrorStream() : c.getInputStream();
        if (in != null) {
          java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(in, "UTF-8"));
          String line; StringBuilder sb = new StringBuilder();
          while ((line = r.readLine()) != null) {
            sb.append(line).append('\n');
            if (line.isEmpty() || sb.length() > 8192) { emit("http", J("id", id, "chunk", sb.toString())); sb.setLength(0); }   // one SSE event at a time
          }
          if (sb.length() > 0) emit("http", J("id", id, "chunk", sb.toString()));
        }
        emit("http", J("id", id, "done", true));
      } catch (Throwable e) { emit("http", J("id", id, "error", String.valueOf(e))); }
      finally { conns.remove(id); if (c != null) c.disconnect(); }
    });
  }

  // ------------------------------------------------------------------ JS bridge
  class Bridge {
    @JavascriptInterface public String info() { return J("app", "1.0.2", "cores", Runtime.getRuntime().availableProcessors(), "model", "kokoro-int8-multi-lang-v1_0").toString(); }
    @JavascriptInterface public void ttsInit() { ttsExec.execute(MainActivity.this::ttsLoad); }
    @JavascriptInterface public void tts(int id, String text, int sid, float speed) { ttsExec.execute(() -> { if (tts == null) ttsLoad(); ttsGen(id, text, sid, speed); }); }
    @JavascriptInterface public void srStart(String lang, boolean continuous, boolean quiet) {
      main.post(() -> { srLang = lang == null || lang.isEmpty() ? "en-US" : lang; srContinuous = continuous; srQuiet = quiet; srWanted = true; srHadResult = false; srStarted = false; srRestarts = 0; srFinals.clear();
        srRetry = 0; if (sr != null) sr.cancel(); srBegin(); });
    }
    @JavascriptInterface public void srStop() { main.post(() -> { boolean was = srWanted; srWanted = false; if (sr != null) sr.cancel(); main.postDelayed(unmuteR, 400); if (was) emit("sr", J("type", "end")); }); }
    @JavascriptInterface public void srAbort() { main.post(() -> { srWanted = false; if (sr != null) sr.cancel(); main.postDelayed(unmuteR, 400); }); }
    @JavascriptInterface public void camStart() { main.post(() -> { faceOn = true; MainActivity.this.camStart(); }); }
    @JavascriptInterface public void camStop() { main.post(() -> { faceOn = false; MainActivity.this.camStop(); }); }
    @JavascriptInterface public void snap(int id) {
      main.post(() -> {
        String j = lastJpeg;
        if (camProvider != null && j != null && System.currentTimeMillis() - lastJpegAt < 1500) { emit("snap", J("id", id, "b64", j)); return; }   // fresh photo: instant
        snapWanted = id; if (camProvider == null) MainActivity.this.camStart();   // camera off: start it, the first frame answers
      });
    }
    @JavascriptInterface public String camInfo() { return J("on", camProvider != null, "frames", camFrames, "photoAge", lastJpeg == null ? -1 : System.currentTimeMillis() - lastJpegAt, "face", faceOn, "err", camErr).toString(); }
    @JavascriptInterface public void say(int id, String text, float rate, float pitch) { main.post(() -> phoneSay(id, text, rate, pitch)); }
    @JavascriptInterface public void http(int id, String url, String method, String headers, String body) { MainActivity.this.http(id, url, method, headers, body); }
    @JavascriptInterface public void httpAbort(int id) { java.net.HttpURLConnection c = conns.remove(id); if (c != null) httpExec.execute(c::disconnect); }
    @JavascriptInterface public void exit() { main.post(MainActivity.this::finish); }
  }
}
