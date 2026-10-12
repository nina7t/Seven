const CACHE_NAME = 'sevenz-v3';
const ASSETS = [
  '/index.html',
  '/config.js',
  '/manifest.json',
  '/logo-sevenz-sfond.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    // Un par un : config.js n'est pas versionné et peut manquer ; addAll
    // échouait alors en entier et le service worker ne s'installait jamais.
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(ASSETS.map(url => cache.add(url))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Seulement nos propres GET : proxy, Firebase, YouTube et POST passent tout droit.
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then(r => r || Response.error()))
  );
});
