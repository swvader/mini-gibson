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
import android.webkit.GeolocationPermissions;
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
import androidx.camera.core.ImageCapture;
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
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import androidx.camera.core.Camera;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.SurfaceOrientedMeteringPointFactory;
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

  static java.lang.ref.WeakReference<MainActivity> inst;
  volatile int faceWanted; boolean faceWantedEnroll; int authReqId;
  @Override protected void onCreate(Bundle b) {
    inst = new java.lang.ref.WeakReference<>(this);
    super.onCreate(b);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    am = (AudioManager) getSystemService(AUDIO_SERVICE);
    setVolumeControlStream(AudioManager.STREAM_MUSIC);
    web = new WebView(this);
    root = new android.widget.FrameLayout(this); root.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1)); setContentView(root);   // 1.0.10: native camera preview / photo review go on top
    immersive();
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false); s.setAllowFileAccess(false); s.setGeolocationEnabled(true);
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
      // weather location: use the real Android permission; ask with the system dialog if it hasn't been answered yet
      @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
        if (hasLocation()) { cb.invoke(origin, true, false); return; }
        geoPending.add(() -> cb.invoke(origin, hasLocation(), false));
        requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION}, 2);
      }
    });
    web.addJavascriptInterface(new Bridge(), "GibsonNative");
    List<String> need = new ArrayList<>();
    for (String p : new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION})
      if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) need.add(p);
    if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), 1);
    web.loadUrl("https://" + HOST + "/assets/web/index.html");
    startPhoneWatch();
  }
  void immersive() {
    web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
  }
  @Override public void onWindowFocusChanged(boolean f) { super.onWindowFocusChanged(f); if (f) immersive(); }
  final List<Runnable> geoPending = new ArrayList<>();
  boolean hasLocation() { return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED; }
  @Override public void onRequestPermissionsResult(int c, String[] p, int[] g) {
    super.onRequestPermissionsResult(c, p, g);
    for (Runnable r : new ArrayList<>(geoPending)) r.run(); geoPending.clear();
    emit("perm", J("location", hasLocation(), "mic", ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED));
    startPhoneWatch();
  }
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
        bind(shootMode > 0 ? shootBack : backOnce, false); camStartedAt = System.currentTimeMillis();
        camErr = ""; emit("cam", J("on", true));
        if (pendingLabel != null) { Runnable r = pendingLabel; pendingLabel = null; r.run(); }
      } catch (Exception e) { camProvider = null; camErr = String.valueOf(e); emit("cam", J("error", camErr)); }
    }, ContextCompat.getMainExecutor(this));
  }
  Camera camera; boolean camBack, camHi; Runnable pendingLabel; volatile long camStartedAt;
  void bind(boolean back, boolean hi) throws Exception {
    int disp = getWindowManager().getDefaultDisplay().getRotation(); boolean portrait = disp == android.view.Surface.ROTATION_0 || disp == android.view.Surface.ROTATION_180;
    android.util.Size sz = hi ? (portrait ? new android.util.Size(1080, 1920) : new android.util.Size(1920, 1080)) : new android.util.Size(640, 480);
    ImageAnalysis an = analysis = new ImageAnalysis.Builder().setTargetResolution(sz)
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888).build();
    an.setTargetRotation(disp);
    an.setAnalyzer(camExec, this::analyze);
    CameraSelector want = back ? CameraSelector.DEFAULT_BACK_CAMERA : CameraSelector.DEFAULT_FRONT_CAMERA, other = back ? CameraSelector.DEFAULT_FRONT_CAMERA : CameraSelector.DEFAULT_BACK_CAMERA;
    CameraSelector sel = camProvider.hasCamera(want) ? want : other;
    camBack = sel == CameraSelector.DEFAULT_BACK_CAMERA; camHi = hi;
    camProvider.unbindAll();
    if (shootMode > 0) {           // photo / video: live preview (native, on top of the page) + capture use case
      showBox(true);
      androidx.camera.core.Preview prev = new androidx.camera.core.Preview.Builder().setTargetRotation(disp).build();
      prev.setSurfaceProvider(pv.getSurfaceProvider());
      androidx.camera.core.UseCase cap;
      if (shootMode == 1) cap = imgCap = new ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).setTargetRotation(disp).build();
      else {
        androidx.camera.video.Recorder rec = new androidx.camera.video.Recorder.Builder()
          .setQualitySelector(androidx.camera.video.QualitySelector.from(androidx.camera.video.Quality.HD, androidx.camera.video.FallbackStrategy.lowerQualityOrHigherThan(androidx.camera.video.Quality.SD))).build();
        vidCap = androidx.camera.video.VideoCapture.withOutput(rec); vidCap.setTargetRotation(disp); cap = vidCap;
      }
      try { camera = camProvider.bindToLifecycle(this, sel, prev, an, cap); }
      catch (Exception e) { camProvider.unbindAll(); camera = camProvider.bindToLifecycle(this, sel, prev, cap); }   // camera can't do 3 streams: no framing faces, preview + capture still work
    } else camera = camProvider.bindToLifecycle(this, sel, an);
    if (shootMode > 0) emit("shoot", J("ready", true, "back", camBack));
  }
  // ------------------------------------------------------------------ 1.0.9: save photos / record video (front camera; saved to the gallery)
  volatile int shootMode = 0; ImageCapture imgCap; androidx.camera.video.VideoCapture<androidx.camera.video.Recorder> vidCap; androidx.camera.video.Recording recording; long recT0;
  android.widget.FrameLayout root, shootBox; androidx.camera.view.PreviewView pv; android.widget.TextView shootLbl; android.widget.ImageView review;
  int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }
  android.widget.FrameLayout.LayoutParams boxLp() {   // centred, framed box (portrait-shaped), ~80% of the short side tall
    android.util.DisplayMetrics m = getResources().getDisplayMetrics(); int side = Math.min(m.widthPixels, m.heightPixels);
    int h = m.heightPixels > m.widthPixels ? Math.round(side * 1.0f) : Math.round(side * 0.82f), w = Math.round(h * 0.75f);
    return new android.widget.FrameLayout.LayoutParams(w, h, android.view.Gravity.CENTER);
  }
  android.graphics.drawable.GradientDrawable frameBg() { android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable(); g.setColor(0xFF000000); g.setCornerRadius(dp(22)); g.setStroke(dp(4), 0xFFFF2A2A); return g; }
  void showBox(boolean on) {
    if (shootBox == null) {
      shootBox = new android.widget.FrameLayout(this); shootBox.setBackground(frameBg()); shootBox.setClipToOutline(true); int p = dp(4); shootBox.setPadding(p, p, p, p);
      pv = new androidx.camera.view.PreviewView(this); pv.setImplementationMode(androidx.camera.view.PreviewView.ImplementationMode.COMPATIBLE);   // TextureView: draws above the WebView
      shootBox.addView(pv, new android.widget.FrameLayout.LayoutParams(-1, -1));
      shootLbl = new android.widget.TextView(this); shootLbl.setTextColor(0xFFFF3B3B); shootLbl.setTextSize(30); shootLbl.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
      shootLbl.setShadowLayer(12, 0, 0, 0xFF000000); shootLbl.setGravity(android.view.Gravity.CENTER); shootLbl.setPadding(0, 0, 0, dp(14));
      shootBox.addView(shootLbl, new android.widget.FrameLayout.LayoutParams(-1, -2, android.view.Gravity.BOTTOM));
      shootBox.setOnClickListener(v -> { if (recording != null) recording.stop(); });   // tap the preview = stop recording
      root.addView(shootBox, boxLp());
    }
    if (on) { shootBox.setLayoutParams(boxLp()); shootBox.setVisibility(View.VISIBLE); shootBox.bringToFront(); } else { shootBox.setVisibility(View.GONE); shootLbl.setText(""); }
  }
  void showReview(android.net.Uri u) {   // the saved photo, on screen for 3 s
    new Thread(() -> {
      try {
        Bitmap bm;
        if (android.os.Build.VERSION.SDK_INT >= 28) bm = android.graphics.ImageDecoder.decodeBitmap(android.graphics.ImageDecoder.createSource(getContentResolver(), u), (d, i, s) -> { int sc = Math.max(1, Math.max(i.getSize().getWidth(), i.getSize().getHeight()) / 1600); d.setTargetSampleSize(sc); });
        else { android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options(); o.inSampleSize = 2; bm = android.graphics.BitmapFactory.decodeStream(getContentResolver().openInputStream(u), null, o); }
        final Bitmap b = bm;
        main.post(() -> {
          if (review == null) { review = new android.widget.ImageView(this); review.setBackground(frameBg()); review.setClipToOutline(true); review.setScaleType(android.widget.ImageView.ScaleType.CENTER_CROP); int p = dp(4); review.setPadding(p, p, p, p); root.addView(review, boxLp()); }
          review.setLayoutParams(boxLp()); review.setImageBitmap(b); review.setVisibility(View.VISIBLE); review.bringToFront();
          main.removeCallbacks(hideReview); main.postDelayed(hideReview, 3000);
        });
      } catch (Throwable e) { camErr = "review: " + e; }
    }).start();
  }
  final Runnable hideReview = () -> { if (review != null) { review.setVisibility(View.GONE); review.setImageBitmap(null); } };
  volatile boolean backOnce, shootBack;
  void shootStart(boolean video, boolean back) {
    shootMode = video ? 2 : 1; shootBack = back; faceOn = true; showBox(true);
    if (camProvider == null) { camStart(); return; }
    try { bind(back, false); } catch (Exception e) { emit("shoot", J("error", String.valueOf(e))); }
  }
  void shootEnd() {
    if (recording != null) { try { recording.stop(); } catch (Exception e) {} recording = null; }
    shootMode = 0; imgCap = null; vidCap = null; faceOn = false; camStop(); if (shootBox != null) showBox(false);   // camera off afterwards: less heat (the photo review stays its 3 s)
  }
  String stamp() { return "Gibson_" + new java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US).format(new java.util.Date()); }
  void takePhoto(int id) {
    if (imgCap == null) { emit("shot", J("id", id, "error", "camera not ready")); return; }
    String name = stamp();
    android.content.ContentValues cv = new android.content.ContentValues();
    cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name); cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "image/jpeg");
    if (android.os.Build.VERSION.SDK_INT >= 29) cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/MiniGibson");
    try { imgCap.setTargetRotation(getWindowManager().getDefaultDisplay().getRotation()); } catch (Exception e) {}
    ImageCapture.OutputFileOptions o = new ImageCapture.OutputFileOptions.Builder(getContentResolver(), android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv).build();
    imgCap.takePicture(o, ContextCompat.getMainExecutor(this), new ImageCapture.OnImageSavedCallback() {
      @Override public void onImageSaved(ImageCapture.OutputFileResults r) { if (r.getSavedUri() != null) showReview(r.getSavedUri()); emit("shot", J("id", id, "ok", true, "uri", String.valueOf(r.getSavedUri()), "name", name)); }
      @Override public void onError(androidx.camera.core.ImageCaptureException e) { emit("shot", J("id", id, "error", String.valueOf(e.getMessage()))); }
    });
  }
  @android.annotation.SuppressLint("MissingPermission")
  void recStart(int id, int maxSec) {
    if (vidCap == null) { emit("rec", J("id", id, "error", "camera not ready")); return; }
    String name = stamp();
    android.content.ContentValues cv = new android.content.ContentValues();
    cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name); cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "video/mp4");
    if (android.os.Build.VERSION.SDK_INT >= 29) cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Movies/MiniGibson");
    androidx.camera.video.MediaStoreOutputOptions mo = new androidx.camera.video.MediaStoreOutputOptions.Builder(getContentResolver(), android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
      .setContentValues(cv).setDurationLimitMillis(maxSec * 1000L).build();
    try {
      androidx.camera.video.PendingRecording pr = vidCap.getOutput().prepareRecording(this, mo);
      final boolean audio = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
      if (audio) pr = pr.withAudioEnabled();
      recording = pr.start(ContextCompat.getMainExecutor(this), ev -> {
        if (ev instanceof androidx.camera.video.VideoRecordEvent.Start) { recT0 = System.currentTimeMillis(); emit("rec", J("id", id, "started", true, "audio", audio)); }
        else if (ev instanceof androidx.camera.video.VideoRecordEvent.Finalize) {
          androidx.camera.video.VideoRecordEvent.Finalize f = (androidx.camera.video.VideoRecordEvent.Finalize) ev; recording = null;
          int err = f.getError(); android.net.Uri u = f.getOutputResults().getOutputUri();
          boolean ok = u != null && !android.net.Uri.EMPTY.equals(u) && (err == 0 || err == androidx.camera.video.VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED || err == androidx.camera.video.VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED || err == androidx.camera.video.VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE);
          emit("recdone", J("id", id, "ok", ok, "uri", String.valueOf(u), "ms", System.currentTimeMillis() - recT0, "limit", err == androidx.camera.video.VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED, "error", err == 0 ? "" : "code " + err + " " + f.getCause()));
        }
      });
    } catch (Exception e) { emit("rec", J("id", id, "error", String.valueOf(e))); }
  }
  // ------------------------------------------------------------------ 1.0.9: phone status for the brain (only real readings; missing = null)
  boolean askedPhone;
  String phoneInfo() {
    JSONObject o = new JSONObject();
    try {
      o.put("model", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL); o.put("android", android.os.Build.VERSION.RELEASE + " (SDK " + android.os.Build.VERSION.SDK_INT + ")");
      o.put("uptimeMin", android.os.SystemClock.elapsedRealtime() / 60000); o.put("appUptimeMin", (System.currentTimeMillis() - appT0) / 60000);
      android.content.Intent b = registerReceiver(null, new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
      android.os.BatteryManager bm = (android.os.BatteryManager) getSystemService(BATTERY_SERVICE);
      if (b != null) {
        int lvl = b.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1), sc = b.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100);
        if (lvl >= 0) o.put("batteryPct", Math.round(100f * lvl / sc));
        int t = b.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE); if (t != Integer.MIN_VALUE) o.put("batteryTempC", t / 10.0);
        int mv = b.getIntExtra(android.os.BatteryManager.EXTRA_VOLTAGE, -1); if (mv > 0) o.put("batteryVolts", mv / 1000.0);
        int pl = b.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0); o.put("plugged", pl == 1 ? "AC charger" : pl == 2 ? "USB" : pl == 4 ? "wireless" : pl == 8 ? "dock" : "not plugged in");
        int st = b.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1); o.put("chargeStatus", st == 2 ? "charging" : st == 3 ? "discharging" : st == 4 ? "not charging" : st == 5 ? "full" : "unknown");
        int h = b.getIntExtra(android.os.BatteryManager.EXTRA_HEALTH, 0); o.put("batteryHealth", h == 2 ? "good" : h == 3 ? "overheat" : h == 4 ? "dead" : h == 5 ? "over voltage" : h == 7 ? "cold" : "unknown");
        long cur = bm.getLongProperty(android.os.BatteryManager.BATTERY_PROPERTY_CURRENT_NOW);
        if (cur != Long.MIN_VALUE && cur != 0) {   // most phones report microamps; some Samsungs report milliamps
          double ma = android.os.Build.MANUFACTURER.equalsIgnoreCase("samsung") && Math.abs(cur) < 10000 ? cur : cur / 1000.0;
          o.put("batteryCurrentmA", Math.round(ma)); if (mv > 0) o.put("powerWattsEstimate", Math.round(Math.abs(ma) * mv / 1e5) / 10.0);
        }
      }
      if (android.os.Build.VERSION.SDK_INT >= 29) {
        android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        int ts = pm.getCurrentThermalStatus(); String[] tn = {"none (cool)", "light", "moderate", "severe", "critical", "emergency", "shutdown"};
        o.put("thermalStatus", ts >= 0 && ts < tn.length ? tn[ts] : "unknown"); o.put("throttled", ts >= 2 ? "likely (moderate or worse)" : ts == 1 ? "maybe slightly" : "no");
        if (android.os.Build.VERSION.SDK_INT >= 30) { float hr = pm.getThermalHeadroom(10); if (!Float.isNaN(hr)) o.put("thermalHeadroom", Math.round(hr * 100) / 100.0 + " (1.0 = throttling starts)"); }
        o.put("batterySaver", pm.isPowerSaveMode());
      }
      double cpu = -1; for (int i = 0; i < 80; i++) {   // usually blocked on newer Android; then cpuTempC stays missing
        try {
          File d = new File("/sys/class/thermal/thermal_zone" + i); if (!d.exists()) { if (i > 10) break; continue; }
          String ty = new String(java.nio.file.Files.readAllBytes(new File(d, "type").toPath())).trim().toLowerCase();
          if (!ty.matches(".*(cpu|tsens|soc|big|little|mid|apc).*")) continue;
          double v = Double.parseDouble(new String(java.nio.file.Files.readAllBytes(new File(d, "temp").toPath())).trim()); if (v > 1000) v /= 1000;
          if (v > 10 && v < 125) cpu = Math.max(cpu, v);
        } catch (Throwable e) {}
      }
      if (cpu > 0) o.put("cpuTempC", Math.round(cpu * 10) / 10.0);
      android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
      android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
      boolean wifi = nc != null && nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI), cell = nc != null && nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR);
      o.put("connection", nc == null ? "offline" : wifi ? "Wi-Fi" : cell ? "mobile data" : "other");
      if (nc != null) { o.put("downlinkMbpsEstimate", nc.getLinkDownstreamBandwidthKbps() / 1000); o.put("uplinkMbpsEstimate", nc.getLinkUpstreamBandwidthKbps() / 1000); }
      if (wifi) {
        android.net.wifi.WifiInfo wi = ((android.net.wifi.WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE)).getConnectionInfo();
        if (wi != null) { o.put("wifiRssiDbm", wi.getRssi()); o.put("wifiLevel0to4", android.net.wifi.WifiManager.calculateSignalLevel(wi.getRssi(), 5)); o.put("wifiLinkMbps", wi.getLinkSpeed());
          String ss = wi.getSSID(); if (ss != null && !ss.contains("unknown ssid")) o.put("wifiName", ss.replace("\"", "")); else o.put("wifiName", "not readable (needs location permission)"); }
      }
      android.telephony.TelephonyManager tm = (android.telephony.TelephonyManager) getSystemService(TELEPHONY_SERVICE);
      if (tm != null) {
        try { o.put("carrier", tm.getNetworkOperatorName()); } catch (Throwable e) {}
        if (android.os.Build.VERSION.SDK_INT >= 29) try {
          android.telephony.SignalStrength ss = tm.getSignalStrength();
          if (ss != null) { o.put("cellLevel0to4", ss.getLevel()); for (android.telephony.CellSignalStrength c : ss.getCellSignalStrengths()) { o.put("cellDbm", c.getDbm()); break; } }
        } catch (Throwable e) {}
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) try {
          int nt = tm.getDataNetworkType();
          o.put("cellNetwork", nt == 20 ? "5G" : nt == 13 ? "4G LTE (may be 5G non-standalone)" : nt == 18 ? "Wi-Fi calling" : (nt == 3 || nt == 8 || nt == 9 || nt == 10 || nt == 15) ? "3G" : nt == 0 ? "none/unknown" : "2G or other");
        } catch (Throwable e) {}
        else { o.put("cellNetwork", "not readable (phone permission not given)"); if (!askedPhone) { askedPhone = true; main.post(() -> requestPermissions(new String[]{Manifest.permission.READ_PHONE_STATE}, 3)); } }
      }
      android.os.StatFs fs = new android.os.StatFs(android.os.Environment.getDataDirectory().getPath());
      o.put("storageFreeGB", Math.round(fs.getAvailableBytes() / 1e8) / 10.0); o.put("storageTotalGB", Math.round(fs.getTotalBytes() / 1e8) / 10.0);
      android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo(); ((android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(mi);
      o.put("ramFreeGB", Math.round(mi.availMem / 1e8) / 10.0); o.put("ramTotalGB", Math.round(mi.totalMem / 1e8) / 10.0); o.put("ramLow", mi.lowMemory);
    } catch (Throwable e) { try { o.put("error", String.valueOf(e)); } catch (Exception x) {} }
    return o.toString();
  }
  final long appT0 = System.currentTimeMillis();
  android.app.PendingIntent alarmPi(int id, String title, String text) {
    android.content.Intent i = new android.content.Intent(this, AlarmReceiver.class).putExtra("id", id).putExtra("title", title).putExtra("text", text);
    return android.app.PendingIntent.getBroadcast(this, id, i, android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
  }
  // 1.0.12 helpers -----------------------------------------------------------------
  double[] lumStats(Bitmap b) {
    try { int sw = Math.min(b.getWidth(), 64), sh = Math.min(b.getHeight(), 64); Bitmap s = Bitmap.createScaledBitmap(b, Math.max(1, sw), Math.max(1, sh), false);
      int n = s.getWidth() * s.getHeight(); int[] px = new int[n]; s.getPixels(px, 0, s.getWidth(), 0, 0, s.getWidth(), s.getHeight());
      double sum = 0, sum2 = 0; for (int i = 0; i < n; i++) { int p = px[i]; double l = 0.299 * ((p >> 16) & 255) + 0.587 * ((p >> 8) & 255) + 0.114 * (p & 255); sum += l; sum2 += l * l; }
      double m = sum / n; return new double[]{ m, Math.sqrt(Math.max(0, sum2 / n - m * m)) };
    } catch (Throwable e) { return new double[]{ 128, 128 }; }
  }
  Bitmap rotateBmp(Bitmap b, int deg) { if (deg == 0) return b; Matrix m = new Matrix(); m.postRotate(deg); return Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true); }
  void doFaceShot(int id, Bitmap bm, int rot) {
    try {
      if (faceDet == null) faceDet = FaceDetection.getClient(new FaceDetectorOptions.Builder().setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST).setMinFaceSize(0.12f).build());
      final Bitmap up = rotateBmp(bm, rot);
      faceDet.process(InputImage.fromBitmap(up, 0)).addOnSuccessListener(faces -> {
        String reason = "";
        if (faces.isEmpty()) reason = "none"; else if (faces.size() > 1) reason = "many";
        Face best = faces.isEmpty() ? null : faces.get(0);
        if (best != null && reason.isEmpty()) {
          Rect rc = best.getBoundingBox(); int W = up.getWidth(), H = up.getHeight();
          float frac = (float) rc.width() / W, cx = rc.centerX() / (float) W, cy = rc.centerY() / (float) H;
          if (frac < 0.18f) reason = "small";
          else if (Math.abs(cx - 0.5f) > 0.32f || Math.abs(cy - 0.5f) > 0.38f) reason = "offcenter";
          if (reason.isEmpty()) {
            int m = (int) (rc.width() * 0.4f); int x0 = Math.max(0, rc.left - m), y0 = Math.max(0, rc.top - m), x1 = Math.min(W, rc.right + m), y1 = Math.min(H, rc.bottom + m);
            Bitmap crop = Bitmap.createBitmap(up, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
            float sc = 320f / Math.max(crop.getWidth(), crop.getHeight()); if (sc < 1) { Matrix mm = new Matrix(); mm.postScale(sc, sc); crop = Bitmap.createBitmap(crop, 0, 0, crop.getWidth(), crop.getHeight(), mm, true); }
            int cw = crop.getWidth(), ch = crop.getHeight(); int[] px = new int[cw * ch]; crop.getPixels(px, 0, cw, 0, 0, cw, ch);
            double sharp = Sharp.laplacianVariance(px, cw, ch);
            if (sharp < 30) reason = "blurry";
            else { ByteArrayOutputStream bo = new ByteArrayOutputStream(); crop.compress(Bitmap.CompressFormat.JPEG, 82, bo); String b64 = Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP);
              emit("faceshot", J("id", id, "ok", true, "b64", b64, "size", Math.round(frac * 100) / 100.0, "sharp", Math.round(sharp))); faceFinish(); return; }
          }
        }
        emit("faceshot", J("id", id, "ok", false, "reason", reason.isEmpty() ? "none" : reason)); faceFinish();
      }).addOnFailureListener(e -> { emit("faceshot", J("id", id, "ok", false, "reason", "error")); faceFinish(); });
    } catch (Throwable e) { emit("faceshot", J("id", id, "ok", false, "reason", "error")); faceFinish(); }
  }
  void faceFinish() { main.post(() -> { try { if (faceOn || labelOn || shootMode > 0 || snapWanted > 0) return; camStop(); } catch (Throwable e) {} }); }
  String readAll(java.io.InputStream in) throws Exception { if (in == null) return ""; ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] b = new byte[4096]; int r; while ((r = in.read(b)) > 0) bo.write(b, 0, r); return new String(bo.toByteArray(), "UTF-8"); }
  void chatTts(int id, String url, String body, int firstMs) {
    java.net.HttpURLConnection c = null;
    try {
      c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
      c.setRequestMethod("POST"); c.setConnectTimeout(5000); c.setReadTimeout(Math.max(8000, firstMs) + 60000);
      c.setRequestProperty("Content-Type", "application/json"); c.setRequestProperty("Accept", "audio/wav"); c.setDoOutput(true);
      byte[] bb = body.getBytes("UTF-8"); OutputStream os = c.getOutputStream(); os.write(bb); os.close();
      int st = c.getResponseCode();
      if (st >= 400) { String err = ""; try { err = readAll(c.getErrorStream()); } catch (Exception e) {} emit("chat", J("id", id, "status", st, "err", err.substring(0, Math.min(200, err.length())))); return; }
      long t0 = System.currentTimeMillis(); long first = -1; java.io.InputStream in = c.getInputStream(); ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] buf = new byte[8192]; int rd;
      while ((rd = in.read(buf)) > 0) { if (first < 0) first = System.currentTimeMillis() - t0; bo.write(buf, 0, rd); }
      File d = new File(getCacheDir(), "tts"); d.mkdirs(); File f = new File(d, "chat" + (id % 8) + ".wav"); try (FileOutputStream o = new FileOutputStream(f)) { o.write(bo.toByteArray()); }
      emit("chat", J("id", id, "status", st, "url", "https://" + HOST + "/tts/" + f.getName() + "?" + id, "first", first));
    } catch (Exception e) { emit("chat", J("id", id, "error", String.valueOf(e))); } finally { if (c != null) c.disconnect(); }
  }
  String contactName(String number) {
    try { if (number == null || number.isEmpty()) return null;
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) return null;
      android.net.Uri u = android.net.Uri.withAppendedPath(android.provider.ContactsContract.PhoneLookup.CONTENT_FILTER_URI, android.net.Uri.encode(number));
      android.database.Cursor c = getContentResolver().query(u, new String[]{ android.provider.ContactsContract.PhoneLookup.DISPLAY_NAME }, null, null, null);
      String nm = null; if (c != null) { if (c.moveToFirst()) nm = c.getString(0); c.close(); } return nm;
    } catch (Throwable e) { return null; }
  }
  void startPhoneWatch() {
    try {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return;
      android.telephony.TelephonyManager tm = (android.telephony.TelephonyManager) getSystemService(TELEPHONY_SERVICE);
      tm.listen(new android.telephony.PhoneStateListener() {
        @Override public void onCallStateChanged(int state, String number) { if (state == android.telephony.TelephonyManager.CALL_STATE_RINGING) emit("call", J("state", "ringing", "number", number == null ? "" : number, "name", contactName(number))); }
      }, android.telephony.PhoneStateListener.LISTEN_CALL_STATE);
    } catch (Throwable e) {}
  }
  @Override protected void onActivityResult(int rc, int res, android.content.Intent data) { super.onActivityResult(rc, res, data); if (rc == 900) emit("auth", J("id", authReqId, "ok", res == RESULT_OK)); }
  void focusCenter() {   // tap-to-focus at the centre; front cameras are often fixed-focus, so this may be a no-op
    try {
      if (camera == null) return;
      MeteringPoint pt = new SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(.5f, .5f, .3f);
      FocusMeteringAction a = new FocusMeteringAction.Builder(pt, FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE).setAutoCancelDuration(3, java.util.concurrent.TimeUnit.SECONDS).build();
      if (camera.getCameraInfo().isFocusMeteringSupported(a)) camera.getCameraControl().startFocusAndMetering(a);
    } catch (Throwable e) {}
  }

  // ------------------------------------------------------------------ label reading: coached burst, sharpest readable frame
  static final double SHARP_OK = 120;
  TextRecognizer textRec; volatile boolean labelOn, labelOcrBusy; int labelId, labelFrames, labelBestChars, labelGood; long labelT0, labelMax, labelLastFrame, labelLastFocus;
  boolean labelWasOn; volatile String labelWhy = ""; Bitmap labelBest; Rect labelBestBox; String labelBestText = ""; double labelBestScore = -1, labelBestSharp, labelMaxSharp;
  void labelStart(int id, boolean back, int maxMs) {
    if (labelOn) labelFinish();
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) { emit("labeldone", J("id", id, "error", "camera permission not granted")); return; }
    if (textRec == null) textRec = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    labelId = id; labelMax = maxMs; labelFrames = 0; labelBestChars = 0; labelGood = 0; labelBest = null; labelBestBox = null; labelBestText = ""; labelBestScore = -1; labelBestSharp = 0; labelMaxSharp = 0;
    labelWasOn = camProvider != null; labelWhy = "";
    Runnable go = () -> {
      try { bind(back, true); } catch (Exception e) { emit("labeldone", J("id", id, "error", "camera: " + e)); return; }
      labelT0 = System.currentTimeMillis(); labelLastFrame = 0; labelLastFocus = 0; labelOn = true;
      main.postDelayed(this::focusCenter, 300);
      main.postDelayed(() -> { if (labelOn && labelId == id) { labelWhy = "timeout"; labelFinish(); } }, maxMs + 400);
    };
    if (camProvider == null) { pendingLabel = go; camStart(); } else go.run();
  }
  void analyzeLabel(ImageProxy img) {
    long now = System.currentTimeMillis();
    if (now - labelT0 > labelMax) { labelWhy = "timeout"; main.post(() -> { if (labelOn) labelFinish(); }); return; }
    if (labelOcrBusy || now - labelLastFrame < 280) return;
    labelLastFrame = now; labelFrames++;
    if (now - labelLastFocus > 2000) { labelLastFocus = now; main.post(this::focusCenter); }
    final int rot = img.getImageInfo().getRotationDegrees();
    Bitmap raw = img.toBitmap(); Matrix mx = new Matrix(); mx.postRotate(rot);
    final Bitmap up = rot == 0 ? raw : Bitmap.createBitmap(raw, 0, 0, raw.getWidth(), raw.getHeight(), mx, true);   // upright, never mirrored
    final int W = up.getWidth(), H = up.getHeight();
    int cw = (int) (W * .6), ch = (int) (H * .5); float sc = Math.min(1f, 480f / cw);
    Bitmap cen = Bitmap.createScaledBitmap(Bitmap.createBitmap(up, (W - cw) / 2, (H - ch) / 2, cw, ch), Math.max(3, (int) (cw * sc)), Math.max(3, (int) (ch * sc)), true);
    int[] px = new int[cen.getWidth() * cen.getHeight()]; cen.getPixels(px, 0, cen.getWidth(), 0, 0, cen.getWidth(), cen.getHeight());
    final double sharp = Sharp.laplacianVariance(px, cen.getWidth(), cen.getHeight());
    long lsum = 0; for (int i = 0; i < px.length; i += 7) { int c = px[i]; lsum += (((c >> 16) & 255) * 3 + ((c >> 8) & 255) * 6 + (c & 255)) / 10; }
    final double lum = lsum / Math.max(1.0, px.length / 7.0);
    labelMaxSharp = Math.max(labelMaxSharp, sharp);
    labelOcrBusy = true; final int id = labelId;
    textRec.process(InputImage.fromBitmap(up, 0)).addOnSuccessListener(t -> {
      if (!labelOn || id != labelId) return;
      int chars = 0; Rect box = null; List<Integer> hs = new ArrayList<>();
      for (Text.TextBlock b : t.getTextBlocks()) {
        Rect r = b.getBoundingBox(); if (r == null) continue;
        chars += b.getText().replaceAll("\\s", "").length();
        if (box == null) box = new Rect(r); else box.union(r);
        for (Text.Line l : b.getLines()) { Rect lr = l.getBoundingBox(); if (lr != null) hs.add(lr.height()); }
      }
      java.util.Collections.sort(hs); double textH = hs.isEmpty() ? 0 : hs.get(hs.size() / 2) / (double) H;
      boolean edge = box != null && (box.left < W * .03 || box.right > W * .97);
      String hint;   // coach: light -> no text (blurry = too close to focus, so "back") -> text size -> blur -> framing
      boolean readable = sharp >= SHARP_OK && chars >= 25 && textH >= .02 && !edge;
      if (lum < 38) hint = "light";
      else if (chars < 8) hint = labelFrames > 2 && sharp < SHARP_OK * .6 ? "back" : "show";
      else if (textH < .02) hint = sharp < SHARP_OK * .6 ? "still" : "closer";
      else if (sharp < SHARP_OK && textH > .045) hint = "back";
      else if (sharp < SHARP_OK) hint = "still";
      else if (edge) hint = "turn";
      else if (!readable) hint = "closer";
      else hint = "good";
      double score = chars * Math.min(1.0, sharp / SHARP_OK) * (edge ? .85 : 1);
      if (score > labelBestScore) { labelBestScore = score; labelBest = up; labelBestBox = box; labelBestText = t.getText(); labelBestSharp = sharp; labelBestChars = chars; }
      if ("good".equals(hint)) labelGood++; else labelGood = 0;
      emit("label", J("id", id, "hint", hint, "sharp", Math.round(sharp), "chars", chars, "frames", labelFrames, "textH", Math.round(textH * 1000) / 1000.0, "lum", Math.round(lum)));
      if (labelGood >= 2 || (readable && sharp >= SHARP_OK * 1.5 && chars >= 40)) { labelWhy = "readable"; labelFinish(); }   // clearly readable: stop
    }).addOnFailureListener(e -> {
      if (sharp > labelBestSharp && labelBestChars == 0) { labelBest = up; labelBestSharp = sharp; labelBestScore = 0; }
    }).addOnCompleteListener(x -> labelOcrBusy = false);
  }
  synchronized void labelFinish() {
    if (!labelOn) return;
    labelOn = false; final int id = labelId; final Bitmap best = labelBest; final Rect box = labelBestBox;
    final String text = labelBestText; final int frames = labelFrames, chars = labelBestChars; final double sharp = labelBestSharp; final boolean back = camBack;
    labelBest = null;
    camExec.execute(() -> {
      JSONObject o = J("id", id, "frames", frames, "chars", chars, "sharp", Math.round(sharp), "maxSharp", Math.round(labelMaxSharp), "camera", back ? "back" : "front", "text", text, "why", labelWhy.isEmpty() ? "stopped" : labelWhy);
      try {
        if (best != null) {
          Bitmap c = best;
          if (box != null && chars >= 8) {   // crop to the text plus padding
            int pw = Math.max(40, (int) (box.width() * .12)), ph = Math.max(40, (int) (box.height() * .18));
            Rect r = new Rect(Math.max(0, box.left - pw), Math.max(0, box.top - ph), Math.min(best.getWidth(), box.right + pw), Math.min(best.getHeight(), box.bottom + ph));
            if (r.width() > 50 && r.height() > 50) c = Bitmap.createBitmap(best, r.left, r.top, r.width(), r.height());
          }
          float sc = 1920f / Math.max(c.getWidth(), c.getHeight());
          if (sc < 1) c = Bitmap.createScaledBitmap(c, Math.round(c.getWidth() * sc), Math.round(c.getHeight() * sc), true);
          ByteArrayOutputStream bo = new ByteArrayOutputStream(); c.compress(Bitmap.CompressFormat.JPEG, 90, bo);
          o.put("b64", Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP)); o.put("w", c.getWidth()); o.put("h", c.getHeight());
        }
      } catch (Throwable e) { try { o.put("error", String.valueOf(e)); } catch (Exception x) {} }
      emit("labeldone", o);
      main.post(() -> {   // back to the normal low-res front camera (or off, if it was off before)
        try { if (faceOn || labelWasOn) bind(false, false); else camStop(); } catch (Exception e) { camErr = String.valueOf(e); }
      });
    });
  }

  void camStop() { if (camProvider != null) { camProvider.unbindAll(); camProvider = null; } lastJpeg = null; emit("cam", J("on", false)); }
  @Override public void onConfigurationChanged(android.content.res.Configuration c) {   // keep photos upright when the phone turns
    super.onConfigurationChanged(c);
    if (analysis != null) try { analysis.setTargetRotation(getWindowManager().getDefaultDisplay().getRotation()); } catch (Exception e) {}
  }
  void analyze(ImageProxy img) {
    try {
      camFrames++;
      if (labelOn) { analyzeLabel(img); return; }
      if (camHi) return;   // (label mode just ended; the low-res rebind is on its way)
      final int rot = img.getImageInfo().getRotationDegrees();
      long now = System.currentTimeMillis();
      if (faceWanted > 0 && now - camStartedAt > 600) { int fid = faceWanted; faceWanted = 0; Bitmap fb = null; try { fb = img.toBitmap(); } catch (Throwable e) {} if (fb != null) doFaceShot(fid, fb, rot); else emit("faceshot", J("id", fid, "ok", false, "reason", "error")); return; }
      if (now - camStartedAt < 700 && snapWanted > 0) return;   // just switched on: give auto-exposure a moment (first frames are dark)
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
        double[] ls = lumStats(out);
        int id = snapWanted; if (id > 0) { snapWanted = 0; emit("snap", J("id", id, "b64", lastJpeg, "w", out.getWidth(), "h", out.getHeight(), "back", camBack, "lum", Math.round(ls[0]), "varr", Math.round(ls[1])));
          if (backOnce) { backOnce = false; lastJpeg = null; main.post(() -> { try { if (camProvider == null || shootMode > 0 || labelOn) return; if (faceOn) bind(false, false); else camStop(); } catch (Exception e) { camErr = String.valueOf(e); } }); } }
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

  // ------------------------------------------------------------------ ElevenLabs TTS: POST, stream the PCM into a cache file, hand JS a local URL
  void elTts(int id, String url, String key, String body) {
    httpExec.execute(() -> {
      java.net.HttpURLConnection c = null; long t0 = System.currentTimeMillis();
      try {
        c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
        c.setConnectTimeout(8000); c.setReadTimeout(12000); c.setRequestMethod("POST"); c.setDoOutput(true);
        c.setRequestProperty("xi-api-key", key); c.setRequestProperty("Content-Type", "application/json"); c.setRequestProperty("Accept", "audio/pcm");
        try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes("UTF-8")); }
        int st = c.getResponseCode();
        if (st >= 400) {
          String err = ""; InputStream es = c.getErrorStream();
          if (es != null) { ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] b = new byte[4096]; int n; while ((n = es.read(b)) > 0 && bo.size() < 2000) bo.write(b, 0, n); err = bo.toString("UTF-8"); }
          emit("el", J("id", id, "status", st, "err", err.length() > 600 ? err.substring(0, 600) : err)); return;
        }
        File f = new File(new File(getCacheDir(), "tts"), "e" + (id % 60) + ".pcm"); long first = -1, total = 0;
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(f)) {
          byte[] b = new byte[16384]; int n;
          while ((n = in.read(b)) > 0) { if (first < 0) first = System.currentTimeMillis() - t0; out.write(b, 0, n); total += n; }
        }
        emit("el", J("id", id, "status", st, "url", "https://" + HOST + "/tts/" + f.getName() + "?" + id, "first", first, "ms", System.currentTimeMillis() - t0, "bytes", total));
      } catch (Throwable e) { emit("el", J("id", id, "error", String.valueOf(e))); }
      finally { if (c != null) c.disconnect(); }
    });
  }

  // ------------------------------------------------------------------ JS bridge
  class Bridge {
    @JavascriptInterface public String info() { return J("app", "1.0.12", "cores", Runtime.getRuntime().availableProcessors(), "model", "kokoro-int8-multi-lang-v1_0").toString(); }
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
    @JavascriptInterface public String camInfo() { return J("on", camProvider != null, "frames", camFrames, "photoAge", lastJpeg == null ? -1 : System.currentTimeMillis() - lastJpegAt, "back", camBack, "hi", camHi, "face", faceOn, "err", camErr).toString(); }
    @JavascriptInterface public void say(int id, String text, float rate, float pitch) { main.post(() -> phoneSay(id, text, rate, pitch)); }
    @JavascriptInterface public void http(int id, String url, String method, String headers, String body) { MainActivity.this.http(id, url, method, headers, body); }
    @JavascriptInterface public void elTts(int id, String url, String key, String body) { MainActivity.this.elTts(id, url, key, body); }
    @JavascriptInterface public void httpAbort(int id) { java.net.HttpURLConnection c = conns.remove(id); if (c != null) httpExec.execute(c::disconnect); }
    @JavascriptInterface public void labelStart(int id, boolean back, int maxMs) { main.post(() -> MainActivity.this.labelStart(id, back, maxMs)); }
    @JavascriptInterface public void labelStop(int id) { main.post(() -> { if (labelOn && labelId == id) labelFinish(); }); }
    @JavascriptInterface public String phoneInfo() { return MainActivity.this.phoneInfo(); }
    @JavascriptInterface public void shootStart(boolean video, boolean back) { main.post(() -> MainActivity.this.shootStart(video, back)); }
    @JavascriptInterface public void snapBack(int id) {   // one photo from the BACK camera, then back to front (or off)
      main.post(() -> {
        if (camProvider != null && camBack && lastJpeg != null && System.currentTimeMillis() - lastJpegAt < 1500) { emit("snap", J("id", id, "b64", lastJpeg)); return; }
        snapWanted = id; backOnce = true; lastJpeg = null;
        if (camProvider == null) { MainActivity.this.camStart(); return; }
        try { bind(true, false); camStartedAt = System.currentTimeMillis(); } catch (Exception e) { snapWanted = 0; backOnce = false; emit("snap", J("id", id, "error", String.valueOf(e))); }
      });
    }
    // 1.0.11: share the log as a .txt (Android share sheet) + clipboard copy
    @JavascriptInterface public void shareText(String name, String text) {
      main.post(() -> {
        try { ((android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(android.content.ClipData.newPlainText(name, text)); } catch (Throwable e) {}
        try {
          File d = new File(getCacheDir(), "share"); d.mkdirs(); File f = new File(d, name);
          try (java.io.FileOutputStream o = new java.io.FileOutputStream(f)) { o.write(text.getBytes("UTF-8")); }
          android.net.Uri u = androidx.core.content.FileProvider.getUriForFile(MainActivity.this, "net.swvader.gibson.share", f);
          android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_STREAM, u)
            .putExtra(android.content.Intent.EXTRA_SUBJECT, "Mini Gibson log").addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
          startActivity(android.content.Intent.createChooser(i, "Send Gibson's log"));
        } catch (Throwable e) { emit("share", J("error", String.valueOf(e))); }
      });
    }
    // 1.0.11: reminders / timers via AlarmManager (exact when allowed) + notification
    @JavascriptInterface public String alarmSet(int id, double atMs, String title, String text) {
      if (android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
        main.post(() -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 4));
      android.app.AlarmManager am = (android.app.AlarmManager) getSystemService(ALARM_SERVICE);
      android.app.PendingIntent pi = alarmPi(id, title, text); long at = (long) atMs;
      boolean exact = android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
      try { if (exact) am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, pi); else am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, pi); }
      catch (SecurityException e) { am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, pi); exact = false; }
      AlarmReceiver.saveAlarm(MainActivity.this, id, at, title, text);   // persisted so a reboot can re-schedule it
      return exact ? "exact" : "inexact";
    }
    @JavascriptInterface public void alarmCancel(int id) { ((android.app.AlarmManager) getSystemService(ALARM_SERVICE)).cancel(alarmPi(id, "", "")); AlarmReceiver.removeAlarm(MainActivity.this, id); }
    @JavascriptInterface public void shootText(String t) { main.post(() -> { if (shootLbl != null) shootLbl.setText(t); }); }
    @JavascriptInterface public void shootView(boolean on) { main.post(() -> { if (shootBox != null && shootMode > 0) showBox(on); }); }
    @JavascriptInterface public void shootEnd() { main.post(MainActivity.this::shootEnd); }
    @JavascriptInterface public void takePhoto(int id) { main.post(() -> MainActivity.this.takePhoto(id)); }
    @JavascriptInterface public void recStart(int id, int maxSec) { main.post(() -> MainActivity.this.recStart(id, maxSec)); }
    @JavascriptInterface public void recStop() { main.post(() -> { if (recording != null) recording.stop(); }); }
    @JavascriptInterface public void faceShot(int id, boolean enroll) { main.post(() -> {
      if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) { emit("faceshot", J("id", id, "ok", false, "reason", "nocam")); return; }
      faceWanted = id; faceWantedEnroll = enroll; if (camProvider == null) MainActivity.this.camStart(); else camStartedAt = Math.min(camStartedAt, System.currentTimeMillis() - 300);
    }); }
    @JavascriptInterface public void chatTts(int id, String url, String body, int firstMs) { httpExec.execute(() -> MainActivity.this.chatTts(id, url, body, firstMs)); }
    @JavascriptInterface public String wifiSsid() {
      try { android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE); android.net.wifi.WifiInfo wi = wm.getConnectionInfo(); if (wi == null) return ""; String s = wi.getSSID(); if (s == null) return ""; s = s.replace("\"", ""); return (s.isEmpty() || s.toLowerCase().contains("unknown ssid")) ? "" : s; } catch (Throwable e) { return ""; }
    }
    @JavascriptInterface public String contacts(String q) {
      if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) { main.post(() -> requestPermissions(new String[]{ Manifest.permission.READ_CONTACTS }, 5)); return "[]"; }
      org.json.JSONArray arr = new org.json.JSONArray();
      try { android.net.Uri uri = android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI; String sel = null; String[] args = null;
        if (q != null && !q.trim().isEmpty()) { sel = android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?"; args = new String[]{ "%" + q.trim() + "%" }; }
        android.database.Cursor cur = getContentResolver().query(uri, new String[]{ android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER }, sel, args, android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC");
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        if (cur != null) { while (cur.moveToNext() && arr.length() < 8) { String nm = cur.getString(0), num = cur.getString(1); if (nm == null || num == null) continue; String k = nm.toLowerCase(); if (seen.contains(k)) continue; seen.add(k); arr.put(new JSONObject().put("name", nm).put("number", num)); } cur.close(); }
      } catch (Throwable e) {}
      return arr.toString();
    }
    @JavascriptInterface public String sendSms(String number, String text) {
      if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) { main.post(() -> requestPermissions(new String[]{ Manifest.permission.SEND_SMS }, 6)); return "need SMS permission, I just asked, try again"; }
      try { android.telephony.SmsManager sm = android.telephony.SmsManager.getDefault(); java.util.ArrayList<String> parts = sm.divideMessage(text); sm.sendMultipartTextMessage(number, null, parts, null, null); return "ok"; }
      catch (Throwable e) { return String.valueOf(e.getMessage()); }
    }
    @JavascriptInterface public void call(String number) { main.post(() -> {
      try { if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) { requestPermissions(new String[]{ Manifest.permission.CALL_PHONE }, 7); return; }
        startActivity(new android.content.Intent(android.content.Intent.ACTION_CALL, android.net.Uri.parse("tel:" + number)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try { ((AudioManager) getSystemService(AUDIO_SERVICE)).setSpeakerphoneOn(true); } catch (Throwable e) {}
      } catch (Throwable e) { camErr = "call: " + e; } }); }
    @JavascriptInterface public String recentTexts(int n) {
      if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) { main.post(() -> requestPermissions(new String[]{ Manifest.permission.READ_SMS }, 8)); return "[]"; }
      org.json.JSONArray arr = new org.json.JSONArray();
      try { android.database.Cursor cur = getContentResolver().query(android.net.Uri.parse("content://sms/inbox"), new String[]{ "address", "body", "date" }, null, null, "date DESC");
        if (cur != null) { int c = 0, max = Math.max(1, Math.min(10, n)); while (cur.moveToNext() && c < max) { String addr = cur.getString(0), body = cur.getString(1); arr.put(new JSONObject().put("from", addr == null ? "" : addr).put("name", contactName(addr)).put("body", body == null ? "" : body)); c++; } cur.close(); }
      } catch (Throwable e) {}
      return arr.toString();
    }
    @JavascriptInterface public void authBiometric(int id, String reason) { main.post(() -> {
      try { android.app.KeyguardManager km = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (km == null || !km.isDeviceSecure()) { emit("auth", J("id", id, "ok", false, "error", "no device lock set")); return; }
        android.content.Intent i = km.createConfirmDeviceCredentialIntent("Mini Gibson", reason == null || reason.isEmpty() ? "Verify it's you" : reason);
        if (i == null) { emit("auth", J("id", id, "ok", false, "error", "unavailable")); return; }
        authReqId = id; startActivityForResult(i, 900);
      } catch (Throwable e) { emit("auth", J("id", id, "ok", false, "error", String.valueOf(e))); } }); }
    @JavascriptInterface public void exit() { main.post(MainActivity.this::finish); }
  }
}
