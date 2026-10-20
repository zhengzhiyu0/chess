import { Chess } from 'chess.js';
import { GameTree, type GNode } from './tree';
import { START_FEN, turnOf, moveNumberOf, uciOf } from './rules';

export type Headers = Record<string, string>;

/** Extra annotations computed by the app (e.g. engine review), merged into the exported PGN. */
export interface Annotation {
  nags?: number[];
  /** PGN command such as `[%eval 0.35]` placed before the comment text */
  commands?: string[];
  comment?: string;
}

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);
const SUFFIX_NAG: Record<string, number> = { '!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6 };

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function parseClock(text: string): number | null {
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

function escapeComment(s: string) {
  return s.replace(/[{}]/g, '');
}

function escapeHeader(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Exports the full tree: variations, comments, NAGs, clocks and any extra annotations. */
export function exportPgn<A extends object>(tree: GameTree<A>, headers: Headers, annotate?: (n: GNode<A>) => Annotation | undefined): string {
  const h: Headers = { ...headers };
  const start = tree.root.fen;
  if (start !== START_FEN) {
    h.SetUp = '1';
    h.FEN = start;
  }
  h.Result ??= '*';
  const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
  const keys = [...order.filter((k) => k in h), ...Object.keys(h).filter((k) => !order.includes(k))];
  const head = keys.map((k) => `[${k} "${escapeHeader(h[k])}"]`).join('\n');

  const out: string[] = [];
  const commentOf = (n: GNode<A>, mover: 'w' | 'b' | null) => {
    const ann = annotate?.(n);
    const cmds = [...(ann?.commands ?? [])];
    if (n.clock && mover) cmds.push(`[%clk ${fmtClock(n.clock[mover === 'w' ? 0 : 1])}]`);
    const text = [cmds.join(' '), ann?.comment, n.comment].filter(Boolean).map((s) => escapeComment(s!)).join(' ');
    return { text, nags: [...new Set([...(ann?.nags ?? []), ...(n.nags ?? [])])] };
  };
  // needNum: a black move must repeat its move number after a comment or variation
  const emitMove = (n: GNode<A>, needNum: boolean): boolean => {
    const fen = n.parent!.fen;
    const turn = turnOf(fen);
    const num = moveNumberOf(fen);
    if (turn === 'w') out.push(`${num}. ${n.san}`);
    else out.push(needNum ? `${num}... ${n.san}` : n.san);
    const { text, nags } = commentOf(n, turn);
    for (const g of nags) out.push(`$${g}`);
    if (text) out.push(`{ ${text} }`);
    return Boolean(text);
  };
  const emitLine = (from: GNode<A>, first: GNode<A>, needNum: boolean) => {
    let n: GNode<A> | undefined = first;
    let parent = from;
    let need = needNum;
    while (n) {
      let interrupted = emitMove(n, need);
      // sibling variations are emitted once, right after the main move they replace
      const alts = parent.children[0] === n ? parent.children.slice(1) : [];
      for (const v of alts) {
        out.push('(');
        emitLine(parent, v, true);
        out.push(')');
        interrupted = true;
      }
      need = interrupted;
      parent = n;
      n = n.children[0];
    }
  };
  const rootNote = commentOf(tree.root, null).text;
  if (rootNote) out.push(`{ ${rootNote} }`);
  const first = tree.root.children[0];
  if (first) emitLine(tree.root, first, true);
  out.push(h.Result);
  return `${head}\n\n${wrap(out.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')'))}\n`;
}

function wrap(text: string, width = 80): string {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

type Token =
  | { k: 'header'; name: string; value: string }
  | { k: 'comment'; text: string }
  | { k: 'open' }
  | { k: 'close' }
  | { k: 'nag'; n: number }
  | { k: 'result'; v: string }
  | { k: 'san'; v: string };

function tokenize(pgn: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const s = pgn.replace(/\r\n?/g, '\n');
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '[') {
      const end = s.indexOf(']', i);
      const body = s.slice(i + 1, end < 0 ? s.length : end);
      const m = /^\s*(\w+)\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(body);
      if (m) out.push({ k: 'header', name: m[1], value: m[2].replace(/\\(.)/g, '$1') });
      i = end < 0 ? s.length : end + 1;
    } else if (ch === '{') {
      const end = s.indexOf('}', i);
      out.push({ k: 'comment', text: s.slice(i + 1, end < 0 ? s.length : end) });
      i = end < 0 ? s.length : end + 1;
    } else if (ch === ';') {
      const end = s.indexOf('\n', i);
      out.push({ k: 'comment', text: s.slice(i + 1, end < 0 ? s.length : end) });
      i = end < 0 ? s.length : end + 1;
    } else if (ch === '%' && (i === 0 || s[i - 1] === '\n')) {
      const end = s.indexOf('\n', i);
      i = end < 0 ? s.length : end + 1;
    } else if (ch === '(') {
      out.push({ k: 'open' });
      i++;
    } else if (ch === ')') {
      out.push({ k: 'close' });
      i++;
    } else if (ch === '$') {
      const m = /^\$(\d+)/.exec(s.slice(i));
      if (m) out.push({ k: 'nag', n: Number(m[1]) });
      i += m ? m[0].length : 1;
    } else {
      const m = /^[^\s{}()[\];$]+/.exec(s.slice(i))!;
      i += m[0].length;
      const word = m[0];
      if (RESULTS.has(word)) out.push({ k: 'result', v: word });
      else {
        // strip a leading move number ("12." / "12...") glued to the move
        const w = word.replace(/^\d+\.+/, '');
        if (w && !/^\d+$/.test(w)) out.push({ k: 'san', v: w });
      }
    }
  }
  return out;
}

export interface ParsedGame<A extends object = object> {
  headers: Headers;
  tree: GameTree<A>;
  result: string;
}

/** Parses the first game of `pgn`, keeping variations, comments, NAGs and `[%clk]` times. */
export function parsePgn<A extends object = object>(pgn: string): ParsedGame<A> {
  const tokens = tokenize(pgn);
  const headers: Headers = {};
  let i = 0;
  for (; i < tokens.length && tokens[i].k === 'header'; i++) {
    const t = tokens[i] as Extract<Token, { k: 'header' }>;
    headers[t.name] = t.value;
  }
  const startFen = headers.FEN ? new Chess(headers.FEN).fen() : START_FEN;
  const tree = new GameTree<A>(startFen);
  let cur: GNode<A> = tree.root;
  const stack: GNode<A>[] = [];
  let result = headers.Result && RESULTS.has(headers.Result) ? headers.Result : '*';
  let moves = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === 'header') break; // next game
    if (t.k === 'result') {
      if (stack.length === 0) {
        result = t.v;
        break;
      }
    } else if (t.k === 'open') {
      if (!cur.parent) throw new Error('变着位置错误');
      stack.push(cur);
      cur = cur.parent;
    } else if (t.k === 'close') {
      const back = stack.pop();
      if (back) cur = back;
    } else if (t.k === 'nag') {
      if (cur !== tree.root) (cur.nags ??= []).push(t.n);
    } else if (t.k === 'comment') {
      let text = t.text;
      text = text.replace(/\[%clk\s+([^\]]+)\]/g, (_, v: string) => {
        const ms = parseClock(v);
        if (ms !== null && cur.parent) {
          const prev = cur.parent.clock ?? [ms, ms];
          const mover = turnOf(cur.parent.fen);
          cur.clock = mover === 'w' ? [ms, prev[1]] : [prev[0], ms];
        }
        return '';
      });
      // engine evals are recomputed by the app; drop other unknown commands too
      text = text.replace(/\[%[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
      if (text) cur.comment = cur.comment ? `${cur.comment} ${text}` : text;
    } else if (t.k === 'san') {
      let san = t.v.replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O');
      const suffix = /[!?]+$/.exec(san)?.[0];
      if (suffix) san = san.slice(0, -suffix.length);
      if (san === '--' || san === 'Z0') throw new Error('不支持空着');
      let uci: string;
      try {
        uci = uciOf(new Chess(cur.fen).move(san));
      } catch {
        throw new Error(`第 ${moveNumberOf(cur.fen)} 回合着法非法：${t.v}`);
      }
      cur = tree.add(cur, uci)!;
      if (suffix && SUFFIX_NAG[suffix]) (cur.nags ??= []).push(SUFFIX_NAG[suffix]);
      moves++;
    }
  }
  if (moves === 0 && !headers.FEN && !Object.keys(headers).length) throw new Error('没有找到着法');
  return { headers, tree, result };
}

export const NAG_SYMBOL: Record<number, string> = { 1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!' };
