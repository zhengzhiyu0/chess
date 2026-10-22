import type { SfLine } from './stockfish';

/** A finished single-PV evaluation of one position. */
export interface CachedEval {
  line: SfLine | null;
  best: string | null;
}

const KEY = 'maia-coach.evals';
/** ~150 bytes each: a few hundred games' worth of positions in well under 1MB */
const CAP = 4000;
const PV_KEEP = 12;

let map: Map<string, CachedEval> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function load(): Map<string, CachedEval> {
  if (map) return map;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    map = new Map(Array.isArray(v) ? v : []);
  } catch {
    map = new Map();
  }
  return map;
}

/**
 * Persistent position → evaluation cache, so reviewing a game (again, or after an app restart)
 * reuses the searches already done while playing and in earlier reviews instead of re-running them.
 */
export function getEval(key: string): CachedEval | undefined {
  return load().get(key);
}

export function putEval(key: string, v: CachedEval) {
  const m = load();
  const line = v.line && v.line.pv.length > PV_KEEP ? { ...v.line, pv: v.line.pv.slice(0, PV_KEEP) } : v.line;
  m.delete(key);
  m.set(key, { line, best: v.best });
  // Map keeps insertion order: drop the oldest entries
  for (const k of m.keys()) {
    if (m.size <= CAP) break;
    m.delete(k);
  }
  timer ??= setTimeout(flushEvals, 3000);
}

export function flushEvals() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!map) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([...map]));
  } catch (err) {
    console.warn('保存分析缓存失败', err);
    // quota: keep the newest half
    map = new Map([...map].slice(Math.floor(map.size / 2)));
    try {
      localStorage.setItem(KEY, JSON.stringify([...map]));
    } catch {
      /* give up */
    }
  }
}
