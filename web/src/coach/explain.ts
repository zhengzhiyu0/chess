import { Chess, type Move, type Square } from 'chess.js';
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

export type MotifKind =
  | 'mate'
  | 'double-check'
  | 'fork'
  | 'discovered'
  | 'pin'
  | 'skewer'
  | 'remove-defender'
  | 'trapped'
  | 'trade-up'
  | 'free'
  | 'mate-threat'
  | 'promote'
  | 'check';

export interface Motif {
  kind: MotifKind;
  text: string;
  /** 战术针对的对方棋子所在的格子（不含王），用于在引擎变化里验证是否真的吃到了它 */
  targets?: Square[];
  /** 这步棋本身就得了子（吃子类），不需要后续变化来验证目标 */
  immediate?: boolean;
}

const PRIORITY: MotifKind[] = ['mate', 'double-check', 'fork', 'discovered', 'pin', 'skewer', 'remove-defender', 'trapped', 'trade-up', 'free', 'mate-threat', 'promote', 'check'];
const DIRS: Record<string, [number, number][]> = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const sqAt = (f: number, r: number) => (String.fromCharCode(97 + f) + (r + 1)) as Square;

function enemySquares(c: Chess, enemy: Color): Square[] {
  const out: Square[] = [];
  for (const row of c.board()) for (const p of row) if (p && p.color === enemy) out.push(p.square);
  return out;
}

/** 把轮到走棋的一方换成 `color`（用来问“如果现在轮到这一方，它能吃到什么”）。 */
function withTurn(fen: string, color: Color): Chess | null {
  const p = fen.split(' ');
  if (p[1] !== color) {
    p[1] = color;
    p[3] = '-';
  }
  try {
    return new Chess(p.join(' '));
  } catch {
    return null;
  }
}

/**
 * 静态交换评估：轮到的一方在 `sq` 上先吃，双方轮流用最便宜的子回吃、随时可以停手，
 * 返回先吃一方的净得；吃不到返回 null。只用合法着法，所以被牵制的子不会参与。
 */
function exchange(c: Chess, sq: Square): number | null {
  const target = c.get(sq);
  if (!target) return null;
  const side = c.turn();
  // 按价值从小到大试，被牵制等不合法的吃法 chess.js 会拒绝
  const atk = c.attackers(sq, side).sort((a, b) => VALUE[c.get(a)!.type] - VALUE[c.get(b)!.type]);
  for (const from of atk) {
    const p = c.get(from)!;
    const promo = p.type === 'p' && (sq[1] === '8' || sq[1] === '1');
    try {
      c.move({ from, to: sq, promotion: promo ? 'q' : undefined });
    } catch {
      continue;
    }
    const reply = exchange(c, sq);
    c.undo();
    return VALUE[target.type] + (promo ? 8 : 0) - Math.max(0, reply ?? 0);
  }
  return null;
}

/** `by` 一方去吃 `sq` 上的子能净得多少，吃不到为 null。 */
function seeFor(fen: string, sq: Square, by: Color): number | null {
  const c = withTurn(fen, by);
  return c ? exchange(c, sq) : null;
}

/** `by` 一方用 `from` 上的子去吃 `sq` 上的子能净得多少，吃不到为 null。 */
function seeWith(fen: string, from: Square, sq: Square, by: Color): number | null {
  const c = withTurn(fen, by);
  const t = c?.get(sq);
  if (!c || !t) return null;
  const promo = c.get(from)?.type === 'p' && (sq[1] === '8' || sq[1] === '1');
  try {
    c.move({ from, to: sq, promotion: promo ? 'q' : undefined });
  } catch {
    return null;
  }
  return VALUE[t.type] + (promo ? 8 : 0) - Math.max(0, exchange(c, sq) ?? 0);
}

interface Pin {
  pinner: Square;
  pinned: Square;
  behind: Square;
  absolute: boolean;
}

