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
(app / 'face.css').write_text('/* generated from gibson-face/index.html by tools/build.py */\n' + css)
(app / 'face.js').write_text('/* generated from gibson-face/index.html by tools/build.py */\n' + js)
print('face.js', len(js), 'face.css', len(css))
