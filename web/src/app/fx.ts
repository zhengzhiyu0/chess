// Board effects layer: particles (canvas) and board shake on top of chessground. Badge pop-in,
// hanging-piece breathing and check pulse are pure CSS (see `.fx-on` rules in style.css).
import { Chess, type Square } from 'chess.js';
import type { Judgement } from '../coach/coach';
import { toMove } from '../game/rules';

export interface MoveFx {
  from: string;
  to: string;
  /** type of the piece that moved, used to route knight effects around the L */
  piece: string;
  /** square of the captured piece (differs from `to` for en passant) */
  captured?: { square: string; color: 'w' | 'b' };
  /** king square of the side in check / mated */
  checkSq?: string;
  mate?: boolean;
  judgement?: Judgement;
  /** castling: the rook's journey */
  rook?: { from: string; to: string };
  /** enemy pieces the moved piece now attacks (worth attacking) */
  attacks: string[];
  /** own threatened pieces the moved piece now defends */
  defends: string[];
}

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

/** Describes the move `uci` played from `fen` for {@link BoardFx.move}; null if illegal. */
export function moveFxOf(fen: string, uci: string, judgement?: Judgement): MoveFx | null {
  const c = new Chess(fen);
  let mv;
  try {
    mv = c.move(toMove(uci));
  } catch {
    return null;
  }
  const out: MoveFx = { from: mv.from, to: mv.to, piece: mv.piece, judgement, attacks: [], defends: [] };
  if (mv.flags.includes('k') || mv.flags.includes('q')) {
    const r = mv.from[1];
    out.rook = mv.flags.includes('k') ? { from: 'h' + r, to: 'f' + r } : { from: 'a' + r, to: 'd' + r };
  }
  const me = mv.color;
  const opp = me === 'w' ? 'b' : 'w';
  const at = (out.rook?.to ?? mv.to) as Square;
  const mine = VALUE[c.get(at)?.type ?? 'p'];
  for (const row of c.board())
    for (const p of row) {
      if (!p || p.square === at || !c.attackers(p.square, me).includes(at)) continue;
      if (p.color === opp) {
        if (p.type === 'k' || VALUE[p.type] > mine || !c.attackers(p.square, opp).length) out.attacks.push(p.square);
      } else if (p.type !== 'k' && c.isAttacked(p.square, opp)) out.defends.push(p.square);
    }
  out.attacks = out.attacks.slice(0, 3);
  out.defends = out.defends.slice(0, 2);
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

type Shape = 'rect' | 'circle' | 'star' | 'ring' | 'line' | 'fill';
type Point = [number, number];
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
  /** line: end point */
  x2?: number;
  y2?: number;
  /** line/fill route through the board (knights have a two-segment L route) */
  points?: Point[];
  /** fill: colour-wash square size (usually one board square) */
  fillSize?: number;
}