/** `by` 一方的远程子造成的牵制：对方的子一走开，身后的王或更值钱的子就会被攻击。 */
function pinsBy(c: Chess, by: Color): Pin[] {
  const out: Pin[] = [];
  for (const row of c.board())
    for (const p of row) {
      if (!p || p.color !== by || !DIRS[p.type]) continue;
      const f0 = p.square.charCodeAt(0) - 97;
      const r0 = Number(p.square[1]) - 1;
      for (const [df, dr] of DIRS[p.type]) {
        const hit: Square[] = [];
        for (let f = f0 + df, r = r0 + dr; f >= 0 && f < 8 && r >= 0 && r < 8 && hit.length < 2; f += df, r += dr) {
          if (c.get(sqAt(f, r))) hit.push(sqAt(f, r));
        }
        if (hit.length < 2) continue;
        const [a, b] = hit.map((s) => c.get(s)!);
        if (a.color === by || b.color === by || a.type === 'k' || a.type === 'p') continue;
        const absolute = b.type === 'k';
        if (absolute || (VALUE[b.type] > VALUE[a.type] && VALUE[b.type] > VALUE[p.type])) {
          out.push({ pinner: p.square, pinned: hit[0], behind: hit[1], absolute });
        }
      }
    }
  return out;
}

/** `sq` 上的子是否被 `by` 一方牵制在王前：把它拿掉，`king` 就会多受到攻击。兵也算。 */
function pinnedToKing(fen: string, sq: Square, king: Square, by: Color): boolean {
  const c = new Chess(fen);
  const n = c.attackers(king, by).length;
  c.remove(sq);
  return c.attackers(king, by).length > n;
}

/** 值得攻击的目标：王，或者用 `from` 上的子吃它能净得子力。 */
function worthHitting(fen: string, from: Square, sq: Square, by: Color, c: Chess): boolean {
  return c.get(sq)!.type === 'k' || (seeWith(fen, from, sq, by) ?? 0) > 0;
}

