importScripts('./version.js');

const CACHE = `hobby-planner-${self.APP_VERSION}-${self.APP_BUILD}`;
const ASSETS = [
  './',
  './index.html',
  './version.js',
  './manifest.webmanifest',
  './css/app.css',
  './js/boot.js',
  './js/app.js',
  './js/db.js',
  './js/model.js',
  './js/ui.js',
  './js/icons.js',
  './js/icons-lucide.js',
  './js/sync.js',
  './js/google-token.js',
  './js/drive-files.js',
  './js/bot-key.js',
  './js/drive.js',
  './js/changes.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/shortcut-today.png',
  './icons/shortcut-plan.png',
  './icons/shortcut-week.png',
  './icons/shortcut-quick.png',
  './icons/author.jpg',
];

// Файли — повз HTTP-кеш браузера: GitHub Pages віддає max-age=600,
// і без reload оновлення ще 10 хвилин ставило б старі файли.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Лише свої старі версії: на vitaliylobko.github.io поруч живуть shooting-log і weight-log зі своїми кешами
    await Promise.all(keys.filter((k) => k.startsWith('hobby-planner-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  // Сторінка питає номер у нового worker, що чекає, — щоб показати версію ще до оновлення
  if (event.data === 'version') event.ports[0]?.postMessage({ version: self.APP_VERSION, build: self.APP_BUILD });
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch (err) {
      if (request.mode === 'navigate') return caches.match('./index.html');
      throw err;
    }
  })());
});
