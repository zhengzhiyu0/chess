// Offline cache + cross-origin isolation headers (needed for SharedArrayBuffer on static hosts
// such as GitHub Pages, which cannot set COOP/COEP themselves).
// Cache name stays fixed so downloaded models survive updates; stale files are pruned per build instead.
const CACHE = 'maia-coach-v1';
// replaced with the build id by vite.config.ts, so every deployment is a byte-different worker
const VERSION = '__BUILD__';

// keep in sync with src/offline.ts: cached copies of files whose URL carries no content hash are
// stamped with their precache.json size, so a changed file (new engine build, new puzzle set) is noticed
const SIZE_HEADER = 'x-precache-size';
const unversioned = (url) => !url.startsWith('assets/') && !/-[0-9a-f]{8}\.bin$/.test(url) && !/(^|\/)$|\.html$|\.webmanifest$|manifest\.json$/.test(url);

self.addEventListener('install', () => self.skipWaiting());

/** href -> size from the deployment's precache.json (null when it can't be fetched) */
let sizes = null;
function manifestSizes() {
  sizes ??= fetch(new URL('precache.json', self.registration.scope).href, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((m) => new Map(m.files.map((f) => [new URL(f.url, self.registration.scope).href, f.size])))
    .catch(() => {
      sizes = null;
      return null;
    });
  return sizes;
}

/**
 * Deletes cached files that the new deployment's precache.json no longer lists (old hashed bundles),
 * and unhashed files whose stamped size no longer matches (or that were never stamped).
 */
async function pruneStale() {
  const keep = await manifestSizes();
  if (!keep) return;
  const scope = self.registration.scope;
  const cache = await caches.open(CACHE);
  for (const req of await cache.keys()) {
    const href = req.url.split('?')[0];
    if (href.endsWith('precache.json')) continue;
    let stale = !keep.has(href);
    if (!stale && unversioned(href.slice(scope.length))) {
      const hit = await cache.match(req);
      stale = hit?.headers.get(SIZE_HEADER) !== String(keep.get(href));
    }
    if (stale) await cache.delete(req);
  }
}

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // only our own caches: other apps may share this origin
      for (const k of await caches.keys()) if (k.startsWith('maia-coach-') && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
      sizes = null;
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

/** On a weak network, the cached copy is served after this long (the network keeps updating the cache). */
const NETWORK_TIMEOUT = 3000;

async function networkFirst(e) {
  const req = e.request;
  // bypass the HTTP cache too, otherwise a stale index.html (old UI) can come back after a reload
  const net = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
  e.waitUntil(
    net
      .then((res) => {
        if (!res.ok) return;
        const copy = res.clone();
        return caches.open(CACHE).then((cache) => cache.put(req.url, copy));
      })
      .catch(() => undefined),
  );
  const cached = caches.open(CACHE).then((cache) => cache.match(req.url, { ignoreSearch: true }));
  const slow = new Promise((r) => setTimeout(r, NETWORK_TIMEOUT)).then(async () => (await cached) || net);
  slow.catch(() => undefined);
  try {
    return await Promise.race([net, slow]);
  } catch {
    return (await cached) || Response.error();
  }
}

/** Streams `res` into the cache; unhashed files are stamped with their manifest size and verified. */
async function store(cache, req, res) {
  const href = req.url.split('?')[0];
  if (!unversioned(href.slice(self.registration.scope.length))) return cache.put(req, res);
  const size = (await manifestSizes())?.get(href);
  // can't vouch for the version of this copy: leave it uncached, the network serves it next time
  if (size === undefined || !res.body) return res.body?.cancel();
  let got = 0;
  const counter = new TransformStream({
    transform(chunk, ctl) {
      got += chunk.byteLength;
      ctl.enqueue(chunk);
    },
  });
  // body is already decoded; drop encoding/length headers so the cached copy stays consistent
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.set(SIZE_HEADER, String(size));
  await cache.put(req, new Response(res.body.pipeThrough(counter), { status: res.status, statusText: res.statusText, headers }));
  // e.g. an HTTP-cached copy from an older deployment
  if (got !== size) await cache.delete(req);
}

async function cacheFirst(e) {
  const req = e.request;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // don't hold the response until it is fully written: large files would sit in memory
  if (res.ok) e.waitUntil(store(cache, req, res.clone()).catch(() => undefined));
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
  e.respondWith((shell ? networkFirst(e) : cacheFirst(e)).then((res) => isolate(res, url)));
});
