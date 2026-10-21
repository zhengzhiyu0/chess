import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { confirmedMotifs, detectMotifs, firstTactic, type MotifKind } from '../src/coach/explain';
import { toMove } from '../src/game/rules';

/**
 * 用 Lichess 谜题评测战术识别，谜题的主题标签作为“标准答案”。
 * 题目局面 = FEN 走完 Moves[0]；解答 = 其余着法，相当于引擎主变。
 * 和讲解卡一样沿解答找：解答方第一处识别出战术的那一步就是“讲解会说的话”，
 * 再加上整条解答里出现的将杀、升变。
 * 精确率 = 说了 X 的题里，标签确实含 X 的比例；召回率 = 标签含 X 的题里，说了 X 的比例。
 * Lichess 的标签也是程序打的、并不完备（比如后捉双常被只标成 pin），
 * 所以精确率是“与标签一致率”，是真实准确率的下限；人工抽查见 README。
 */

type Row = [string, string, string, number, string];
const { puzzles } = JSON.parse(readFileSync(new URL('./fixtures/puzzles.json', import.meta.url), 'utf8')) as { puzzles: Row[] };

/** 识别类型 → 认为与之相符的 Lichess 主题；第一个用来统计召回率 */
const MAP: Partial<Record<MotifKind, string[]>> = {
  mate: ['mate'],
  'double-check': ['doubleCheck'],
  fork: ['fork'],
  pin: ['pin'],
  skewer: ['skewer', 'xRayAttack'],
  discovered: ['discoveredAttack', 'doubleCheck'],
  'remove-defender': ['capturingDefender', 'deflection', 'overloading'],
  trapped: ['trappedPiece'],
  free: ['hangingPiece', 'capturingDefender', 'trappedPiece'],
  promote: ['promotion', 'underPromotion'],
};

/** 当前实测值往下留一点余量的下限，防止以后改规则时悄悄退化 */
const FLOOR: Partial<Record<MotifKind, { p: number; r: number }>> = {
  mate: { p: 0.98, r: 0.98 },
  'double-check': { p: 0.95, r: 0.8 },
  fork: { p: 0.62, r: 0.75 },
  pin: { p: 0.5, r: 0.28 },
  skewer: { p: 0.84, r: 0.7 },
  discovered: { p: 0.8, r: 0.72 },
  'remove-defender': { p: 0.62, r: 0.45 },
  trapped: { p: 0.72, r: 0.65 },
  free: { p: 0.37, r: 0.82 },
  promote: { p: 0.98, r: 0.98 },
};

const ANYWHERE: MotifKind[] = ['mate', 'promote', 'double-check'];

function said(fen: string, moves: string[]): Set<MotifKind> {
  const c = new Chess(fen);
  c.move(toMove(moves[0]));
  const start = c.fen();
  const sol = moves.slice(1);
  for (const u of sol) c.move(toMove(u));
  const mates = c.isCheckmate();
  const out = new Set<MotifKind>();
  // 和讲解卡一样：沿解答找第一处兑现的战术，那一步识别出的类型都算
  const t = firstTactic(start, sol, '对方的', mates);
  if (t) {
    const at = new Chess(start);
    for (const u of sol.slice(0, t.ply)) at.move(toMove(u));
    for (const m of confirmedMotifs(at.fen(), sol.slice(t.ply), '对方的', mates)) out.add(m.kind);
  }
  // 将杀、升变、双将这类事实，整条解答里出现就算
  const d = new Chess(start);
  for (let i = 0; i < sol.length; i += 2) {
    for (const m of detectMotifs(d.fen(), sol[i])) if (ANYWHERE.includes(m.kind)) out.add(m.kind);
    d.move(toMove(sol[i]));
    if (sol[i + 1]) d.move(toMove(sol[i + 1]));
  }
  return out;
}

describe('Lichess 谜题评测', () => {
  it('各类战术的精确率与召回率', () => {
    const stat: Record<string, { said: number; right: number; tagged: number; hit: number }> = {};
    for (const k of Object.keys(MAP)) stat[k] = { said: 0, right: 0, tagged: 0, hit: 0 };
    for (const [, fen, moves, , themes] of puzzles) {
      const ts = new Set(themes.split(' '));
      if ([...ts].some((t) => t.startsWith('mateIn') || t.endsWith('Mate'))) ts.add('mate');
      const found = said(fen, moves.split(' '));
      for (const [k, tags] of Object.entries(MAP) as [MotifKind, string[]][]) {
        const s = stat[k];
        if (found.has(k)) {
          s.said++;
          if (tags.some((t) => ts.has(t))) s.right++;
        }
        if (ts.has(tags[0])) {
          s.tagged++;
          if (found.has(k)) s.hit++;
        }
      }
    }
    const table = Object.entries(stat).map(([k, s]) => ({
      kind: k,
      said: s.said,
      precision: +(s.right / Math.max(1, s.said)).toFixed(3),
      tagged: s.tagged,
      recall: +(s.hit / Math.max(1, s.tagged)).toFixed(3),
    }));
    console.table(table);
    for (const row of table) {
      const f = FLOOR[row.kind as MotifKind];
      if (!f) continue;
      expect.soft(row.precision, `${row.kind} 精确率`).toBeGreaterThanOrEqual(f.p);
      expect.soft(row.recall, `${row.kind} 召回率`).toBeGreaterThanOrEqual(f.r);
    }
  });
});
