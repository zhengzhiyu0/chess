// Vite injects this tiny adapter into engine modules at build time. It gives
// Flutter ownership of workers *while create() is pending*, before the original
// classes expose their instance. Source modules in web/src are never changed.
type Kind = 'maia' | 'stockfish';
const starts = new Map<{ dispose(): void }, Kind>();
let paused = false;

export function trackEngineStart(engine: { dispose(): void }, kind: Kind = 'maia') {
  if (paused) { engine.dispose(); return; }
  starts.set(engine, kind);
}
export function finishEngineStart(engine: { dispose(): void }) { starts.delete(engine); }
export function cancelEngineStarts(kind?: Kind) {
  for (const [engine, type] of starts) {
    if (kind === undefined || kind === type) { starts.delete(engine); engine.dispose(); }
  }
}
export function pauseEngineStarts() { paused = true; cancelEngineStarts(); }
export function resumeEngineStarts() { paused = false; }
