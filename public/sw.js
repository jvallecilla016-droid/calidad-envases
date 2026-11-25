// Service worker: permite instalar la app y muestra un aviso si no hay señal.
// Los datos siempre se leen y guardan en el servidor central; no se guardan registros en el celular.
const CACHE = 'calidad-v2';
const STATIC = ['/static/style.css', '/static/app.js', '/static/icons/icon-192.png', '/offline.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/static/')) {
    // Archivos estáticos: primero la red, si no hay señal la copia guardada.
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open(CACHE).then((ca) => ca.put(req, c)); return r; }).catch(() => caches.match(req)));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
  }
});
