// Offline app shell. Bump VERSION when files change. Never touches API calls (other origins).
// Only deletes its own old shell caches (gibson-vN); the neural-voice and model caches are kept across updates.
const VERSION = 'gibson-v15';
const SHELL = ['./', './index.html', './app.js', './face.js', './face.css', './manifest.webmanifest', './tts-worker.js',
  './wake/wake-worker.js', './wake/tap-worklet.js', './wake/hey_gibson.json', './wake/ort.wasm.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => /^gibson-v\d+$/.test(k) && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // network first (fresh when online), cache fallback (works offline)
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then(ca => ca.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