/** 被攻击后无路可逃：每一步逃法都会被吃亏，而且攻击它的子比它便宜（加保护也没用）。 */
function isTrapped(after: Chess, sq: Square, mover: Color): boolean {
  const t = after.get(sq)!;
  const atk = after.attackers(sq, mover);
  if (!atk.length || Math.min(...atk.map((a) => VALUE[after.get(a)!.type])) >= VALUE[t.type]) return false;
  for (const mv of after.moves({ square: sq, verbose: true })) {
    after.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    const lost = exchange(after, mv.to as Square) ?? 0;
    after.undo();
    if ((mv.captured ? VALUE[mv.captured] : 0) - Math.max(0, lost) >= 0) return false;
  }
  return true;
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
  const to = m.to as Square;
  const mated = after.isCheckmate();
  const check = after.inCheck();
  const out: Motif[] = [];
  const name = (sq: Square) => PIECE_NAME[after.get(sq)!.type];

  if (mated) out.push({ kind: 'mate', text: '直接将杀！' });

  const kingSq = enemySquares(after, enemy).find((s) => after.get(s)!.type === 'k');
  if (check && !mated && kingSq && after.attackers(kingSq, mover).length >= 2) {
    out.push({ kind: 'double-check', text: '双将：两个子同时将军，对方只能走王' });
  }

  // 捉双：走到的棋子同时攻击两个目标（王，或吃了能净得子力的非兵棋子），自己又不会被白吃
  const forked = enemySquares(after, enemy).filter(
    (sq) => after.get(sq)!.type !== 'p' && after.attackers(sq, mover).includes(to) && worthHitting(m.after, to, sq, mover, after),
  );
  if (forked.length >= 2 && !mated && (seeFor(m.after, to, enemy) ?? 0) <= 0) {
    const ts = forked.sort((a, b) => VALUE[after.get(b)!.type] - VALUE[after.get(a)!.type]);
    out.push({ kind: 'fork', text: `${PIECE_NAME[type]}捉双：同时攻击${victim}${ts.map(name).join('和')}`, targets: ts.filter((s) => s !== kingSq) });
  }

  // 闪击：走开的棋子让己方另一个子打开了攻击线
  if (!m.isKingsideCastle() && !m.isQueensideCastle()) {
    for (const sq of enemySquares(after, enemy)) {
      const was = new Set(before.attackers(sq, mover));
      const fresh = after.attackers(sq, mover).filter((a) => a !== to && a !== m.from && !was.has(a));
      const by = fresh.find((a) => worthHitting(m.after, a, sq, mover, after));
      if (!by) continue;
      const byName = name(by);
      out.push({
        kind: 'discovered',
        text: sq === kingSq ? `闪将：${PIECE_NAME[m.piece]}让开后，${byName}将军` : `闪击：${PIECE_NAME[m.piece]}让开后，${byName}攻击${victim}${name(sq)}`,
        // 闪将得的往往是别的子，只验证得子
        targets: sq === kingSq ? undefined : [sq],
      });
      break;
    }
  }

  // 牵制：这步棋造成了新的牵制，或者去攻击一个已经被牵制、不能走开的子
  // 被牵制的子也保护不了别的子，所以它原本保护的子也算目标
  const guarded = (p: Pin) => enemySquares(after, enemy).filter((s) => s !== kingSq && after.attackers(s, enemy).includes(p.pinned));
  const old = new Set(pinsBy(before, mover).map((p) => p.pinned + p.behind));
  const pins = pinsBy(after, mover);
  // 被牵制的子能直接吃掉牵制者（或攻击者）而不亏，就不算牵制
  const escapes = (p: Pin, by: Square) => (seeWith(m.after, p.pinned, by, enemy) ?? -1) >= 0;
  const fresh = pins.find((p) => !old.has(p.pinned + p.behind) && !escapes(p, p.pinner));
  const hitPinned = pins.find(
    (p) =>
      after.attackers(p.pinned, mover).includes(to) &&
      !before.attackers(p.pinned, mover).includes(m.from) &&
      !escapes(p, to) &&
      !escapes(p, p.pinner) &&
      (VALUE[type] < VALUE[after.get(p.pinned)!.type] || worthHitting(m.after, to, p.pinned, mover, after)),
  );
  if (fresh) {
    out.push({
      kind: 'pin',
      text: fresh.absolute
        ? `牵制${victim}${name(fresh.pinned)}：它身后是王，不能走开`
        : `牵制${victim}${name(fresh.pinned)}：它一走开，身后的${name(fresh.behind)}就会被吃`,
      targets: [fresh.pinned, ...(fresh.absolute ? guarded(fresh) : [fresh.behind])],
    });
  } else if (hitPinned) {
    out.push({ kind: 'pin', text: `攻击被牵制的${victim}${name(hitPinned.pinned)}：它不能走开`, targets: [hitPinned.pinned, ...guarded(hitPinned)] });
  }

  // 串击：远程子先打到前面更重要的子，它躲开后身后的子会被吃
  const dirs = DIRS[type];
  if (dirs) {
    const f0 = to.charCodeAt(0) - 97;
    const r0 = Number(to[1]) - 1;
    for (const [df, dr] of dirs) {
      const hit: Square[] = [];
      for (let f = f0 + df, r = r0 + dr; f >= 0 && f < 8 && r >= 0 && r < 8 && hit.length < 2; f += df, r += dr) {
        if (after.get(sqAt(f, r))) hit.push(sqAt(f, r));
      }
      if (hit.length < 2) continue;
      const [a, b] = hit.map((s) => after.get(s)!);
      if (a.color !== enemy || b.color !== enemy) continue;
      if (VALUE[a.type] > VALUE[b.type] && (a.type === 'k' || a.type === 'q') && VALUE[b.type] >= 3 && (VALUE[b.type] > VALUE[type] || !after.attackers(hit[1], enemy).length)) {
        out.push({ kind: 'skewer', text: `串击：${victim}${PIECE_NAME[a.type]}被迫躲开后，身后的${PIECE_NAME[b.type]}会被吃`, targets: a.type === 'k' ? [hit[1]] : hit });
        break;
      }
    }
  }

  if (m.captured) {
    const rec = exchange(after, to);
    const net = VALUE[m.captured] - Math.max(0, rec ?? 0);
    if (VALUE[m.captured] > VALUE[m.piece] && net > 0) out.push({ kind: 'trade-up', text: `用${PIECE_NAME[m.piece]}吃${victim}${PIECE_NAME[m.captured]}，以小换大` });
    else if (rec === null) {
      const guards = after.attackers(to, enemy).filter((s) => after.get(s)!.type !== 'k');
      // 能回吃的子却不能合法回吃：要么它被牵制在王前，要么对方正被将军（闪将、双将）得先应将
      const pinned = guards.find((s) => kingSq && pinnedToKing(m.after, s, kingSq, mover));
      // 闪将、双将本身已经是讲解的重点，把“无法回吃”补在它后面
      const checker = check && out.find((x) => x.kind === 'discovered' || x.kind === 'double-check');
      const lost = `${PIECE_NAME[m.captured]}白白丢掉`;
      if (pinned) out.push({ kind: 'pin', text: `${victim}${name(pinned)}被牵制，不能回吃，${lost}`, immediate: true });
      else if (guards.length && checker) checker.text += `，${victim.replace(/的$/, '')}正被将军，无法回吃，${lost}`;
      else if (guards.length && check) out.push({ kind: 'free', text: `${victim.replace(/的$/, '')}正被将军，${name(guards[0])}无法回吃，${lost}` });
      else out.push({ kind: 'free', text: `免费吃掉${victim}${PIECE_NAME[m.captured]}（它没有保护）` });
    }

    // 吃掉保护者：被吃的子原本保护着另一个子，现在那个子可以被白吃
    for (const sq of enemySquares(after, enemy)) {
      if (sq === kingSq || after.get(sq)!.type === 'p' || !before.attackers(sq, enemy).includes(to)) continue;
      // 目标子自己能回吃的话只是普通换子
      if (after.attackers(to, enemy).includes(sq)) continue;
      if ((seeFor(fen, sq, mover) ?? 0) > 0 || (seeFor(m.after, sq, mover) ?? 0) <= 0) continue;
      out.push({
        kind: 'remove-defender',
        text: `吃掉保护者：${victim}${PIECE_NAME[m.captured]}原本保护着${name(sq)}，现在${name(sq)}保不住了`,
        targets: [sq],
      });
      break;
    }
  }

  // 困子：新受到攻击的子无路可逃
  if (!check) {
    for (const sq of enemySquares(after, enemy)) {
      const t = after.get(sq)!.type;
      if (VALUE[t] < 3 || t === 'k' || !after.attackers(sq, mover).includes(to)) continue;
      if ((seeFor(fen, sq, mover) ?? 0) > 0 || (seeFor(m.after, sq, mover) ?? 0) <= 0 || !isTrapped(after, sq, mover)) continue;
      out.push({ kind: 'trapped', text: `困住${victim}${PIECE_NAME[t]}：它被攻击了，却无路可逃`, targets: [sq] });
      break;
    }
  }

  // 杀棋威胁：安静的一步，如果对方不理会，下一步就能将杀
  if (!m.captured && !check) {
    const c = withTurn(m.after, mover);
    const mate = c?.moves({ verbose: true }).find((mv) => mv.san.endsWith('#'));
    if (mate) out.push({ kind: 'mate-threat', text: `威胁下一步 <b>${mate.san}</b> 将杀` });
  }

  if (m.promotion) out.push({ kind: 'promote', text: `兵升变成${PIECE_NAME[m.promotion]}` });
  if (check && !mated) out.push({ kind: 'check', text: '将军' });

  return out.sort((x, y) => PRIORITY.indexOf(x.kind) - PRIORITY.indexOf(y.kind));
}

