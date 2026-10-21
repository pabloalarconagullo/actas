// Caché de la aplicación para que abra sin conexión (grabar funciona offline;
// transcribir necesita el modelo ya descargado y el acta necesita internet).
const VERSION = 'actas-v1';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'icon.svg',
  'manifest.webmanifest',
  'js/app.js',
  'js/store.js',
  'js/ai.js',
  'js/recorder.js',
  'js/transcribe.js',
  'js/whisper-worker.js',
  'js/export.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Primero la red (para ver siempre la última versión); si no hay conexión, la caché
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