const PIECE_SHARDS = { w: ['#ffffff', '#e8e6e1', '#c9c5bc'], b: ['#4a4744', '#2b2927', '#6b6763'] };
const CONFETTI = ['#ffd54a', '#5fae3e', '#4fb3ff', '#ff6b8b', '#b98cff', '#ffffff', '#ff9f43'];
const MAX = 260;
/** attack/defence path timing (seconds) */
const LINE_GROW = 0.38;
const LINE_FADE = 0.45;
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
  arrowStyle: 'line' | 'fill' = 'line';
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ps: Particle[] = [];
  private raf = 0;
  private last = 0;
  private size = 0;
  private timers: number[] = [];
  private castleAnim: Animation | null = null;
  private orient: 'white' | 'black' = 'white';
  /** pending start of the paths of the last move */
  private lineTimer = 0;

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
    clearTimeout(this.lineTimer);
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
    clearTimeout(this.lineTimer);
    // its removal timer was just cancelled
    this.box.classList.remove('fx-shake');
    // the previous move's paths point at a position that no longer exists; fade them out now
    for (const p of this.ps) if (p.shape === 'line' || p.shape === 'fill') p.life = Math.min(p.life, Math.max(p.t, 0) + 0.15);
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
      if (j === 'blunder') this.shake();
      const from = m.rook?.to ?? m.to;
      // after the rook has landed when castling
      this.lineTimer = window.setTimeout(() => {
        for (const sq of m.attacks) this.arrow(from, sq, '#ff4b3e', m.piece);
        for (const sq of m.defends) this.arrow(from, sq, '#4fd18b', m.piece);
      }, m.rook ? 320 : 80);
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

  private route(a: string, b: string, piece: string): Point[] {
    const start = this.center(a);
    const end = this.center(b);
    if (piece !== 'n') return [start, end];
    const af = a.charCodeAt(0) - 97;
    const ar = Number(a[1]) - 1;
    const bf = b.charCodeAt(0) - 97;
    const br = Number(b[1]) - 1;
    if (Math.abs(af - bf) !== 1 || Math.abs(ar - br) !== 2) {
      if (Math.abs(af - bf) !== 2 || Math.abs(ar - br) !== 1) return [start, end];
    }
    // Use the square at the destination rank first, which gives the familiar L turn.
    const bend = this.center(String.fromCharCode(97 + af) + String(br + 1));
    return [start, bend, end];
  }

  private pathLength(points: Point[]): number {
    let n = 0;
    for (let i = 1; i < points.length; i++) n += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    return n;
  }

  /** Discrete board squares visited by an attack/defence effect, excluding the origin square. */
  private squares(a: string, b: string, piece: string): string[] {
    const af = a.charCodeAt(0) - 97;
    const ar = Number(a[1]) - 1;
    const bf = b.charCodeAt(0) - 97;
    const br = Number(b[1]) - 1;
    if (piece === 'n' && Math.abs(af - bf) <= 2 && Math.abs(ar - br) <= 2) {
      const bend = String.fromCharCode(97 + af) + String(br + 1);
      return [bend, b];
    }
    const steps = Math.max(Math.abs(af - bf), Math.abs(ar - br));
    if (!steps) return [b];
    const sf = Math.sign(bf - af);
    const sr = Math.sign(br - ar);
    const out: string[] = [];
    for (let i = 1; i <= steps; i++) out.push(String.fromCharCode(97 + af + sf * i) + String(ar + sr * i + 1));
    return out;
  }

  private pointAt(points: Point[], distance: number): { p: Point; ux: number; uy: number } {
    let left = Math.max(0, distance);
    for (let i = 1; i < points.length; i++) {
      const x = points[i][0] - points[i - 1][0];
      const y = points[i][1] - points[i - 1][1];
      const len = Math.hypot(x, y);
      if (left <= len || i === points.length - 1) {
        const t = len ? Math.min(1, left / len) : 1;
        return { p: [points[i - 1][0] + x * t, points[i - 1][1] + y * t], ux: len ? x / len : 0, uy: len ? y / len : 0 };
      }
      left -= len;
    }
    const last = points[points.length - 1];
    const prev = points[Math.max(0, points.length - 2)];
    const len = Math.hypot(last[0] - prev[0], last[1] - prev[1]);
    return { p: last, ux: len ? (last[0] - prev[0]) / len : 0, uy: len ? (last[1] - prev[1]) / len : 0 };
  }

  /** Attack / defence path: a line that grows along the legal route, then fades. */
  private line(a: string, b: string, color: string, piece: string) {
    const points = this.route(a, b, piece);
    const [x, y] = points[0];
    this.push({ x, y, vx: 0, vy: 0, g: 0, drag: 0, t: 0, life: 2.4, size: this.size / 8, color, shape: 'line', rot: 0, vr: 0, points });
    this.start();
  }

  /** Attack / defence path: colour each square in sequence, then fade the wash out. */
  private fill(a: string, b: string, color: string, piece: string) {
    const squares = this.squares(a, b, piece);
    const s = this.size / 8;
    for (let i = 0; i < squares.length; i++) {
      const [x, y] = this.center(squares[i]);
      this.push({
        x,
        y,
        vx: 0,
        vy: 0,
        g: 0,
        drag: 0,
        t: -i * 0.1,
        life: 0.82,
        size: s,
        fillSize: s,
        color,
        shape: 'fill',
        rot: 0,
        vr: 0,
      });
    }
    this.start();
  }

  private arrow(a: string, b: string, color: string, piece: string) {
    if (this.arrowStyle === 'fill') this.fill(a, b, color, piece);
    else this.line(a, b, color, piece);
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
      if (p.shape === 'line') {
        this.drawLine(p);
        c.restore();
        continue;
      }
      if (p.shape === 'fill') {
        const q = p.t / p.life;
        // A full square starts with a strong wash and only fades; there is no scale animation.
        c.globalAlpha = Math.max(0, 1 - q) * 0.72;
        c.fillStyle = p.color;
        const s = p.fillSize ?? p.size;
        c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        c.restore();
        continue;
      }
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

  private drawLine(p: Particle) {
    const c = this.ctx;
    const s = p.size;
    const points = p.points ?? [[p.x, p.y], [p.x2!, p.y2!]];
    const len = this.pathLength(points);
    // from the piece's edge to just short of the target
    const start = s * 0.32;
    const end = len - s * 0.42;
    // fixed-time grow and fade so a longer life only lengthens the hold
    const grow = Math.min(1, p.t / LINE_GROW);
    const head = start + Math.max(0, end - start) * (1 - (1 - grow) ** 3);
    const alpha = Math.min(1, (p.life - p.t) / LINE_FADE) * 0.9;
    const from = this.pointAt(points, start);
    const tip = this.pointAt(points, head);
    const target = this.pointAt(points, len);
    c.strokeStyle = c.fillStyle = p.color;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(from.p[0], from.p[1]);
    let travelled = 0;
    for (let i = 1; i < points.length; i++) {
      const seg = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      travelled += seg;
      if (travelled < start) continue;
      if (travelled >= head) break;
      c.lineTo(points[i][0], points[i][1]);
    }
    c.lineTo(tip.p[0], tip.p[1]);
    // soft glow as a wide translucent stroke: shadowBlur is a full-canvas blur per draw and drops frames on phones
    c.globalAlpha = alpha * 0.25;
    c.lineWidth = s * 0.24;
    c.stroke();
    c.globalAlpha = alpha;
    c.lineWidth = s * 0.09;
    c.setLineDash([s * 0.16, s * 0.12]);
    c.lineDashOffset = -p.t * s * 0.9;
    c.stroke();
    c.setLineDash([]);
    const w = s * 0.14;
    c.beginPath();
    c.moveTo(tip.p[0] + tip.ux * w * 1.4, tip.p[1] + tip.uy * w * 1.4);
    c.lineTo(tip.p[0] - tip.uy * w, tip.p[1] + tip.ux * w);
    c.lineTo(tip.p[0] + tip.uy * w, tip.p[1] - tip.ux * w);
    c.closePath();
    c.fill();
    // target ring pulses once the line arrives
    if (grow >= 1) {
      const k = Math.min(1, (p.t - LINE_GROW) / 0.2);
      c.lineWidth = s * 0.06;
      c.beginPath();
      c.arc(target.p[0], target.p[1], s * (0.36 + 0.05 * Math.sin(p.t * 12)) * k, 0, Math.PI * 2);
      c.stroke();
    }
  }
}
