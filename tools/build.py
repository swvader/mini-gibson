# Extracts the face engine (CSS + JS) from ../gibson-face/index.html into face.css / face.js.
# The original file is never modified. Re-run after editing the face.
import re, pathlib
src = pathlib.Path('/workspace/gibson-face/index.html').read_text()
app = pathlib.Path('/workspace/gibson-app')
css = re.search(r'<style>(.*?)</style>', src, re.S).group(1)
js = re.search(r'<script>(.*?)</script>', src, re.S).group(1)
# in the app, the top-left corner is not a debug hotspot (taps = talk); debug stays reachable from settings and the 'd' key
old = "addEventListener('pointerdown', e => {   // tap the top-left corner to toggle the debug panel\n"
assert old in js
js = js.replace(old, old + "  if (window.GIBSON_APP) return;\n")
# app-only hook: optional frame-rate cap (the app caps at 30 fps while a voice is being generated, so the face never
# fights the voice for the phone's CPU/GPU). autoQuality judges speed against the cap while capped.
for a, b in [("let last = performance.now(), fpsAcc = 0, fpsN = 0;\n", "let last = performance.now(), fpsAcc = 0, fpsN = 0, FPS_CAP = 0, lastDraw = 0, blurTick = 0;\n"),
             ("  if (S.manual) return;\n  const dt", "  if (S.manual) return;\n  if (FPS_CAP && now - lastDraw < 1000 / FPS_CAP - 4) return;\n  lastDraw = now;\n  const dt"),
             ("  if (!CFG.autoQuality || document.hidden || S.t < 3) return;\n  slowN = S.fps < 48 ? slowN + 1 : 0;", "  if (!CFG.autoQuality || document.hidden || S.t < 3) return;\n  slowN = S.fps < (FPS_CAP ? FPS_CAP * .8 : 48) ? slowN + 1 : 0;   // while capped, 'slow' means below the cap"),
             ("  bactx.clearRect(0, 0, bA.width, bA.height); bbctx.clearRect(0, 0, bB.width, bB.height);\n  if (FILTER_OK) {\n    bactx.filter = `blur(${rA.toFixed(2)}px)`; bactx.drawImage(bSrc, 0, 0); bactx.filter = 'none';\n",
              "  const skipA = FPS_CAP && (++blurTick & 1);   // while capped: refresh the full-size bloom every other frame (soft glow, not visible)\n  if (!skipA) bactx.clearRect(0, 0, bA.width, bA.height); bbctx.clearRect(0, 0, bB.width, bB.height);\n  if (FILTER_OK) {\n    if (!skipA) { bactx.filter = `blur(${rA.toFixed(2)}px)`; bactx.drawImage(bSrc, 0, 0); bactx.filter = 'none'; }\n"),
             ("  config, receive, debug: toggleDebug,", "  config, receive, debug: toggleDebug,\n  setFpsCap: n => { FPS_CAP = Math.max(0, +n || 0); fpsAcc = 0; fpsN = 0; },")]:
    assert js.count(a) == 1, a
    js = js.replace(a, b)
# app cool-down (v1.0.6): behaviour updates every frame (cheap), but the canvas is only redrawn at a cap:
# ~22 fps when idle and calm, ~12 fps when only the slow drift moves (no blink, gaze settled), MAX_FPS otherwise (60 on 120 Hz phones)
for a, b in [("FPS_CAP = 0, lastDraw = 0, blurTick = 0;\n", "FPS_CAP = 0, IDLE_CAP = 0, MAX_FPS = 0, lastDraw = 0, blurTick = 0, capAcc = 0;\n"
              "function calmCap() {\n"
              "  if (!IDLE_CAP || !S.idleOn || S.demo || S.trans || S.talk || S.mouth.k > .02 || S.glitch.amt > 0 || S.P['fx.think'] > .01 || S.P['fx.listen'] > .01 || S.listenLevel > .02) return 0;\n"
              "  const moving = S.blinkVal > 0 || S.t - S.blinkStart < S.blinkDur + .08 || Math.abs(S.gx - (S.rgx || 0)) > .01 || Math.abs(S.gy - (S.rgy || 0)) > .01;\n"
              "  return moving ? IDLE_CAP : Math.max(8, Math.round(IDLE_CAP * .55));\n"
              "}\n"),
             ("  if (S.manual) return;\n  if (FPS_CAP && now - lastDraw < 1000 / FPS_CAP - 4) return;\n  lastDraw = now;\n  const dt = Math.min(.05, Math.max(0, (now - last) / 1000)); last = now;\n  update(dt); render();\n  fpsAcc += dt; fpsN++;\n  if (fpsAcc > .5) { S.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; autoQuality();",
              "  if (S.manual) return;\n  const dt = Math.min(.05, Math.max(0, (now - last) / 1000)); last = now;\n  update(dt);\n  const cap = FPS_CAP || calmCap() || MAX_FPS;\n  if (cap && now - lastDraw < 1000 / cap - 4) return;\n  const fdt = Math.min(.25, Math.max(0, (now - lastDraw) / 1000)); lastDraw = now;\n  render(); S.rgx = S.gx; S.rgy = S.gy;\n  fpsAcc += fdt; fpsN++; capAcc += cap || 60;\n  if (fpsAcc > .5) { const want = capAcc / fpsN; S.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; capAcc = 0; autoQuality(want);"),
             ("function autoQuality() {", "function autoQuality(want) {"),
             ("slowN = S.fps < (FPS_CAP ? FPS_CAP * .8 : 48) ? slowN + 1 : 0;", "slowN = S.fps < Math.min(48, (want || 60) * .8) ? slowN + 1 : 0;"),
             ("  setFpsCap: n => { FPS_CAP = Math.max(0, +n || 0); fpsAcc = 0; fpsN = 0; },", "  setFpsCap: n => { FPS_CAP = Math.max(0, +n || 0); fpsAcc = 0; fpsN = 0; capAcc = 0; },\n  setIdleCap: n => { IDLE_CAP = Math.max(0, +n || 0); }, setMaxFps: n => { MAX_FPS = Math.max(0, +n || 0); },")]:
    assert js.count(a) == 1, a
    js = js.replace(a, b)
(app / 'face.css').write_text('/* generated from gibson-face/index.html by tools/build.py */\n' + css)
(app / 'face.js').write_text('/* generated from gibson-face/index.html by tools/build.py */\n' + js)
print('face.js', len(js), 'face.css', len(css))
