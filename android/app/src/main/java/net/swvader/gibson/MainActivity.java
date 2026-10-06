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
  SpeechRecognizer sr; boolean srWanted, srContinuous, srQuiet = true, srHadResult; String srLang = "en-US"; int srRestarts;
  final List<String> srFinals = new ArrayList<>();
  AudioManager am; boolean muted;
  ProcessCameraProvider camProvider; FaceDetector faceDet; volatile boolean faceBusy; volatile int snapWanted = 0; long lastFaceSent, lastFaceSeen;

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
  @Override protected void onDestroy() { super.onDestroy(); if (sr != null) sr.destroy(); unmute(); if (tts != null) tts.release(); }
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
    if (srWanted && srContinuous && srRestarts < 30 && (srHadResult || error == null) && !"not-allowed".equals(error) && !"network".equals(error) && !"audio-capture".equals(error)) {
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
    public void onReadyForSpeech(Bundle p) { if (srRestarts == 0) emit("sr", J("type", "start")); }
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
        case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: if (sr != null) { sr.destroy(); sr = null; } m = "aborted"; break;
        default: m = "aborted";
      }
      if (!srWanted) { main.postDelayed(unmuteR, 400); return; }
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
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) { emit("cam", J("error", "camera permission")); return; }
    faceDet = FaceDetection.getClient(new FaceDetectorOptions.Builder().setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST).setMinFaceSize(0.12f).build());
    ListenableFuture<ProcessCameraProvider> f = ProcessCameraProvider.getInstance(this);
    f.addListener(() -> {
      try {
        camProvider = f.get();
        ImageAnalysis an = new ImageAnalysis.Builder().setTargetResolution(new android.util.Size(640, 480))
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888).build();
        an.setAnalyzer(camExec, this::analyze);
        CameraSelector sel = camProvider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) ? CameraSelector.DEFAULT_FRONT_CAMERA : CameraSelector.DEFAULT_BACK_CAMERA;
        camProvider.unbindAll(); camProvider.bindToLifecycle(this, sel, an);
        emit("cam", J("on", true));
      } catch (Exception e) { camProvider = null; emit("cam", J("error", String.valueOf(e))); }
    }, ContextCompat.getMainExecutor(this));
  }
  void camStop() { if (camProvider != null) { camProvider.unbindAll(); camProvider = null; } emit("cam", J("on", false)); }
  void analyze(ImageProxy img) {
    int rot = img.getImageInfo().getRotationDegrees();
    if (snapWanted > 0) {
      int id = snapWanted; snapWanted = 0;
      try {
        Bitmap bm = img.toBitmap(); Matrix mx = new Matrix(); mx.postRotate(rot);
        float sc = 768f / Math.max(bm.getWidth(), bm.getHeight()); if (sc < 1) mx.postScale(sc, sc);
        Bitmap out = Bitmap.createBitmap(bm, 0, 0, bm.getWidth(), bm.getHeight(), mx, true);
        ByteArrayOutputStream bo = new ByteArrayOutputStream(); out.compress(Bitmap.CompressFormat.JPEG, 80, bo);
        emit("snap", J("id", id, "b64", Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP)));
      } catch (Throwable e) { emit("snap", J("id", id, "error", String.valueOf(e))); }
    }
    long now = System.currentTimeMillis();
    if (faceBusy || now - lastFaceSent < 90) { img.close(); return; }
    faceBusy = true;
    final int w = (rot % 180 == 0) ? img.getWidth() : img.getHeight(), h = (rot % 180 == 0) ? img.getHeight() : img.getWidth();
    Bitmap bm;
    try { bm = img.toBitmap(); } catch (Throwable e) { faceBusy = false; img.close(); return; }
    img.close();
    faceDet.process(InputImage.fromBitmap(bm, rot)).addOnSuccessListener(faces -> {
      long t = System.currentTimeMillis(); lastFaceSent = t;
      Face best = null; for (Face fc : faces) if (best == null || fc.getBoundingBox().width() > best.getBoundingBox().width()) best = fc;
      if (best != null) {
        Rect r = best.getBoundingBox(); lastFaceSeen = t;
        double x = -((r.centerX() / (double) w) * 2 - 1), y = (r.centerY() / (double) h) * 2 - 1;   // front camera is mirrored: his left is our right
        emit("face", J("x", Math.round(x * 100) / 100.0, "y", Math.round(y * 100) / 100.0, "s", Math.round(100.0 * r.width() / w) / 100.0));
      } else if (t - lastFaceSeen > 1200 && lastFaceSeen != 0) { lastFaceSeen = 0; emit("face", J("none", true)); }
    }).addOnCompleteListener(x -> faceBusy = false);
  }

  // ------------------------------------------------------------------ JS bridge
  class Bridge {
    @JavascriptInterface public String info() { return J("app", "1.0.0", "cores", Runtime.getRuntime().availableProcessors(), "model", "kokoro-int8-multi-lang-v1_0").toString(); }
    @JavascriptInterface public void ttsInit() { ttsExec.execute(MainActivity.this::ttsLoad); }
    @JavascriptInterface public void tts(int id, String text, int sid, float speed) { ttsExec.execute(() -> { if (tts == null) ttsLoad(); ttsGen(id, text, sid, speed); }); }
    @JavascriptInterface public void srStart(String lang, boolean continuous, boolean quiet) {
      main.post(() -> { srLang = lang == null || lang.isEmpty() ? "en-US" : lang; srContinuous = continuous; srQuiet = quiet; srWanted = true; srHadResult = false; srRestarts = 0; srFinals.clear();
        if (sr != null) { sr.destroy(); sr = null; } srBegin(); });   // fresh recognizer: no stale callbacks from the last session
    }
    @JavascriptInterface public void srStop() { main.post(() -> { boolean was = srWanted; srWanted = false; if (sr != null) sr.cancel(); main.postDelayed(unmuteR, 400); if (was) emit("sr", J("type", "end")); }); }
    @JavascriptInterface public void srAbort() { main.post(() -> { srWanted = false; if (sr != null) sr.cancel(); main.postDelayed(unmuteR, 400); }); }
    @JavascriptInterface public void camStart() { main.post(MainActivity.this::camStart); }
    @JavascriptInterface public void camStop() { main.post(MainActivity.this::camStop); }
    @JavascriptInterface public void snap(int id) { main.post(() -> { if (camProvider == null) camStart(); snapWanted = id; }); }
    @JavascriptInterface public void exit() { main.post(MainActivity.this::finish); }
  }
}
