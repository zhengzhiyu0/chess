import { Chess } from 'chess.js';
import { toMove } from './rules';

/** Serialized node: uci, children, comment, NAGs, clock snapshot [white ms, black ms]. */
export interface SNode {
  u?: string;
  c?: SNode[];
  t?: string;
  n?: number[];
  k?: [number, number];
}

export interface GNode<A extends object = object> {
  id: number;
  ply: number;
  fen: string;
  /** move that led here ('' at the root) */
  uci: string;
  san: string;
  parent: GNode<A> | null;
  /** children[0] is the main continuation, the rest are variations */
  children: GNode<A>[];
  comment?: string;
  nags?: number[];
  /** remaining clock times [white, black] in ms right after this position arose */
  clock?: [number, number];
  /** analysis cache, never serialized */
  a: Partial<A>;
}

export class GameTree<A extends object = object> {
  readonly root: GNode<A>;
  private nextId = 1;

  constructor(readonly startFen: string) {
    this.root = { id: 0, ply: 0, fen: new Chess(startFen).fen(), uci: '', san: '', parent: null, children: [], a: {} };
  }

  /** Plays `uci` from `parent`; reuses an existing child with the same move. Returns null if illegal. */
  add(parent: GNode<A>, uci: string): GNode<A> | null {
    const same = parent.children.find((c) => c.uci === uci);
    if (same) return same;
    const c = new Chess(parent.fen);
    let m;
    try {
      m = c.move(toMove(uci));
    } catch {
      return null;
    }
    const node: GNode<A> = { id: this.nextId++, ply: parent.ply + 1, fen: c.fen(), uci, san: m.san, parent, children: [], a: {} };
    parent.children.push(node);
    return node;
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
    for (let n = node.children[0]; n; n = n.children[0]) out.push(n);
    return out;
  }

  mainline(): GNode<A>[] {
    return this.lineThrough(this.root);
  }

  isMainline(node: GNode<A>): boolean {
    for (let n = node; n.parent; n = n.parent) if (n.parent.children[0] !== n) return false;
    return true;
  }

  /** Moves `node`'s branch up so that it becomes the main line. */
  makeMainline(node: GNode<A>) {
    for (let n = node; n.parent; n = n.parent) {
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
    return s;
  }

  static deserialize<A extends object = object>(startFen: string, s: SNode): GameTree<A> {
    const tree = new GameTree<A>(startFen);
    const fill = (node: GNode<A>, sn: SNode) => {
      if (sn.t) node.comment = sn.t;
      if (sn.n?.length) node.nags = sn.n;
      if (sn.k) node.clock = sn.k;
      for (const c of sn.c ?? []) {
        const child = c.u ? tree.add(node, c.u) : null;
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
