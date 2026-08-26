/* AirsoftMap service worker: app shell + map tile caching for sites with
   no signal. Tiles you have looked at (or explicitly cached) keep working
   offline. */
const SHELL = 'am-shell-v4';
const TILES = 'am-tiles-v1';   // imagery and elevation tiles both live here

const SHELL_FILES = [
  '/', '/index.html',
  '/css/app.css',
  '/js/util.js', '/js/icons.js', '/js/net.js', '/js/pdr.js', '/js/plan.js',
  '/js/terrain.js', '/js/parcels.js', '/js/demo.js', '/js/app.js',
  '/lib/leaflet.js', '/lib/leaflet.css', '/lib/qrcode.js',
  '/print.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

const TILE_HOSTS = [
  'server.arcgisonline.com',
  'tile.opentopomap.org',
  'tile.openstreetmap.org',
  's3.amazonaws.com',            // elevation tiles, so terrain works offline
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* live data never comes from cache */
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  /* map tiles: cache first, then network, and keep whatever we fetch */
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  /* same-origin app shell: serve from cache, refresh in the background */
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(req, { ignoreSearch: true });
        const network = fetch(req)
          .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
          .catch(() => null);
        return hit || (await network) || cache.match('/index.html');
      })
    );
  }
});

/* Let the page ask how much is cached, and clear it. */
self.addEventListener('message', async (event) => {
  const data = event.data || {};
  if (data.t === 'tile-count') {
    const cache = await caches.open(TILES);
    const keys = await cache.keys();
    event.source.postMessage({ t: 'tile-count', count: keys.length });
  }
  if (data.t === 'tile-clear') {
    await caches.delete(TILES);
    event.source.postMessage({ t: 'tile-clear', ok: true });
  }
});
