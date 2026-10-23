// Download manager: puts deployable files into the same Cache Storage the service worker
// serves from, so engines/models are fully local before the first game.
import { MODELS, type ModelId } from './maia/maia';

export const CACHE_NAME = 'maia-coach-v1';

export interface FileEntry {
  url: string;
  size: number;
}

export type PackageId = 'core' | 'stockfish' | 'puzzles' | `maia-${ModelId}`;

export interface Package {
  id: PackageId;
  label: string;
  desc: string;
  files: FileEntry[];
  size: number;
  /** number of files already in cache */
  cached: number;
}

let manifest: { built: number; files: FileEntry[] } | null = null;

export async function loadPrecache(): Promise<boolean> {
  if (manifest) return true;
  try {
    const res = await fetch(new URL('precache.json', document.baseURI).href, { cache: 'no-store' });
    if (!res.ok) return false;
    manifest = await res.json();
    return true;
  } catch {
    return false;
  }
}

function abs(url: string) {
  return new URL(url, document.baseURI).href;
}

// keep in sync with public/sw.js: cached copies of files whose URL carries no content hash
// (engines, puzzles, icons, sounds) are stamped with their precache.json size, so a changed file
// in a new deployment counts as not downloaded instead of being served stale forever
const SIZE_HEADER = 'x-precache-size';
const unversioned = (url: string) =>
  !url.startsWith('assets/') && !/-[0-9a-f]{8}\.bin$/.test(url) && !/(^|\/)$|\.html$|\.webmanifest$|manifest\.json$/.test(url);

/** Whether a cached copy of `f` belongs to this deployment. */
async function current(cache: Cache, req: Request | string, f: FileEntry) {
  if (!unversioned(f.url)) return true;
  const hit = await cache.match(req);
  return hit?.headers.get(SIZE_HEADER) === String(f.size);
}

/** URLs of the manifest files whose cached copy is up to date. */
async function cachedUrls(cache: Cache): Promise<Set<string>> {
  const byUrl = new Map((manifest?.files ?? []).map((f) => [abs(f.url), f]));
  const have = new Set<string>();
  for (const req of await cache.keys()) {
    const f = byUrl.get(req.url);
    if (f && (await current(cache, req, f))) have.add(req.url);
  }
  return have;
}

/** 同时缓存当前版本的单线程后备；多线程初始化失败时仍可离线使用。 */
function stockfishVariant(url: string, lite: boolean) {
  return url.includes('-lite') === lite && (self.crossOriginIsolated || url.includes('-single'));
}

export async function listPackages(sfLite: boolean): Promise<Package[]> {
  if (!manifest) return [];
  const cache = await caches.open(CACHE_NAME);
  const have = await cachedUrls(cache);
  const groups: Record<string, FileEntry[]> = { core: [], stockfish: [], puzzles: [], 'maia-5m': [], 'maia-23m': [], 'maia-79m': [] };
  for (const f of manifest.files) {
    const m = /^models\/maia3-(\w+)\//.exec(f.url);
    if (m) groups[`maia-${m[1]}`]?.push(f);
    else if (f.url.startsWith('puzzles/')) groups.puzzles.push(f);
    else if (f.url.startsWith('engines/')) {
      if (stockfishVariant(f.url, sfLite)) groups.stockfish.push(f);
    } else groups.core.push(f);
  }
  const meta: Record<string, { label: string; desc: string }> = {
    core: { label: '应用本体', desc: '界面 + Maia 推理运行时（离线必需）' },
    puzzles: { label: '谜题库', desc: '50000 道 Lichess 谜题（CC0），离线做题' },
    stockfish: {
      label: sfLite ? 'Stockfish 19 轻量版' : 'Stockfish 19',
      desc: `${sfLite ? '小型 NNUE' : '完整 NNUE'}，${self.crossOriginIsolated ? '多线程版 + 单线程后备' : '单线程版'}`,
    },
  };
  for (const id of Object.keys(MODELS) as ModelId[]) {
    meta[`maia-${id}`] = { label: MODELS[id].label, desc: '拟人化对手 / 人类着法预测' };
  }
  return Object.entries(groups).map(([id, files]) => ({
    id: id as PackageId,
    ...meta[id],
    files,
    size: files.reduce((a, f) => a + f.size, 0),
    cached: files.filter((f) => have.has(abs(f.url))).length,
  }));
}

export function isComplete(p: Package) {
  return p.files.length > 0 && p.cached === p.files.length;
}

async function fetchInto(cache: Cache, f: FileEntry, signal: AbortSignal, onBytes: (n: number) => void) {
  const res = await fetch(abs(f.url), { cache: 'no-store', signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${f.url}`);
  let got = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      got += chunk.byteLength;
      onBytes(chunk.byteLength);
      ctl.enqueue(chunk);
    },
  });
  // stream straight into Cache Storage so large files are never buffered in memory
  // body is already decoded; drop encoding/length headers so the cached copy stays consistent
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  if (unversioned(f.url)) headers.set(SIZE_HEADER, String(f.size));
  await cache.put(abs(f.url), new Response(res.body.pipeThrough(counter), { status: 200, headers }));
  const exact = f.size > 0 && !f.url.endsWith('.html') && !f.url.endsWith('/');
  if (exact && got !== f.size) {
    await cache.delete(abs(f.url));
    throw new Error(`文件不完整：${f.url}`);
  }
}

export async function downloadPackage(
  p: Package,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  const have = await cachedUrls(cache);
  let loaded = p.files.filter((f) => have.has(abs(f.url))).reduce((a, f) => a + f.size, 0);
  onProgress(loaded, p.size);
  for (const f of p.files) {
    if (have.has(abs(f.url))) continue;
    for (let attempt = 0; ; attempt++) {
      let part = 0;
      try {
        await fetchInto(cache, f, signal, (n) => {
          part += n;
          onProgress(loaded + part, p.size);
        });
        break;
      } catch (err) {
        if (signal.aborted || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    loaded += f.size;
    onProgress(loaded, p.size);
  }
}

export async function deletePackage(p: Package) {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(p.files.map((f) => cache.delete(abs(f.url))));
}

/** Drops cached files from older builds that are no longer part of the deployment, or changed since. */
export async function pruneStale(): Promise<number> {
  if (!manifest) return 0;
  const keep = new Map(manifest.files.map((f) => [abs(f.url), f]));
  const cache = await caches.open(CACHE_NAME);
  let n = 0;
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    if (u.pathname.endsWith('precache.json')) continue;
    const f = keep.get(u.href.split('?')[0]) ?? keep.get(u.href);
    if (!f || !(await current(cache, req, f))) {
      await cache.delete(req);
      n++;
    }
  }
  return n;
}

export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageInfo(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted };
}

export function fmtMB(bytes: number) {
  return bytes >= 1048576 * 10 ? `${(bytes / 1048576).toFixed(0)}MB` : `${(bytes / 1048576).toFixed(1)}MB`;
}
