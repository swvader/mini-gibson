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
(app / 'face.css').write_text('/* generated from gibson-face/index.html by tools/build.py */\n' + css)
(app / 'face.js').write_text('/* generated from gibson-face/index.html by tools/build.py */\n' + js)
print('face.js', len(js), 'face.css', len(css))
