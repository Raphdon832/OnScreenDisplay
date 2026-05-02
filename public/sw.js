const STATIC_CACHE = 'onscreen-signage-static-v6';
const MEDIA_CACHE = 'onscreen-signage-media-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/about.html',
  '/marketing.css',
  '/display.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('onscreen-signage-static-') && key !== STATIC_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.pathname.startsWith('/media/')) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE));
    return;
  }

  if (
    url.pathname === '/control.html' ||
    url.pathname === '/login.html' ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  if (url.pathname.startsWith('/socket.io/') && !url.pathname.endsWith('/socket.io.js')) {
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;

    if (request.mode === 'navigate') {
      return cache.match('/display.html');
    }

    throw err;
  }
}
