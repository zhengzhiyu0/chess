import type { GameTree, GNode } from '../game/tree';
import { moveNumberOf, turnOf } from '../game/rules';
import { NAG_SYMBOL } from '../game/pgn';

export interface MoveMark {
  symbol: string;
  color?: string;
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
    const sym = m && m.symbol && m.symbol !== '★' ? m.symbol : nag;
    const style = m?.color ? ` style="color:${m.color}"` : '';
    const cls = `mv${n === cur ? ' cur' : ''}${mainIds.has(n.id) ? '' : ' side'}${n.comment ? ' noted' : ''}`;
    return html + `<span class="${cls}" data-id="${n.id}"${style}>${n.san}${sym}</span>`;
  };
  const line = (from: GNode<A>, first: GNode<A>, needNum: boolean): string => {
    let html = '';
    let parent = from;
    let n: GNode<A> | undefined = first;
    let need = needNum;
    while (n) {
      html += move(n, need);
      need = false;
      const alts = showVariations && parent.children[0] === n ? parent.children.slice(1) : [];
      for (const v of alts) {
        html += `<span class="var">${line(parent, v, true)}</span>`;
        need = true;
      }
      parent = n;
      n = n.children[0];
    }
    return html;
  };
  const first = tree.root.children[0];
  return first ? line(tree.root, first, true) : '';
}

export function findNode<A extends object>(tree: GameTree<A>, id: number): GNode<A> | null {
  for (const n of tree.nodes()) if (n.id === id) return n;
  return null;
}