/** `color` 一方会被对方吃亏的棋子（不含王）：对方去吃它能净得子力。被牵制的保护者不算保护。 */
export function hangingSquares(fen: string, color: Color): Square[] {
  const c = new Chess(fen);
  const opp = other(color);
  const out: Square[] = [];
  for (const row of c.board())
    for (const sq of row) {
      if (!sq || sq.color !== color || sq.type === 'k' || !c.attackers(sq.square, opp).length) continue;
      if ((seeFor(fen, sq.square, opp) ?? 0) > 0) out.push(sq.square);
    }
  return out;
}

/**
 * 弃子：走完 `uci` 后，走棋方有一个马/象及以上的棋子能被对方净吃（SEE），且走之前它并不悬着；
 * 吃子后直接换得更多的不算（如以车换后）。
 */
export function isSacrifice(fen: string, uci: string): boolean {
  const c = new Chess(fen);
  const mover = c.turn() as Color;
  let mv;
  try {
    mv = c.move(toMove(uci));
  } catch {
    return false;
  }
  if (c.isCheckmate()) return false;
  const after = c.fen();
  const gained = mv.captured ? VALUE[mv.captured] : 0;
  const before = new Set(hangingSquares(fen, mover));
  for (const sq of hangingSquares(after, mover)) {
    const p = c.get(sq);
    if (!p || VALUE[p.type] < 3) continue;
    if (before.has(sq) && sq !== mv.to) continue;
    if ((seeFor(after, sq, other(mover)) ?? 0) - gained >= 2) return true;
  }
  return false;
}

