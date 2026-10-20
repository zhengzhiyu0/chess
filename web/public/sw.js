// Offline cache + cross-origin isolation headers (needed for SharedArrayBuffer on static hosts
// such as GitHub Pages, which cannot set COOP/COEP themselves).
// Cache name stays fixed so downloaded models survive updates; stale files are pruned per build instead.
const CACHE = 'maia-coach-v1';
// replaced with the build id by vite.config.ts, so every deployment is a byte-different worker
const VERSION = '__BUILD__';

self.addEventListener('install', () => self.skipWaiting());

/** Deletes cached files that the new deployment's precache.json no longer lists (old hashed bundles). */
async function pruneStale() {
  let manifest;
  try {
    const res = await fetch(new URL('precache.json', self.registration.scope).href, { cache: 'no-store' });
    if (!res.ok) return;
    manifest = await res.json();
  } catch {
    return;
  }
  const keep = new Set(manifest.files.map((f) => new URL(f.url, self.registration.scope).href));
  const cache = await caches.open(CACHE);
  for (const req of await cache.keys()) {
    const href = req.url.split('?')[0];
    if (href.endsWith('precache.json')) continue;
    if (!keep.has(href)) await cache.delete(req);
  }
}

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
      await pruneStale();
    })(),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'version') e.source?.postMessage({ version: VERSION });
});

// icons/manifest are also fetched by the OS (e.g. iOS "Add to Home Screen"), which is not same-origin;
// CORP same-origin there makes iOS fall back to a letter icon
const PUBLIC_ASSET = /\/icons\/|\.webmanifest$/;

function isolate(res, url) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', PUBLIC_ASSET.test(url.pathname) ? 'cross-origin' : 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // bypass the HTTP cache too, otherwise a stale index.html (old UI) can come back after a reload
    const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
    if (res.ok) await cache.put(req.url, res.clone());
    return res;
  } catch {
    return (await cache.match(req.url, { ignoreSearch: true })) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // the in-app download manager writes to the cache itself
  if (req.cache === 'no-store') {
    e.respondWith(fetch(req).then((res) => isolate(res, url)));
    return;
  }
  const shell = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html') || url.pathname.endsWith('.webmanifest') || url.pathname.endsWith('manifest.json');
  e.respondWith((shell ? networkFirst(req) : cacheFirst(req)).then((res) => isolate(res, url)));
});
