import { Chess, type Square } from 'chess.js';
import type { SfLine } from '../engine/stockfish';
import { toMove, type Color } from '../game/rules';

/** 面向新手的讲解：战术类型识别、大白话评估、子力得失。 */

export const PIECE_NAME: Record<string, string> = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };
const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

/** 讲解中双方的称呼：`me` 是走这步棋的一方。 */
export interface Sides {
  me: string;
  opp: string;
}

export type MotifKind = 'mate' | 'fork' | 'discovered' | 'pin' | 'skewer' | 'trade-up' | 'free' | 'promote' | 'check';

export interface Motif {
  kind: MotifKind;
  text: string;
  /** 战术针对的对方棋子类型（不含王），用于在引擎变化里验证是否真的得子 */
  targets?: string[];
}

const PRIORITY: MotifKind[] = ['mate', 'fork', 'discovered', 'pin', 'skewer', 'trade-up', 'free', 'promote', 'check'];
const DIRS: Record<string, [number, number][]> = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const sqAt = (f: number, r: number) => (String.fromCharCode(97 + f) + (r + 1)) as Square;
const names = (types: string[]) => types.map((t) => PIECE_NAME[t]).join('和');

function enemySquares(c: Chess, enemy: Color): Square[] {
  const out: Square[] = [];
  for (const row of c.board()) for (const p of row) if (p && p.color === enemy) out.push(p.square);
  return out;
}

/** 值得一提的目标：王、比攻击者更值钱的子，或没有保护的子。 */
function worthAttacking(c: Chess, sq: Square, attackerType: string, enemy: Color): boolean {
  const t = c.get(sq)!.type;
  if (t === 'k') return true;
  if (VALUE[t] > VALUE[attackerType]) return true;
  return c.attackers(sq, enemy).length === 0;
}

/**
 * 识别 `fen` 局面下走 `uci` 这步棋的战术类型，按重要程度排序。
 * `victim` 是被攻击一方棋子的称呼前缀，例如“你的”“对方的”。
 */
