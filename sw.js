// Offline copy of the app. The network is tried first so an update is picked up as soon
// as the phone is online; the saved copy is used when the network is missing or slow.
// Change CACHE whenever the list of files changes.

const CACHE = 'spectroscope-0.1.2';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'js/app.js',
  'js/core.js',
  'js/plot.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let cached = await cache.match(req, { ignoreSearch: true });
    if (!cached && req.mode === 'navigate') cached = await cache.match('index.html');
    const network = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    if (!cached) return network;
    network.catch(() => {});
    const slow = new Promise((resolve) => setTimeout(() => resolve(cached), 2500));
    return Promise.race([network, slow]).catch(() => cached);
  })());
});
