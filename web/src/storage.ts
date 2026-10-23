/** localStorage writes that never throw; a full storage is reported once per session instead of silently losing data. */

let onFull: ((key: string) => void) | null = null;
let warned = false;

export function onStorageFull(cb: (key: string) => void) {
  onFull = cb;
}

export function storageFull(key: string) {
  if (warned) return;
  warned = true;
  onFull?.(key);
}

/** Rebuildable analysis cache (engine/eval-cache.ts): the first thing to give up when storage is full. */
const EVAL_CACHE_KEY = 'maia-coach.evals';

export function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    if (key !== EVAL_CACHE_KEY) {
      try {
        if (localStorage.getItem(EVAL_CACHE_KEY) !== null) {
          localStorage.removeItem(EVAL_CACHE_KEY);
          localStorage.setItem(key, value);
          return true;
        }
      } catch {
        // still full: report below
      }
    }
    console.warn('写入本地存储失败', key, err);
    storageFull(key);
    return false;
  }
}

export function readJson(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
}

export const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