export function detectMotifs(fen: string, uci: string, victim = '对方的'): Motif[] {
  const before = new Chess(fen);
  let m;
  try {
    m = new Chess(fen).move(toMove(uci));
  } catch {
    return [];
  }
  const after = new Chess(m.after);
  const mover = m.color as Color;
  const enemy = other(mover);
  const type = m.promotion ?? m.piece;
  const out: Motif[] = [];

  if (after.isCheckmate()) out.push({ kind: 'mate', text: '直接将杀！' });

  // 捉双：走到的棋子同时攻击两个有价值的目标
  const targets = enemySquares(after, enemy).filter(
    (sq) => after.attackers(sq, mover).includes(m.to as Square) && worthAttacking(after, sq, type, enemy),
  );
  if (targets.length >= 2 && !after.isCheckmate()) {
    const ts = targets.map((s) => after.get(s)!.type).sort((a, b) => VALUE[b] - VALUE[a]);
    out.push({ kind: 'fork', text: `${PIECE_NAME[type]}捉双：同时攻击${victim}${names(ts)}`, targets: ts.filter((t) => t !== 'k') });
  }

  // 闪击：走开的棋子让己方另一个子打开了攻击线
  if (!m.isKingsideCastle() && !m.isQueensideCastle()) {
    for (const sq of enemySquares(after, enemy)) {
      const was = new Set(before.attackers(sq, mover));
      const fresh = after.attackers(sq, mover).filter((a) => a !== m.to && a !== m.from && !was.has(a));
      const by = fresh.find((a) => worthAttacking(after, sq, after.get(a)!.type, enemy));
      if (!by) continue;
      const tt = after.get(sq)!.type;
      const byName = PIECE_NAME[after.get(by)!.type];
      out.push({
        kind: 'discovered',
        text: tt === 'k' ? `闪将：${PIECE_NAME[m.piece]}让开后，${byName}将军` : `闪击：${PIECE_NAME[m.piece]}让开后，${byName}攻击${victim}${PIECE_NAME[tt]}`,
        // 闪将得的往往是别的子，只验证得子
        targets: tt === 'k' ? undefined : [tt],
      });
      break;
    }
  }

  // 牵制 / 串击：远程子沿一条线穿过第一个子，打到后面更重要的子
  const dirs = DIRS[type];
  if (dirs) {
    const f0 = m.to.charCodeAt(0) - 97;
    const r0 = Number(m.to[1]) - 1;
    for (const [df, dr] of dirs) {
      const hit: Square[] = [];
      for (let f = f0 + df, r = r0 + dr; f >= 0 && f < 8 && r >= 0 && r < 8 && hit.length < 2; f += df, r += dr) {
        if (after.get(sqAt(f, r))) hit.push(sqAt(f, r));
      }
      if (hit.length < 2) continue;
      const [a, b] = hit.map((s) => after.get(s)!);
      if (a.color !== enemy || b.color !== enemy) continue;
      if (b.type === 'k' && a.type !== 'p') {
        out.push({ kind: 'pin', text: `牵制${victim}${PIECE_NAME[a.type]}：它身后是王，不能走开`, targets: [a.type] });
        break;
      }
      if (b.type !== 'k' && a.type !== 'p' && VALUE[b.type] > VALUE[a.type] && VALUE[b.type] > VALUE[type]) {
        out.push({ kind: 'pin', text: `牵制${victim}${PIECE_NAME[a.type]}：它一走开，身后的${PIECE_NAME[b.type]}就会被吃`, targets: [a.type, b.type] });
        break;
      }
      if (VALUE[a.type] > VALUE[b.type] && (a.type === 'k' || a.type === 'q') && (VALUE[b.type] >= 3 || !after.attackers(hit[1], enemy).length)) {
        out.push({ kind: 'skewer', text: `串击：${victim}${PIECE_NAME[a.type]}被迫躲开后，身后的${PIECE_NAME[b.type]}会被吃`, targets: a.type === 'k' ? [b.type] : [a.type, b.type] });
        break;
      }
    }
  }

  if (m.captured) {
    if (VALUE[m.captured] > VALUE[m.piece]) out.push({ kind: 'trade-up', text: `用${PIECE_NAME[m.piece]}吃${victim}${PIECE_NAME[m.captured]}，以小换大` });
    else if (!after.attackers(m.to as Square, enemy).length) out.push({ kind: 'free', text: `免费吃掉${victim}${PIECE_NAME[m.captured]}（它没有保护）` });
  }
  if (m.promotion) out.push({ kind: 'promote', text: `兵升变成${PIECE_NAME[m.promotion]}` });
  if (after.inCheck() && !after.isCheckmate()) out.push({ kind: 'check', text: '将军' });

  return out.sort((x, y) => PRIORITY.indexOf(x.kind) - PRIORITY.indexOf(y.kind));
}

/** `color` 一方被攻击、且没有保护或被更便宜的子攻击的棋子（不含王）。 */
export function hangingSquares(fen: string, color: Color): Square[] {
  const c = new Chess(fen);
  const opp = other(color);
  const out: Square[] = [];
  for (const row of c.board())
    for (const sq of row) {
      if (!sq || sq.color !== color || sq.type === 'k') continue;
      const atk = c.attackers(sq.square, opp);
      if (!atk.length) continue;
      const cheapest = Math.min(...atk.map((a) => VALUE[c.get(a)!.type]));
      if (!c.attackers(sq.square, color).length || cheapest < VALUE[sq.type]) out.push(sq.square);
    }
  return out;
}

function balance(c: Chess, pov: Color): number {
  let s = 0;
  for (const row of c.board()) for (const p of row) if (p && p.type !== 'k') s += (p.color === pov ? 1 : -1) * VALUE[p.type];
  return s;
}

/**
 * 沿着引擎变化走下去，走棋方（`fen` 中轮到的一方）净得的子力分数。
 * 只在“交换告一段落”（下一步不是吃子）的位置结算，避免停在换子中途。
 */