function balance(c: Chess, pov: Color): number {
  let s = 0;
  for (const row of c.board()) for (const p of row) if (p && p.type !== 'k') s += (p.color === pov ? 1 : -1) * VALUE[p.type];
  return s;
}

/**
 * 沿着引擎变化走下去，走棋方（`fen` 中轮到的一方）净得的子力分数。
 * 只在“交换告一段落”（下一步不是吃子）的位置结算，避免停在换子中途；
 * 走到 `maxPly` 时还在吃子，就接着往后走，直到出现不吃子的一步（或变化结束）。
 */
export function pvMaterialSwing(fen: string, pv: string[], maxPly = 8): number {
  const c = new Chess(fen);
  const pov = c.turn() as Color;
  const base = balance(c, pov);
  const deltas: number[] = [];
  const caps: boolean[] = [];
  for (let i = 0; i < pv.length && (i < maxPly || caps[i - 1]); i++) {
    try {
      caps.push(Boolean(c.move(toMove(pv[i])).captured));
    } catch {
      break;
    }
    deltas.push(balance(c, pov) - base);
  }
  for (let k = deltas.length - 1; k >= 0; k--) if (!caps[k + 1]) return deltas[k];
  return 0;
}

const TACTICAL: MotifKind[] = ['mate', 'double-check', 'fork', 'discovered', 'pin', 'skewer', 'remove-defender', 'trapped', 'trade-up', 'free', 'mate-threat'];
/** 后续几步里值得提前点出来的战术（白吃、换子这类不算） */
const FOLLOW_UP: MotifKind[] = ['double-check', 'fork', 'discovered', 'pin', 'skewer', 'remove-defender', 'trapped'];
const WEAK: MotifKind[] = ['free', 'trade-up'];
/** 讲对手的应对时第一步就值得说的（除了单纯将军） */
const PROBLEM: MotifKind[] = PRIORITY.filter((k) => k !== 'check');
/** 对手只是回吃完成换子时，第一步不算白吃、以小换大 */
const EVEN: MotifKind[] = PROBLEM.filter((k) => !WEAK.includes(k));
/** 只靠局面本身就能确定、不需要验证的事实 */
const FACTUAL: MotifKind[] = ['mate', 'double-check', 'mate-threat', 'promote', 'check'];

