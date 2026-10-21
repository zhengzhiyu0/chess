import { mainChild, type GameTree, type GNode } from '../game/tree';
import { moveNumberOf, turnOf } from '../game/rules';
import { NAG_SYMBOL } from '../game/pgn';

export interface MoveMark {
  symbol: string;
  color?: string;
  /** inline HTML (e.g. an SVG badge) appended after the move */
  icon?: string;
}

/**
 * Move list HTML: the main line with variations inline in parentheses, like a PGN viewer.
 * Each move is a `.mv` span carrying `data-id` (the tree node id).
 */
export function movesHtml<A extends object>(tree: GameTree<A>, cur: GNode<A>, mark: (n: GNode<A>) => MoveMark | null, showVariations: boolean): string {
  const mainIds = new Set(tree.mainline().map((n) => n.id));
  const move = (n: GNode<A>, needNum: boolean) => {
    const fen = n.parent!.fen;
    const num = moveNumberOf(fen);
    let html = '';
    if (turnOf(fen) === 'w') html += `<span class="num">${num}.</span>`;
    else if (needNum) html += `<span class="num">${num}…</span>`;
    const m = mark(n);
    const nag = n.nags?.map((g) => NAG_SYMBOL[g] ?? '').join('') ?? '';
    const sym = m?.icon ? '' : m && m.symbol && m.symbol !== '★' ? m.symbol : nag;
    const style = m?.color ? ` style="color:${m.color}"` : '';
    const cls = `mv${n === cur ? ' cur' : ''}${mainIds.has(n.id) ? '' : ' side'}${n.x ? ' x' : ''}${n.comment ? ' noted' : ''}`;
    return html + `<span class="${cls}" data-id="${n.id}"${style}>${m?.icon ?? ''}${n.san}${sym}</span>`;
  };
  const vars = (parent: GNode<A>, alts: GNode<A>[]) => alts.map((v) => `<span class="var">${line(parent, v, true)}</span>`).join('');
  const line = (from: GNode<A>, first: GNode<A>, needNum: boolean): string => {
    let html = '';
    let parent = from;
    let n: GNode<A> | undefined = first;
    let need = needNum;
    while (n) {
      html += move(n, need);
      need = false;
      const alts = showVariations && parent.children[0] === n ? parent.children.slice(1) : [];
      if (alts.length) {
        html += vars(parent, alts);
        need = true;
      }
      parent = n;
      n = mainChild(n);
    }
    // explorations hanging off the end of a real line
    if (showVariations && parent.children.length) html += vars(parent, parent.children);
    return html;
  };
  const first = mainChild(tree.root);
  if (first) return line(tree.root, first, true);
  return showVariations ? vars(tree.root, tree.root.children) : '';
}

export function findNode<A extends object>(tree: GameTree<A>, id: number): GNode<A> | null {
  for (const n of tree.nodes()) if (n.id === id) return n;
  return null;
}