export function pvMaterialSwing(fen: string, pv: string[], maxPly = 8): number {
  const c = new Chess(fen);
  const pov = c.turn() as Color;
  const base = balance(c, pov);
  const deltas: number[] = [];
  const caps: boolean[] = [];
  for (const u of pv.slice(0, maxPly)) {
    try {
      caps.push(Boolean(c.move(toMove(u)).captured));
    } catch {
      break;
    }
    deltas.push(balance(c, pov) - base);
  }
  for (let k = deltas.length - 1; k >= 0; k--) if (!caps[k + 1]) return deltas[k];
  return 0;
}

const TACTICAL: MotifKind[] = ['mate', 'fork', 'discovered', 'pin', 'skewer', 'trade-up', 'free'];
/** 只靠局面本身就能确定、不需要验证的事实 */
const FACTUAL: MotifKind[] = ['mate', 'promote', 'check'];

/** 沿着变化走，统计走棋方（`fen` 中轮到的一方）吃掉的棋子类型。 */
function capturesBy(fen: string, line: string[], maxPly = 8): string[] {
  const c = new Chess(fen);
  const me = c.turn();
  const out: string[] = [];
  for (const u of line.slice(0, maxPly)) {
    try {
      const m = c.move(toMove(u));
      if (m.color === me && m.captured) out.push(m.captured);
    } catch {
      break;
    }
  }
  return out;
}

/**
 * 只保留引擎变化里真正兑现了的战术：`line` 以要讲解的着法开头，后面是引擎主变。
 * 得子类战术要求走棋方最终净得子力，并且吃到了战术针对的棋子；
 * 变化导向将杀（`mates`）时也算兑现。验证不了的就不说，宁可少说也不说错。
 */
export function confirmedMotifs(fen: string, line: string[], victim = '对方的', mates = false): Motif[] {
  if (!line.length) return [];
  const all = detectMotifs(fen, line[0], victim);
  const gain = pvMaterialSwing(fen, line);
  const caps = capturesBy(fen, line);
  return all.filter((x) => {
    if (FACTUAL.includes(x.kind)) return true;
    if (line.length < 2 && x.kind !== 'free' && x.kind !== 'trade-up') return false;
    if (mates && x.kind !== 'free' && x.kind !== 'trade-up') return true;
    if (gain < 1) return false;
    return !x.targets?.length || x.targets.some((t) => caps.includes(t));
  });
}

/** 对方在变化里是否吃掉了 `sq` 上的那个子（在它离开 `sq` 之前）。 */
function capturedOn(fen: string, line: string[], sq: string, maxPly = 6): boolean {
  const c = new Chess(fen);
  const opp = c.turn();
  for (const u of line.slice(0, maxPly)) {
    let m;
    try {
      m = c.move(toMove(u));
    } catch {
      return false;
    }
    if (m.color === opp && m.to === sq && m.captured) return true;
    if (m.color !== opp && m.from === sq) return false;
  }
  return false;
}

export interface MoveInsightInput {
  /** 走棋前局面 */
  fen: string;
  /** 实际走的着法 */
  uci: string;
  /** 走棋前的引擎最佳着法及其主变（走棋方视角） */
  best: string | null;
  bestLine?: SfLine;
  /** 走棋后对方的最佳应对及其主变（对方视角） */
  replyLine?: SfLine;
  /** 这步棋是否算坏棋（不精确及以上） */
  bad: boolean;
  sides: Sides;
}

export interface MoveInsight {
  /** 这步棋的问题（坏棋时） */
  problem: string[];
  /** 更好的着法好在哪里（坏棋时） */
  better: string[];
  /** 好棋时的表扬，没有可说的就为 null */
  praise: string | null;
}

function sanOrNull(fen: string, uci: string | null | undefined): string | null {
  if (!uci) return null;
  try {
    return new Chess(fen).move(toMove(uci)).san;
  } catch {
    return null;
  }
}

