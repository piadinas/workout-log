const CACHE = 'ledger-workout-v9-instant';
const LEGACY_CACHES = new Set([
  'workout-v8-daylight',
  'workout-v7-debug-fixes',
  'workout-v7',
]);
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const SCOPE_URL = new URL(self.registration.scope);
const INDEX_URL = new URL('index.html', SCOPE_URL).href;
const PRECACHE_URLS = [
  INDEX_URL,
  new URL('manifest.json', SCOPE_URL).href,
  new URL('icon.png', SCOPE_URL).href,
];

function isCanonicalDocument(url) {
  return url.origin === SCOPE_URL.origin &&
    (url.pathname === SCOPE_URL.pathname || url.pathname === new URL(INDEX_URL).pathname);
}

async function fetchFreshShell() {
  const response = await fetch(new Request(INDEX_URL, {
    cache: 'no-cache',
    credentials: 'same-origin',
  }));
  const finalUrl = new URL(response.url);
  if (!response.ok || response.type !== 'basic' || response.redirected || !isCanonicalDocument(finalUrl)) {
    throw new Error('Risposta shell non valida');
  }
  const cache = await caches.open(CACHE);
  await cache.put(INDEX_URL, response.clone());
  return response;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE_URLS.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key !== CACHE && (LEGACY_CACHES.has(key) || key.startsWith('ledger-workout-')))
      .map(key => caches.delete(key)));
  })());
  // Niente clients.claim(): l'apertura corrente non viene ricaricata a meta' input.
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const isDocument = request.mode === 'navigate' || request.destination === 'document';

  if (isDocument) {
    // Solo la root dell'app e index.html sono la shell. Audit, archivi o pagine
    // legacy non possono piu' avvelenare il fallback offline.
    if (!isCanonicalDocument(url)) return;

    const refresh = fetchFreshShell();
    event.waitUntil(refresh.catch(() => undefined));
    event.respondWith((async () => {
      const shellCache = await caches.open(CACHE);
      const cached = await shellCache.match(INDEX_URL);
      if (cached) return cached;
      try {
        return await refresh;
      } catch {
        return new Response('Ledger non e ancora disponibile offline.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  const cacheableOrigin = url.origin === SCOPE_URL.origin || FONT_HOSTS.has(url.hostname);
  if (!cacheableOrigin) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok || response.type === 'opaque') {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
