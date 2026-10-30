// Board effects layer: particles (canvas) and board shake on top of chessground. Badge pop-in,
// hanging-piece breathing and check pulse are pure CSS (see `.fx-on` rules in style.css).
import { Chess } from 'chess.js';
import type { Judgement } from '../coach/coach';
import { toMove } from '../game/rules';

export interface MoveFx {
  to: string;
  /** square of the captured piece (differs from `to` for en passant) */
  captured?: { square: string; color: 'w' | 'b' };
  /** king square of the side in check / mated */
  checkSq?: string;
  mate?: boolean;
  judgement?: Judgement;
  /** castling: the rook's journey */
  rook?: { from: string; to: string };
}

/** Describes the move `uci` played from `fen` for {@link BoardFx.move}; null if illegal. */
export function moveFxOf(fen: string, uci: string, judgement?: Judgement): MoveFx | null {
  const c = new Chess(fen);
  let mv;
  try {
    mv = c.move(toMove(uci));
  } catch {
    return null;
  }
  const out: MoveFx = { to: mv.to, judgement };
  if (mv.flags.includes('k') || mv.flags.includes('q')) {
    const r = mv.from[1];
    out.rook = mv.flags.includes('k') ? { from: 'h' + r, to: 'f' + r } : { from: 'a' + r, to: 'd' + r };
  }
  if (mv.captured) {
    const sq = mv.flags.includes('e') ? mv.to[0] + mv.from[1] : mv.to;
    out.captured = { square: sq, color: mv.color === 'w' ? 'b' : 'w' };
  }
  if (c.inCheck()) {
    const side = c.turn();
    for (const row of c.board()) for (const p of row) if (p && p.type === 'k' && p.color === side) out.checkSq = p.square;
    out.mate = c.isCheckmate();
  }
  return out;
}

type Shape = 'rect' | 'circle' | 'star' | 'ring';
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  drag: number;
  t: number;
  life: number;
  size: number;
  color: string;
  shape: Shape;
  rot: number;
  vr: number;
  /** confetti: width/height flip to fake 3D rotation */
  flip?: number;
}

