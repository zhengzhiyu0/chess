import type { Color } from './rules';

export interface TimeControl {
  /** initial time per side, ms */
  base: number;
  /** increment per move, ms */
  inc: number;
}

export const TIME_CONTROLS: { id: string; label: string; tc: TimeControl | null }[] = [
  { id: 'none', label: '不限时', tc: null },
  { id: '3+2', label: '3+2 快棋', tc: { base: 180_000, inc: 2_000 } },
  { id: '5+3', label: '5+3 快棋', tc: { base: 300_000, inc: 3_000 } },
  { id: '10+5', label: '10+5 快棋', tc: { base: 600_000, inc: 5_000 } },
  { id: '15+10', label: '15+10 慢棋', tc: { base: 900_000, inc: 10_000 } },
  { id: '30+20', label: '30+20 慢棋', tc: { base: 1_800_000, inc: 20_000 } },
];

export function timeControlOf(id: string | undefined): TimeControl | null {
  return TIME_CONTROLS.find((t) => t.id === id)?.tc ?? null;
}

/** PGN `TimeControl` tag, e.g. "300+3". */
export function pgnTimeControl(tc: TimeControl | null): string {
  return tc ? `${tc.base / 1000}+${tc.inc / 1000}` : '-';
}

/** Two-sided chess clock; time is only committed when the running side changes. */
export class ChessClock {
  remaining: [number, number];
  active: Color | null = null;
  private since = 0;

  constructor(
    readonly tc: TimeControl,
    remaining?: [number, number],
  ) {
    this.remaining = remaining ? [...remaining] : [tc.base, tc.base];
  }

  private idx(c: Color) {
    return c === 'w' ? 0 : 1;
  }

  time(c: Color, now: number): number {
    const t = this.remaining[this.idx(c)];
    return this.active === c ? Math.max(0, t - (now - this.since)) : t;
  }

  snapshot(now: number): [number, number] {
    return [this.time('w', now), this.time('b', now)];
  }

  stop(now: number) {
    if (this.active) this.remaining[this.idx(this.active)] = this.time(this.active, now);
    this.active = null;
  }

  /** Runs `c`'s clock (no-op if it is already running). */
  run(c: Color, now: number) {
    if (this.active === c) return;
    this.stop(now);
    this.active = c;
    this.since = now;
  }

  /** `c` completed a move: commit its time and add the increment. */
  moved(c: Color, now: number) {
    const wasRunning = this.active === c;
    if (wasRunning) this.stop(now);
    const i = this.idx(c);
    if (this.remaining[i] > 0) this.remaining[i] += this.tc.inc;
  }

  set(remaining: [number, number], now: number) {
    const a = this.active;
    this.active = null;
    this.remaining = [...remaining];
    if (a) this.run(a, now);
  }

  flagged(now: number): Color | null {
    return this.active && this.time(this.active, now) <= 0 ? this.active : null;
  }
}

/** "4:05", "0:09.3" under ten seconds, "1:02:03" for long games. */
export function fmtClockShort(ms: number): string {
  const t = Math.max(0, ms);
  if (t < 10_000) return `0:0${Math.floor(t / 1000)}.${Math.floor((t % 1000) / 100)}`;
  const s = Math.floor(t / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * How long a human-like opponent should spend on a move given its clock: roughly 1/30 of the
 * remaining time plus most of the increment, scaled by how unclear the position is (0..1).
 */
export function thinkBudget(remaining: number, inc: number, uncertainty: number): number {
  const budget = remaining / 30 + inc * 0.8;
  const want = 300 + uncertainty * budget * 1.6;
  return Math.max(150, Math.min(want, remaining * 0.25));
}
