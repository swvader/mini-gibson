// Offline app shell + cross-origin isolation. Bump VERSION when files change. Never touches API calls (other origins).
// GitHub Pages can't send headers, so every same-origin response gets COOP/COEP here (the coi-serviceworker idea, merged
// into this one worker). COEP "credentialless" keeps CORS fetches to Hugging Face, Gemini and Open-Meteo working.
// Only deletes its own old shell caches (gibson-vN); the voice and model caches are kept across updates.
const VERSION = 'gibson-v31';
const SHELL = ['./', './index.html', './app.js', './face.js', './face.css', './manifest.webmanifest', './tts-worker.js', './native.js', './piper-worker.js', './piper-core.js',
  './wake/wake-worker.js', './wake/tap-worklet.js', './wake/hey_gibson.json', './wake/ort.wasm.min.js', './wake/ort.wasm.min.mjs',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => /^gibson-v\d+$/.test(k) && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
function isolate(r) {
  if (!r || r.status === 0 || r.type === 'opaque' || r.type === 'opaqueredirect') return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (e.request.cache === 'only-if-cached' && e.request.mode !== 'same-origin') return;
  // network first (fresh when online), cache fallback (works offline)
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then(ca => ca.put(e.request, c)); } return isolate(r); })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => isolate(r || null) || caches.match('./index.html').then(isolate))));
});
