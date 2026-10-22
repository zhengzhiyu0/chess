// "Dodge": while the player is about to capture, the threatened enemy pieces get nervous and, when the
// attacker comes close, hop up and lean away. Uses the individual CSS `translate`/`rotate` properties so it
// composes with chessground's inline `transform` positioning.
import type { Api } from '@lichess-org/chessground/api';
import type { Key, PieceNode } from '@lichess-org/chessground/types';

/** Distance (in squares) between the dragged piece and a target that triggers the hop. */
const NEAR = 0.95;

export class DodgeFx {
  enabled = true;
  private raf = 0;
  private marked = new Map<PieceNode, string>();

  constructor(
    private cg: Api,
    wrap: HTMLElement,
  ) {
    const kick = () => this.start();
    // listen on the wrapper: chessground recreates cg-board on redrawAll()
    wrap.addEventListener('mousedown', kick, { capture: true, passive: true });
    wrap.addEventListener('touchstart', kick, { capture: true, passive: true });
    // drags can end anywhere on the page
    for (const ev of ['mouseup', 'touchend', 'touchcancel']) document.addEventListener(ev, kick, { passive: true });
  }

  private start() {
    if (!this.enabled || this.raf) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Capturable enemy pieces for the currently selected / dragged piece. */
  private targets(orig: Key): Key[] {
    const s = this.cg.state;
    const me = s.pieces.get(orig);
    if (!me) return [];
    const dests = s.movable.dests?.get(orig) ?? [];
    return dests.filter((k) => {
      const p = s.pieces.get(k);
      return p && p.color !== me.color;
    });
  }

  private tick = () => {
    this.raf = 0;
    const s = this.cg.state;
    const drag = s.draggable.current;
    const orig = drag?.started ? drag.orig : s.selected;
    const want = new Map<Key, { cls: string; dir: number }>();
    if (this.enabled && orig) {
      const b = s.dom.bounds();
      const sq = b.width / 8;
      const white = s.orientation === 'white';
      const center = (k: Key): [number, number] => {
        const f = k.charCodeAt(0) - 97;
        const r = k.charCodeAt(1) - 49;
        return [b.left + ((white ? f : 7 - f) + 0.5) * sq, b.top + ((white ? 7 - r : r) + 0.5) * sq];
      };
      const from = drag?.started ? drag.pos : center(orig);
      for (const k of this.targets(orig)) {
        const [x, y] = center(k);
        const d = Math.hypot(x - from[0], y - from[1]) / sq;
        const dir = x >= from[0] ? 1 : -1;
        want.set(k, { cls: drag?.started && d < NEAR ? 'fx-dodge' : 'fx-nervous', dir });
      }
    }
    // reconcile classes with the piece elements currently on the board
    const seen = new Set<PieceNode>();
    for (let el = s.dom.elements.board.firstElementChild as PieceNode | null; el; el = el.nextElementSibling as PieceNode | null) {
      if (el.tagName !== 'PIECE' || el.cgDragging || el.cgFading) continue;
      const w = want.get(el.cgKey);
      if (!w) continue;
      seen.add(el);
      if (this.marked.get(el) !== w.cls) {
        el.classList.remove('fx-dodge', 'fx-nervous');
        el.classList.add(w.cls);
        el.style.setProperty('--dodge-dir', String(w.dir));
        // pivot rotation on the piece itself, not on the board's top-left corner where chessground's translate starts
        const b = s.dom.bounds();
        const f = el.cgKey.charCodeAt(0) - 97;
        const r = el.cgKey.charCodeAt(1) - 49;
        const white = s.orientation === 'white';
        el.style.transformOrigin = `${((white ? f : 7 - f) + 0.5) * (b.width / 8)}px ${((white ? 7 - r : r) + 1) * (b.height / 8)}px`;
        this.marked.set(el, w.cls);
      }
    }
    for (const el of this.marked.keys()) {
      if (seen.has(el)) continue;
      el.classList.remove('fx-dodge', 'fx-nervous');
      el.style.transformOrigin = '';
      this.marked.delete(el);
    }
    if (want.size || drag) this.raf = requestAnimationFrame(this.tick);
  };
}
