// The offline copy (spec 3.1). The first visit keeps every site file in a cache named for the version;
// after that the scorer opens and works with no signal. Each publish changes VERSION (it must match
// version.js; test/version.test.mjs checks), so the browser sees a new worker, which installs beside the
// old one and WAITS. It takes over only when the page posts 'skipWaiting' (the Reload button on "Update
// ready: reload when the match is over"), so a match is never reloaded out from under the scorer.

const VERSION = '1.2.0';
const CACHE = `scorer-${VERSION}`;

// Every file the page loads. test/version.test.mjs fails if a file in site/ is missing from this list, or
// if the list names a file that is not there (one missing file would stop the whole install).
const FILES = [
  './',
  './index.html',
  './app.js',
  './clock.js',
  './dom.js',
  './engine.js',
  './files.js',
  './history.js',
  './keys.js',
  './presets.js',
  './sound.js',
  './storage.js',
  './version.js',
  './view-board.js',
  './view-common.js',
  './view-editor.js',
  './view-score.js',
  './view-setup.js',
  './view-sheet.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './README.md',
];

self.addEventListener('install', event => {
  // No skipWaiting() here: a new version waits for the person's go-ahead. (On the very first visit there is
  // no old worker, so this one activates straight away.)
  // cache: 'reload' goes to the network, not the browser's own copy (which a host may let stay fresh for minutes),
  // so a new version never keeps last version's files.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(url => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('scorer-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// The page's Reload button posts { type: 'skipWaiting' } (the bare word is taken too).
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting' || event.data?.type === 'skipWaiting') self.skipWaiting();
});

// Cache first, then the network. A page address that is not in the cache (the folder's address with a
// query on the end, say) opens the kept index.html rather than an offline error.
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const kept = await cache.match(request, { ignoreSearch: true });
    if (kept) return kept;
    try {
      return await fetch(request);
    } catch (error) {
      if (request.mode === 'navigate') {
        const page = await cache.match('./index.html');
        if (page) return page;
      }
      throw error;
    }
  })());
});
