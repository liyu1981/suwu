// Suwu's service worker — deliberately tiny.
//
// The only thing worth caching is the Vite build output under /assets/: those
// names contain a content hash, so a cached copy can never be stale. Everything
// else is left to the network, untouched:
//
//   /api/*    — a cached API response would show yesterday's files
//   /ws/*     — WebSockets must not go through a worker at all
//   /mobile   — a cached shell would boot an old build against a new server
//   /         — same: the entry document must always come from the server
//
// Caching the entry document is how PWAs get stuck on an old version, and a
// terminal that reconnects to a server it does not match is not a good trade for
// a faster start.
const CACHE = 'suwu-assets-v1';
// Hashed build output only. The query is ignored on purpose: Vite never puts a
// meaningful query on a hashed asset.
const CACHEABLE = /^\/assets\/[^/]+\.(?:js|mjs|css|woff2?|png|webp|svg|wasm)$/;
// Bound the cache: hashed names change on every deploy and the old ones would
// otherwise accumulate forever.
const MAX_ENTRIES = 80;

self.addEventListener('install', () => {
  // A new worker takes over immediately; there is no state to migrate.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !CACHEABLE.test(url.pathname)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;

      const response = await fetch(request);
      if (response.ok) {
        await cache.put(request, response.clone());
        const keys = await cache.keys();
        if (keys.length > MAX_ENTRIES) {
          await Promise.all(keys.slice(0, keys.length - MAX_ENTRIES).map((k) => cache.delete(k)));
        }
      }
      return response;
    })(),
  );
});
