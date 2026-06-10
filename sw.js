const CACHE = 'workout-v7-debug-fixes';
const SHELL = ['./', './index.html', './manifest.json', './icon.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  // Niente skipWaiting: il nuovo SW aspetta la prossima apertura
  // così evita reload forzati mentre l'app è in uso
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  // Niente clients.claim(): evita il flash/ricarica alla prima attivazione
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  // Cross-origin: passa solo per i font (cache-first sotto), il resto bypassa
  if (url.origin !== self.location.origin && !FONT_HOSTS.includes(url.hostname)) return;

  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          // Mai sovrascrivere lo shell con 404/500/redirect/captive portal:
          // offline verrebbe servita quella pagina al posto dell'app
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then(c => c.put('./index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return response;
      }).catch(() => Response.error())
    )
  );
});
