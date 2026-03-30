const CACHE = 'workout-v1';
const SHELL = ['./palestraV6.html', './manifest.json', './sw.js', './icon.png'];

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
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./palestraV6.html')))
  );
});
