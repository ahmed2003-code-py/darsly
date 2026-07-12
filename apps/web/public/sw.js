// Minimal, safe service worker: network-first for navigations & static assets
// with a cache fallback for offline; never touches /api.
//
// CACHE is build-stamped (see main.tsx registration ?v=) so a new deploy evicts
// the previous build's cache in `activate` — offline users never get stuck on a
// stale index.html. The HTML fallback is applied ONLY to navigations, never to
// asset (script/style/image) requests: returning index.html for a failed .js
// request would make the browser parse HTML as JavaScript and hard-crash.
const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `darsly-${VERSION}`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Only fall back to the app shell for page navigations.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