const PIECE_SHARDS = { w: ['#ffffff', '#e8e6e1', '#c9c5bc'], b: ['#4a4744', '#2b2927', '#6b6763'] };
const CONFETTI = ['#ffd54a', '#5fae3e', '#4fb3ff', '#ff6b8b', '#b98cff', '#ffffff', '#ff9f43'];
const MAX = 260;
const RING: Partial<Record<Judgement, string>> = {
  brilliant: '#3fe0d6',
  great: '#6aa8ff',
  best: '#ffd54a',
  book: '#d9b48a',
  inaccuracy: '#ffd36b',
  mistake: '#ff9b3d',
  miss: '#ff7a6b',
  blunder: '#ff4b3e',
};
const GOLD = ['#ffd54a', '#ffd54a', '#ffffff'];
const GREAT = ['#6aa8ff', '#6aa8ff', '#ffffff'];
const BRILLIANT = ['#3fe0d6', '#7ff0e8', '#ffffff'];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class BoardFx {
  enabled = true;
  badgeEnabled = true;
  captureEnabled = true;
  checkEnabled = true;
  mateEnabled = true;
  shakeEnabled = false;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ps: Particle[] = [];
  private raf = 0;
  private last = 0;
  private size = 0;
  private timers: number[] = [];
  private castleAnim: Animation | null = null;
  private orient: 'white' | 'black' = 'white';

  constructor(
    private box: HTMLElement,
    private orientation: () => 'white' | 'black',
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fx-canvas';
    box.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(box);
    this.resize();
  }

  private resize() {
    const r = this.box.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = Math.min(r.width, r.height);
    // particles are in pixel coordinates of the old size
    if (size !== this.size) this.ps = [];
    this.size = size;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Centre of `sq` in CSS pixels relative to the board box. */
  private center(sq: string): [number, number] {
    const s = this.size / 8;
    const f = sq.charCodeAt(0) - 97;
    const r = Number(sq[1]) - 1;
    const white = this.orientation() === 'white';
    return [((white ? f : 7 - f) + 0.5) * s, ((white ? 7 - r : r) + 0.5) * s];
  }

  /** Cancels pending and running effects (e.g. when jumping elsewhere in the game). */
  clear() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.ps = [];
    this.castleAnim?.cancel();
    this.box.classList.remove('fx-shake');
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Effects for a move that has just been made; `delay` lets the piece slide in first. */
  move(m: MoveFx, delay = 160) {
    if (!this.enabled || !this.size) return;
    // fast stepping: the previous move's pending bursts would land on squares that changed meanwhile
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    // its removal timer was just cancelled
    this.box.classList.remove('fx-shake');
    this.castleAnim?.cancel();
    if (m.rook) this.castle(m);
    this.later(delay, () => {
      const [x, y] = this.center(m.to);
      if (m.captured && this.captureEnabled) this.shards(...this.center(m.captured.square), m.captured.color);
      const j = m.judgement;
      const big = j === 'best' || j === 'blunder' || j === 'brilliant' || j === 'great';
      if (this.badgeEnabled) {
        this.ring(x, y, (j && RING[j]) || 'rgba(255,255,255,.85)', big ? 0.75 : 0.6);
        if (j === 'best') this.sparkles(x, y);
        if (j === 'great') this.sparkles(x, y, GREAT);
        if (j === 'brilliant') {
          this.sparkles(x, y, BRILLIANT, 18);
          this.ring(x, y, '#7ff0e8', 1, 0.12);
        }
      }
      if (j === 'blunder' && this.shakeEnabled) this.shake();
      if (m.checkSq && this.checkEnabled) {
        const [kx, ky] = this.center(m.checkSq);
        this.ring(kx, ky, '#ff3b30', 0.8, 0.12);
      }
      if (m.mate && m.checkSq && this.mateEnabled) this.later(220, () => this.confetti(...this.center(m.checkSq!)));
      this.start();
    });
  }

  private later(ms: number, fn: () => void) {
    const id = window.setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== id);
      fn();
    }, ms);
    this.timers.push(id);
  }

  private push(p: Particle) {
    if (this.ps.length < MAX) this.ps.push(p);
  }

  private ring(x: number, y: number, color: string, reach: number, delay = 0) {
    const s = this.size / 8;
    this.push({ x, y, vx: 0, vy: 0, g: 0, drag: 0, t: -delay, life: 0.45, size: s * reach, color, shape: 'ring', rot: 0, vr: 0 });
  }

  private shards(x: number, y: number, color: 'w' | 'b') {
    const s = this.size / 8;
    const cols = PIECE_SHARDS[color];
    for (let i = 0; i < 18; i++) {
      const a = rnd(0, Math.PI * 2);
      const v = rnd(1.2, 4.2) * s;
      this.push({
        x: x + rnd(-0.15, 0.15) * s,
        y: y + rnd(-0.15, 0.15) * s,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 1.6 * s,
        g: 9 * s,
        drag: 1.5,
        t: 0,
        life: rnd(0.45, 0.75),
        size: rnd(0.05, 0.11) * s,
        color: cols[i % cols.length],
        shape: i % 4 === 0 ? 'circle' : 'rect',
        rot: rnd(0, Math.PI),
        vr: rnd(-12, 12),
      });
    }
  }

  private sparkles(x: number, y: number, cols = GOLD, n = 12) {
    const s = this.size / 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.2, 0.2);
      const v = rnd(0.9, 1.8) * s;
      this.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0, drag: 2.5, t: -rnd(0, 0.08), life: rnd(0.55, 0.8), size: rnd(0.09, 0.16) * s, color: cols[i % cols.length], shape: 'star', rot: 0, vr: rnd(-4, 4) });
    }
  }

  private confetti(x: number, y: number) {
    const s = this.size / 8;
    for (let i = 0; i < 110; i++) {
      const a = rnd(-Math.PI * 0.95, -Math.PI * 0.05);
      const v = rnd(3, 8.5) * s;
      this.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        g: 6 * s,
        drag: 1.8,
        t: -rnd(0, 0.15),
        life: rnd(1.4, 2.2),
        size: rnd(0.08, 0.14) * s,
        color: CONFETTI[i % CONFETTI.length],
        shape: i % 5 === 0 ? 'circle' : 'rect',
        rot: rnd(0, Math.PI),
        vr: rnd(-8, 8),
        flip: rnd(6, 14),
      });
    }
  }

  /** The rook's flight; chessground must not slide it as well (see `playFx` in main). */
  private rookFlight(m: MoveFx, retry = true) {
    const rook = [...this.box.querySelectorAll<HTMLElement & { cgKey?: string }>('cg-board piece')].find((p) => p.cgKey === m.rook!.to);
    if (!rook) {
      if (retry) requestAnimationFrame(() => this.rookFlight(m, false));
      return;
    }
    const s = this.size / 8;
    const [fx0] = this.center(m.rook!.from);
    const [tx, ty] = this.center(m.rook!.to);
    const dx = (fx0 - tx) / s;
    const dir = Math.sign(-dx) || 1;
    // individual translate/rotate/scale compose with chessground's inline transform; pivot at the
    // rook's own base instead of the board corner the element is laid out at
    rook.style.transformOrigin = `${tx}px ${ty + s / 2}px`;
    const frames: Keyframe[] = [];
    const N = 14;
    const FLY = 0.78;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const u = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const lift = 4 * u * (1 - u);
      frames.push({
        offset: t * FLY,
        translate: `${(dx * (1 - u) * 100).toFixed(2)}% ${(-lift * 55).toFixed(2)}%`,
        rotate: `${(dir * 12 * Math.sin(Math.PI * u) * (1 - u * 0.6)).toFixed(2)}deg`,
        scale: `${(1 + 0.1 * lift).toFixed(3)}`,
      });
    }
    frames.push({ offset: 0.88, translate: '0 0', rotate: '0deg', scale: '1.1 0.88' });
    frames.push({ offset: 0.95, translate: '0 0', rotate: '0deg', scale: '0.97 1.04' });
    frames.push({ offset: 1, translate: '0 0', rotate: '0deg', scale: '1' });
    rook.classList.add('fx-castle');
    const a = rook.animate(frames, { duration: 460, easing: 'linear' });
    this.castleAnim = a;
    const done = () => {
      rook.classList.remove('fx-castle');
      rook.style.transformOrigin = '';
      if (this.castleAnim === a) this.castleAnim = null;
    };
    a.onfinish = done;
    a.oncancel = done;
  }

  /** Castling: the rook vaults over the king in an arc; dust puffs where both land. */
  private castle(m: MoveFx) {
    this.rookFlight(m);
    const s = this.size / 8;
    for (const sq of [m.to, m.rook!.to]) {
      const [x, y] = this.center(sq);
      for (let i = 0; i < 7; i++) {
        const side = i % 2 ? 1 : -1;
        this.push({ x: x + side * rnd(0.1, 0.3) * s, y: y + 0.38 * s, vx: side * rnd(0.6, 1.4) * s, vy: -rnd(0.2, 0.6) * s, g: 0, drag: 3, t: -0.36, life: rnd(0.4, 0.6), size: rnd(0.08, 0.14) * s, color: 'rgba(255,255,255,.7)', shape: 'circle', rot: 0, vr: 0 });
      }
    }
    this.later(380, () => {
      this.ring(...this.center(m.rook!.to), '#ffd54a', 0.6);
      this.start();
    });
  }

  private shake() {
    this.box.classList.remove('fx-shake');
    void this.box.offsetWidth;
    this.box.classList.add('fx-shake');
    this.later(450, () => this.box.classList.remove('fx-shake'));
  }

  private start() {
    if (this.raf || !this.ps.length) return;
    this.orient = this.orientation();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const c = this.ctx;
    // board flipped mid-effect: every position is now mirrored
    const o = this.orientation();
    if (o !== this.orient) {
      this.orient = o;
      this.ps = [];
    }
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ps = this.ps.filter((p) => (p.t += dt) < p.life);
    for (const p of this.ps) {
      if (p.t < 0) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const q = p.t / p.life;
      c.save();
      c.globalAlpha = p.shape === 'ring' ? (1 - q) * 0.9 : Math.min(1, (1 - q) * 2.2);
      c.translate(p.x, p.y);
      c.rotate(p.rot);
      c.fillStyle = c.strokeStyle = p.color;
      if (p.shape === 'ring') {
        const e = 1 - (1 - q) ** 3;
        c.lineWidth = Math.max(1.5, p.size * 0.14 * (1 - q));
        c.beginPath();
        c.arc(0, 0, p.size * (0.35 + 0.65 * e), 0, Math.PI * 2);
        c.stroke();
      } else if (p.shape === 'circle') {
        c.beginPath();
        c.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        c.fill();
      } else if (p.shape === 'star') {
        const r = p.size * (1 - q * 0.5);
        c.beginPath();
        for (let i = 0; i < 8; i++) {
          const rr = i % 2 ? r * 0.28 : r;
          const a = (i / 8) * Math.PI * 2;
          c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        c.closePath();
        c.fill();
      } else {
        const w = p.size;
        const h = p.flip ? p.size * 0.55 * Math.abs(Math.cos(p.t * p.flip)) + 0.5 : p.size * 0.7;
        c.fillRect(-w / 2, -h / 2, w, h);
      }
      c.restore();
    }
    this.raf = this.ps.length ? requestAnimationFrame(this.frame) : 0;
    if (!this.raf) c.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };
}