/** 走棋方（`fen` 中轮到的一方）在变化里是否吃到了 `targets` 上的子；目标子走开了就跟到新格子。 */
function wonTarget(fen: string, line: string[], targets: Square[], maxPly = 8): boolean {
  const c = new Chess(fen);
  const me = c.turn();
  const cur = new Set<string>(targets);
  for (const u of line.slice(0, maxPly)) {
    let m;
    try {
      m = c.move(toMove(u));
    } catch {
      break;
    }
    if (m.color === me) {
      if (m.captured && cur.has(m.to)) return true;
    } else if (cur.has(m.from)) {
      cur.delete(m.from);
      cur.add(m.to);
    }
  }
  return false;
}

/**
 * 只保留引擎变化里真正兑现了的战术：`line` 以要讲解的着法开头，后面是引擎主变。
 * 得子类战术要求走棋方最终净得子力，并且吃到了战术针对的棋子；
 * 变化导向将杀（`mates`）时也算兑现。验证不了的就不说，宁可少说也不说错。
 * `owed` 是对方上一步刚得到的子力（讲对方应对时），要先扣掉，免得把换子算成得子。
 */
export function confirmedMotifs(fen: string, line: string[], victim = '对方的', mates = false, owed = 0): Motif[] {
  if (!line.length) return [];
  const all = detectMotifs(fen, line[0], victim);
  const gain = pvMaterialSwing(fen, line) - owed;
  return all.filter((x) => {
    const capture = x.immediate || x.kind === 'free' || x.kind === 'trade-up';
    if (FACTUAL.includes(x.kind)) return true;
    if (line.length < 2 && !capture) return false;
    if (mates && !capture) return true;
    if (gain < 1) return false;
    return !x.targets?.length || wonTarget(fen, line, x.targets);
  });
}

export interface Tactic {
  motif: Motif;
  /** 战术出现在 `line` 的第几步，0 表示第一步 */
  ply: number;
  /** 出现战术的那步棋（ply > 0 时） */
  san: string | null;
}

/**
 * 沿着变化找走棋方第一个兑现了的战术：第一步没有，就看它后面自己的几步棋。
 * 这样“先弃子、再捉双”这类组合也能讲出关键的那一步。`owed` 见 confirmedMotifs，只用于第一步。
 */
export function firstTactic(fen: string, line: string[], victim = '对方的', mates = false, kinds: MotifKind[] = TACTICAL, maxPly = 4, owed = 0): Tactic | null {
  const c = new Chess(fen);
  let fallback: Tactic | null = null;
  for (let i = 0; i < line.length && i <= maxPly; i += 2) {
    const ms = confirmedMotifs(c.fen(), line.slice(i), victim, mates, i ? 0 : owed);
    const motif = ms.find((x) => (i ? FOLLOW_UP : kinds).includes(x.kind));
    if (motif) {
      const t = { motif, ply: i, san: i ? sanOrNull(c.fen(), line[i]) : null };
      // 只是吃个子的话，看看后面有没有更关键的战术
      if (!WEAK.includes(motif.kind)) return t;
      fallback ??= t;
    }
    try {
      c.move(toMove(line[i]));
      if (line[i + 1]) c.move(toMove(line[i + 1]));
    } catch {
      break;
    }
  }
  return fallback;
}

/**
 * `m` 本身吃了子，对方的应对 `reply` 又在同一格回吃：这是换子，不能讲成“免费吃子”“以小换大”
 * （换亏了的话，后面“会丢掉多少”那句会说）。
 */
function isRecapture(m: Move, reply: string | undefined): boolean {
  return Boolean(m.captured) && reply?.slice(2, 4) === m.to;
}