/** 用新手能理解的话解释一步棋：为什么不好、更好的棋好在哪、好棋好在哪。 */
export function explainMove(o: MoveInsightInput): MoveInsight {
  const res: MoveInsight = { problem: [], better: [], praise: null };
  const c = new Chess(o.fen);
  let m;
  try {
    m = c.move(toMove(o.uci));
  } catch {
    return res;
  }
  const { me, opp } = o.sides;
  const afterFen = m.after;
  const reply = o.replyLine?.pv[0];
  const replySan = sanOrNull(afterFen, reply);

  const rl = o.replyLine;
  const allowsMate = rl?.mate !== undefined && rl.mate > 0;

  if (!o.bad && !allowsMate) {
    const line = [o.uci, ...(rl?.pv ?? [])];
    const oppMated = rl?.mate !== undefined && rl.mate < 0;
    const motif = confirmedMotifs(o.fen, line, `${opp}的`, oppMated).find((x) => TACTICAL.includes(x.kind));
    if (motif) {
      res.praise = motif.kind === 'mate' ? '漂亮，直接将杀！' : motif.kind === 'free' || motif.kind === 'trade-up' ? `好棋！${motif.text}` : `妙着！${motif.text}`;
      return res;
    }
    if (o.uci === o.best && rl) {
      const gain = pvMaterialSwing(o.fen, line);
      if (gain >= 2) res.praise = `好棋！照这样下去${me}能赢得${materialWords(gain)}`;
    }
    return res;
  }

  if (allowsMate) {
    res.problem.push(`${opp}有 ${rl!.mate} 步杀${replySan ? `，从 <b>${replySan}</b> 开始` : ''}`);
  } else if (reply && replySan) {
    const motif = confirmedMotifs(afterFen, rl!.pv, `${me}的`).find((x) => x.kind !== 'check');
    res.problem.push(motif ? `${opp}可以走 <b>${replySan}</b>：${motif.text}` : `${opp}的最佳应对是 <b>${replySan}</b>`);
    const to = o.uci.slice(2, 4);
    if (reply.slice(2, 4) !== to && hangingSquares(afterFen, m.color as Color).includes(to as Square) && capturedOn(afterFen, rl!.pv, to)) {
      res.problem.push(`${me}刚走的${PIECE_NAME[m.promotion ?? m.piece]}在 ${to} 没有足够的保护`);
    }
    const lost = pvMaterialSwing(afterFen, rl!.pv);
    if (lost >= 1) res.problem.push(`照这样走下去，${me}会丢掉${materialWords(lost)}`);
  }

  if (o.best && o.best !== o.uci) {
    const bl = o.bestLine;
    if (bl?.mate !== undefined && bl.mate > 0) res.better.push(`${bl.mate} 步杀`);
    else {
      const line = bl?.pv[0] === o.best ? bl.pv : [o.best];
      for (const x of confirmedMotifs(o.fen, line, `${opp}的`).slice(0, 2)) res.better.push(x.text);
      const gain = pvMaterialSwing(o.fen, line);
      if (gain >= 1) res.better.push(`能赢得${materialWords(gain)}`);
    }
  }
  return res;
}

/** 子力分数换成新手听得懂的说法。 */
export function materialWords(points: number): string {
  if (points >= 9) return '大约一个后';
  if (points >= 5) return '大约一个车';
  if (points >= 3) return '大约一个马或象';
  if (points >= 2) return '大约两个兵';
  return '大约一个兵';
}

/**
 * 把引擎评估说成大白话。`line` 是轮到 `turn` 一方走时的评估，`pov` 是“我”一方。
 * 1 个兵 ≈ 100 分（+1.00）。
 */
export function plainEval(line: SfLine | undefined, turn: Color, pov: Color, s: Sides): string {
  if (!line) return '';
  if (line.mate !== undefined) {
    if (line.mate === 0) return '';
    const who = (line.mate > 0) === (turn === pov) ? s.me : s.opp;
    return `${who}能在 ${Math.abs(line.mate)} 步内将杀`;
  }
  const v = ((turn === pov ? 1 : -1) * (line.cp ?? 0)) / 100;
  const who = v > 0 ? s.me : s.opp;
  const a = Math.abs(v);
  if (a < 0.3) return '双方大致均势';
  if (a < 0.8) return `${who}稍好一点`;
  if (a < 1.6) return `${who}大约多一个兵的优势`;
  if (a < 2.6) return `${who}明显占优（约多两个兵）`;
  if (a < 4.5) return `${who}大优（约相当于多一个马或象）`;
  if (a < 7) return `${who}胜势（约相当于多一个车）`;
  return `${who}几乎必胜`;
}
