import { Chess } from 'chess.js';
import { toMove } from './rules';

/** Serialized node: uci, children, comment, NAGs, clock snapshot [white ms, black ms], exploration flag. */
export interface SNode {
  u?: string;
  c?: SNode[];
  t?: string;
  n?: number[];
  k?: [number, number];
  x?: 1;
}

export interface GNode<A extends object = object> {
  id: number;
  ply: number;
  fen: string;
  /** move that led here ('' at the root) */
  uci: string;
  san: string;
  parent: GNode<A> | null;
  /** children[0] is the main continuation, the rest are variations; exploration children always come last */
  children: GNode<A>[];
  comment?: string;
  nags?: number[];
  /** remaining clock times [white, black] in ms right after this position arose */
  clock?: [number, number];
  /** added while exploring in analysis: never part of the game record */
  x?: boolean;
  /** analysis cache, never serialized */
  a: Partial<A>;
}

/** Main continuation of `n`; a real position never continues into an exploration. */
export function mainChild<A extends object>(n: GNode<A>): GNode<A> | undefined {
  const c = n.children[0];
  return c && (!c.x || n.x) ? c : undefined;
}

export class GameTree<A extends object = object> {
  readonly root: GNode<A>;
  private nextId = 1;

  constructor(readonly startFen: string) {
    this.root = { id: 0, ply: 0, fen: new Chess(startFen).fen(), uci: '', san: '', parent: null, children: [], a: {} };
  }

  /**
   * Plays `uci` from `parent`; reuses an existing child with the same move. Returns null if illegal.
   * `explore` marks new nodes as analysis explorations; real moves are kept ahead of them.
   */
  add(parent: GNode<A>, uci: string, explore = false): GNode<A> | null {
    const sib = parent.children;
    const same = sib.find((c) => c.uci === uci);
    if (same) {
      if (!explore && same.x) {
        same.x = false;
        sib.splice(sib.indexOf(same), 1);
        this.insertReal(sib, same);
      }
      return same;
    }
    const c = new Chess(parent.fen);
    let m;
    try {
      m = c.move(toMove(uci));
    } catch {
      return null;
    }
    const node: GNode<A> = { id: this.nextId++, ply: parent.ply + 1, fen: c.fen(), uci, san: m.san, parent, children: [], a: {} };
    if (explore || parent.x) {
      node.x = true;
      sib.push(node);
    } else this.insertReal(sib, node);
    return node;
  }

  private insertReal(sib: GNode<A>[], n: GNode<A>) {
    const i = sib.findIndex((c) => c.x);
    if (i < 0) sib.push(n);
    else sib.splice(i, 0, n);
  }

  /** root … node */
  pathTo(node: GNode<A>): GNode<A>[] {
    const out: GNode<A>[] = [];
    for (let n: GNode<A> | null = node; n; n = n.parent) out.push(n);
    return out.reverse();
  }

  /** root … node, then node's main continuation to the end */
  lineThrough(node: GNode<A>): GNode<A>[] {
    const out = this.pathTo(node);
    for (let n = mainChild(node); n; n = mainChild(n)) out.push(n);
    return out;
  }

  /** the game record: never contains explorations */
  mainline(): GNode<A>[] {
    return this.lineThrough(this.root);
  }

  isMainline(node: GNode<A>): boolean {
    for (let n = node; n.parent; n = n.parent) if (n.x || n.parent.children[0] !== n) return false;
    return true;
  }

  /** Moves `node`'s branch up so that it becomes the main line (explorations on it become real moves). */
  makeMainline(node: GNode<A>) {
    for (let n = node.children[0]; n; n = n.children[0]) n.x = false;
    for (let n = node; n.parent; n = n.parent) {
      n.x = false;
      const sib = n.parent.children;
      const i = sib.indexOf(n);
      if (i > 0) {
        sib.splice(i, 1);
        sib.unshift(n);
      }
    }
  }

  /** Detaches `node` and everything after it. */
  remove(node: GNode<A>) {
    if (!node.parent) return;
    node.parent.children = node.parent.children.filter((c) => c !== node);
  }

  *nodes(from: GNode<A> = this.root): Generator<GNode<A>> {
    yield from;
    for (const c of from.children) yield* this.nodes(c);
  }

  serialize(node: GNode<A> = this.root): SNode {
    const s: SNode = {};
    if (node.uci) s.u = node.uci;
    if (node.children.length) s.c = node.children.map((c) => this.serialize(c));
    if (node.comment) s.t = node.comment;
    if (node.nags?.length) s.n = node.nags;
    if (node.clock) s.k = node.clock;
    if (node.x) s.x = 1;
    return s;
  }

  static deserialize<A extends object = object>(startFen: string, s: SNode): GameTree<A> {
    const tree = new GameTree<A>(startFen);
    // stored / imported data: keep only well-formed fields
    const fill = (node: GNode<A>, sn: SNode) => {
      if (!sn || typeof sn !== 'object') throw new Error('对局数据损坏');
      if (typeof sn.t === 'string' && sn.t) node.comment = sn.t;
      if (Array.isArray(sn.n) && sn.n.length && sn.n.every((x) => Number.isInteger(x))) node.nags = sn.n;
      if (Array.isArray(sn.k) && sn.k.length === 2 && sn.k.every((x) => Number.isFinite(x))) node.clock = [sn.k[0], sn.k[1]];
      for (const c of Array.isArray(sn.c) ? sn.c : []) {
        const child = c && typeof c.u === 'string' ? tree.add(node, c.u, Boolean(c.x)) : null;
        if (!child) throw new Error(`非法着法：${c.u}`);
        fill(child, c);
      }
    };
    fill(tree.root, s);
    return tree;
  }

  static fromMoves<A extends object = object>(startFen: string, ucis: string[]): GameTree<A> {
    const tree = new GameTree<A>(startFen);
    let n = tree.root;
    for (const u of ucis) {
      const next = tree.add(n, u);
      if (!next) throw new Error(`非法着法：${u}`);
      n = next;
    }
    return tree;
  }
}
