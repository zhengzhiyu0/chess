import type { SfLine } from '../engine/stockfish';
import { isObj } from '../storage';
import type { GameTree } from './tree';

export interface SavedAnalysis {
  signature: string;
  positions: { path: number[]; line: SfLine | null; best: string | null }[];
}
const move = (value: unknown): value is string => typeof value === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value);

/** Keep only completed primary evaluations; never persist live streams or Maia tensors. */
export function captureAnalysis<A extends { eval: { lines: SfLine[]; best: string | null } }>(tree: GameTree<A>, signature: string): SavedAnalysis {
  const positions: SavedAnalysis['positions'] = [];
  for (const node of tree.nodes()) {
    if (!node.a.eval || positions.length >= 1024) continue;
    const line = node.a.eval.lines[0];
    positions.push({ path: tree.pathTo(node).slice(1).map(n => n.parent!.children.indexOf(n)),
      line: line ? { ...line, pv: line.pv.slice(0, 12) } : null, best: node.a.eval.best });
  }
  return { signature, positions };
}

export function sanitizeAnalysis(raw: unknown): SavedAnalysis | undefined {
  if (!isObj(raw) || typeof raw.signature !== 'string' || raw.signature.length > 64 || !Array.isArray(raw.positions)) return;
  const positions: SavedAnalysis['positions'] = [];
  for (const entry of raw.positions.slice(0, 1024)) {
    if (!isObj(entry) || !Array.isArray(entry.path) || entry.path.length > 512
      || !entry.path.every(i => Number.isInteger(i) && i >= 0 && i < 256) || (entry.best !== null && !move(entry.best))) continue;
    let line: SfLine | null = null;
    if (entry.line !== null) {
      const r = entry.line;
      if (!isObj(r) || !Number.isInteger(r.depth) || (r.depth as number) < 0 || (r.depth as number) > 256
        || !Array.isArray(r.pv) || !r.pv.length || !r.pv.every(move)
        || !(typeof r.cp === 'number' && Number.isFinite(r.cp) || typeof r.mate === 'number' && Number.isFinite(r.mate))) continue;
      line = { multipv: 1, depth: r.depth as number, pv: r.pv.slice(0, 12),
        ...(typeof r.cp === 'number' && Number.isFinite(r.cp) ? { cp: r.cp } : {}),
        ...(typeof r.mate === 'number' && Number.isFinite(r.mate) ? { mate: r.mate } : {}) };
      if (r.bound === 'lowerbound' || r.bound === 'upperbound') line.bound = r.bound;
      if (Array.isArray(r.wdl) && r.wdl.length === 3 && r.wdl.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000)) line.wdl = r.wdl as [number, number, number];
    }
    positions.push({ path: entry.path, line, best: entry.best });
  }
  return { signature: raw.signature, positions };
}

export function restoreAnalysis<A extends object>(tree: GameTree<A>, saved: SavedAnalysis | undefined, signature: string,
  apply: (node: import('./tree').GNode<A>, lines: SfLine[], best: string | null) => void) {
  if (!saved || saved.signature !== signature) return;
  for (const entry of saved.positions) {
    let node = tree.root;
    let valid = true;
    for (const index of entry.path) {
      const child = node.children[index];
      if (!child) { valid = false; break; }
      node = child;
    }
    if (valid) apply(node, entry.line ? [entry.line] : [], entry.best);
  }
}