/** 这步棋本身得到的子力：吃到的子，加上升变多出来的。 */
function gainOf(m: Move): number {
  return (m.captured ? VALUE[m.captured] : 0) + (m.promotion ? VALUE[m.promotion] - 1 : 0);
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
  // Locally generated HTML fragments; SAN highlights use <b> tags.
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
    const t = firstTactic(o.fen, line, `${opp}的`, oppMated);
    if (t) {
      const x = t.motif;
      if (t.ply) res.praise = `妙着！这步为后面铺路：接着 <b>${t.san}</b>，${x.text}`;
      else res.praise = x.kind === 'mate' ? '漂亮，直接将杀！' : x.kind === 'free' || x.kind === 'trade-up' ? `好棋！${x.text}` : `妙着！${x.text}`;
      return res;
    }
    if (o.uci === o.best && rl) {
      const gain = pvMaterialSwing(o.fen, line);
      if (gain >= 2) res.praise = `好棋！照这样下去${me}能赢得${materialWords(gain)}`;
      else {
        // A best move can still leave the player worse (for example, a forced defence).
        // Do not praise it just because it is first in the engine's move ordering.
        const moverCp = -(rl.cp ?? 0);
        if (rl.mate !== undefined ? rl.mate < 0 : moverCp >= -60) {
          const position = plainEval(rl, other(m.color as Color), m.color as Color, { me, opp });
          res.praise = `引擎认可的好棋。按主变，${position || '局面保持平衡'}`;
        }
      }
    }
    return res;
  }

  if (allowsMate) {
    res.problem.push(`${opp}有 ${rl!.mate} 步杀${replySan ? `，从 <b>${replySan}</b> 开始` : ''}`);
  } else if (reply && replySan) {
    const t = firstTactic(afterFen, rl!.pv, `${me}的`, false, isRecapture(m, reply) ? EVEN : PROBLEM, undefined, gainOf(m));
    if (!t) {
      // Avoid decorating a nearly equal recapture with noisy centipawn prose.
      const result = Math.abs(rl!.cp ?? 0) >= 60 || rl!.mate !== undefined
        ? plainEval(rl!, other(m.color as Color), m.color as Color, { me, opp })
        : '';
      res.problem.push(`${opp}的最佳应对是 <b>${replySan}</b>${result ? `；照主变发展，${result}` : ''}`);
    }
    else if (!t.ply) res.problem.push(`${opp}可以走 <b>${replySan}</b>：${t.motif.text}`);
    else res.problem.push(`${opp}可以走 <b>${replySan}</b>，接着 <b>${t.san}</b>：${t.motif.text}`);
    const to = o.uci.slice(2, 4);
    if (reply.slice(2, 4) !== to && hangingSquares(afterFen, m.color as Color).includes(to as Square) && capturedOn(afterFen, rl!.pv, to)) {
      res.problem.push(`${me}刚走的${PIECE_NAME[m.promotion ?? m.piece]}在 ${to} 没有足够的保护`);
    }
    // 以走棋前为基准：这步棋自己吃到的子也算进去
    const lost = -pvMaterialSwing(o.fen, [o.uci, ...rl!.pv]);
    if (lost >= 1) res.problem.push(`照这样走下去，${me}会丢掉${materialWords(lost)}`);
  }

  if (o.bad && (!rl || !rl.pv.length)) {
    res.problem.push(`${opp}的后续变化数据不足，暂时无法可靠确认这步棋具体输在哪里。`);
  }

  if (o.best && o.best !== o.uci) {
    const bl = o.bestLine;
    if (!bl) {
      res.better.push(`Stockfish 建议尝试 <b>${sanOrNull(o.fen, o.best) ?? '候选着法'}</b>，但当前没有足够的主变数据说明它具体好在哪里。`);
    } else if (bl.mate !== undefined && bl.mate > 0) res.better.push(`${bl.mate} 步杀`);
    else {
      const line = bl?.pv[0] === o.best ? bl.pv : [o.best];
      const first = confirmedMotifs(o.fen, line, `${opp}的`).slice(0, 2);
      for (const x of first) res.better.push(x.text);
      const t = first.some((x) => TACTICAL.includes(x.kind)) ? null : firstTactic(o.fen, line, `${opp}的`, false, []);
      if (t) res.better.push(`接着 <b>${t.san}</b>：${t.motif.text}`);
      const gain = pvMaterialSwing(o.fen, line);
      if (gain >= 1) res.better.push(`能赢得${materialWords(gain)}`);
    }
    if (!res.better.length && bl) {
      const position = plainEval(bl, m.color as Color, m.color as Color, { me, opp });
      res.better.push(position ? `引擎主变评估：${position}` : 'Stockfish 在当前分析深度下更倾向这步棋');
    }
  } else if (o.bad && !o.best) {
    res.better.push('当前分析没有可靠的最佳着法，建议加深 Stockfish 分析后再比较。');
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
/** 错题本的错误类型：坏棋主要错在哪（优先：被将杀 > 漏杀 > 被对方战术打击 > 漏掉自己的战术 > 丢子 > 局面判断）。 */
export interface MistakeTag {
  /** 稳定的类别 id，用于统计 */
  id: string;
  label: string;
}

const KIND_LABEL: Partial<Record<MotifKind, string>> = {
  'double-check': '双将',
  fork: '捉双',
  discovered: '闪击',
  pin: '牵制',
  skewer: '串击',
  'remove-defender': '吃掉保护者',
  trapped: '困子',
  'trade-up': '以小换大',
  free: '白吃子',
  'mate-threat': '杀棋威胁',
  promote: '升变',
};

export function mistakeTag(o: { fen: string; uci: string; best: string | null; bestLine?: SfLine; replyLine?: SfLine }): MistakeTag {
  const rl = o.replyLine;
  if (rl?.mate !== undefined && rl.mate > 0) return { id: 'allow-mate', label: '没看到对方的杀棋' };
  const bl = o.bestLine;
  if (o.best && o.best !== o.uci && bl?.mate !== undefined && bl.mate > 0) return { id: 'miss-mate', label: '错过将杀' };
  let m: Move;
  try {
    m = new Chess(o.fen).move(toMove(o.uci));
  } catch {
    return { id: 'other', label: '其他' };
  }
  const after = m.after;
  const to = m.to as Square;
  if (rl?.pv.length) {
    const t = firstTactic(after, rl.pv, '你的', false, isRecapture(m, rl.pv[0]) ? EVEN : PROBLEM, undefined, gainOf(m));
    const k = t?.motif.kind;
    if (k === 'free' || k === 'trade-up') return { id: 'hanging', label: '丢子（没保护好棋子）' };
    if (k && KIND_LABEL[k]) return { id: `allow-${k}`, label: `被对方${KIND_LABEL[k]}` };
  }
  if (o.best && o.best !== o.uci) {
    const line = bl?.pv[0] === o.best ? bl.pv : [o.best];
    const t = firstTactic(o.fen, line, '对方的');
    const k = t?.motif.kind;
    if (k === 'free' || k === 'trade-up') return { id: 'miss-material', label: '没吃到对方送的子' };
    if (k && k !== 'mate' && KIND_LABEL[k]) return { id: `miss-${k}`, label: `错过${KIND_LABEL[k]}` };
  }
  // 刚走的子被吃要扣掉这步自己吃到的；变化里的得失也以走棋前为基准
  const exposed = (seeFor(after, to, other(m.color as Color)) ?? 0) - gainOf(m) > 0;
  if (exposed || (rl?.pv.length && -pvMaterialSwing(o.fen, [o.uci, ...rl.pv]) >= 2)) return { id: 'hanging', label: '丢子（没保护好棋子）' };
  return { id: 'positional', label: '局面判断失误' };
}
