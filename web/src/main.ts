import { Chess, type Square } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './style.css';

import { Maia, MODELS, type MaiaResult } from './maia/maia';
import { sampleMove } from './maia/sample';
import { Stockfish, type SfLine } from './engine/stockfish';
import { evalText, judge, JUDGEMENT_INFO, moveAccuracy, whiteWinPct, type Judgement } from './coach/coach';
import { loadSettings, saveSettings, type Color, type Settings } from './settings';

// ---------- state ----------

interface PlayedMove {
  uci: string;
  san: string;
}

interface PosEval {
  lines: SfLine[];
  best: string | null;
  white: number;
  text: string;
}

interface SavedGame {
  startFen: string;
  moves: string[];
  userColor: Color;
  result: string;
}

const START_FEN = new Chess().fen();
const GAME_KEY = 'maia-coach.game';

let settings: Settings = loadSettings();
let startFen = START_FEN;
let moves: PlayedMove[] = [];
let fens: string[] = [START_FEN];
let cursor = 0;
let userColor: Color = 'w';
let result = '';
let mode: 'play' | 'review' = 'play';
let flipped = false;
let gameToken = 0;
let maiaThinking = false;
let evals: (PosEval | undefined)[] = [];
let human: (MaiaResult | undefined)[] = [];
let hintShapes: DrawShape[] = [];
let liveOn = false;
let liveCtrl: AbortController | null = null;
let liveLines: SfLine[] = [];
let batchCtrl: AbortController | null = null;

let maia: Maia | null = null;
let maiaLoading: Promise<Maia> | null = null;
let sf: Stockfish | null = null;
let sfLoading: Promise<Stockfish> | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- engines ----------

function setStatus(text: string) {
  $('status').textContent = text;
}

function unloadMaia() {
  maia?.dispose();
  maia = null;
  maiaLoading = null;
}

function unloadSf() {
  liveCtrl?.abort();
  sf?.terminate();
  sf = null;
  sfLoading = null;
}

async function getMaia(): Promise<Maia> {
  if (maia && maia.model === settings.model && maia.backend === settings.backend) return maia;
  if (maiaLoading) {
    const m = await maiaLoading;
    if (m.model === settings.model && m.backend === settings.backend) return m;
  }
  unloadMaia();
  if (settings.lowMemory) unloadSf();
  const model = settings.model;
  setStatus(`加载 ${MODELS[model].label}…`);
  maiaLoading = Maia.create(model, settings.backend, (l, t) =>
    setStatus(`加载 Maia ${((l / t) * 100).toFixed(0)}%（${(t / 1048576).toFixed(0)}MB）`),
  )
    .catch(async (err) => {
      if (settings.backend !== 'webgpu') throw err;
      console.warn('WebGPU 失败，回退 WASM', err);
      return Maia.create(model, 'wasm');
    })
    .then((m) => {
      maia = m;
      setStatus(`${MODELS[model].label} 就绪`);
      return m;
    })
    .catch((err) => {
      maiaLoading = null;
      setStatus('Maia 加载失败：' + (err as Error).message);
      throw err;
    });
  return maiaLoading;
}

async function getSf(): Promise<Stockfish> {
  if (sf) return sf;
  if (sfLoading) return sfLoading;
  if (settings.lowMemory) unloadMaia();
  setStatus('加载 Stockfish 19…');
  sfLoading = Stockfish.create(settings.sfThreads, settings.sfHash)
    .then((s) => {
      sf = s;
      setStatus(`Stockfish 19 就绪（${s.multiThreaded ? s.threads + ' 线程' : '单线程'}）`);
      return s;
    })
    .catch((err) => {
      sfLoading = null;
      setStatus('Stockfish 加载失败：' + (err as Error).message);
      throw err;
    });
  return sfLoading;
}

// ---------- game helpers ----------

function chessAt(ply: number): Chess {
  return new Chess(fens[ply]);
}

function uciOf(m: { from: string; to: string; promotion?: string }) {
  return m.from + m.to + (m.promotion ?? '');
}

function toMove(uci: string) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

function sanOf(fen: string, uci: string): string {
  try {
    return new Chess(fen).move(toMove(uci)).san;
  } catch {
    return uci;
  }
}

function pvToSan(fen: string, pv: string[], max = 8): string {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of pv.slice(0, max)) {
    try {
      const turn = c.turn();
      const num = Number(c.fen().split(' ')[5]);
      const san = c.move(toMove(u)).san;
      out.push(turn === 'w' ? `${num}. ${san}` : out.length === 0 ? `${num}… ${san}` : san);
    } catch {
      break;
    }
  }
  return out.join(' ');
}

function terminalResult(c: Chess): string {
  if (c.isCheckmate()) return c.turn() === 'w' ? '0-1' : '1-0';
  if (c.isDraw() || c.isStalemate()) return '1/2-1/2';
  return '';
}

function resultText(): string {
  const c = chessAt(fens.length - 1);
  if (result === '') return '';
  const why = c.isCheckmate()
    ? '将死'
    : c.isStalemate()
      ? '逼和'
      : c.isThreefoldRepetition()
        ? '三次重复'
        : c.isInsufficientMaterial()
          ? '子力不足'
          : c.isDrawByFiftyMoves()
            ? '50 回合规则'
            : '认输';
  return `${result}（${why}）`;
}

function saveGame() {
  const g: SavedGame = { startFen, moves: moves.map((m) => m.uci), userColor, result };
  localStorage.setItem(GAME_KEY, JSON.stringify(g));
}

function loadGame(g: SavedGame): boolean {
  try {
    const c = new Chess(g.startFen);
    const ms: PlayedMove[] = [];
    const fs = [c.fen()];
    for (const u of g.moves) {
      const m = c.move(toMove(u));
      ms.push({ uci: u, san: m.san });
      fs.push(c.fen());
    }
    startFen = g.startFen;
    moves = ms;
    fens = fs;
    userColor = g.userColor;
    result = g.result || terminalResult(c);
    cursor = fens.length - 1;
    evals = [];
    human = [];
    return true;
  } catch {
    return false;
  }
}

function truncate(ply: number) {
  moves = moves.slice(0, ply);
  fens = fens.slice(0, ply + 1);
  evals = evals.slice(0, ply);
  human = human.slice(0, ply);
  result = '';
}

function pushMove(uci: string): boolean {
  const c = chessAt(fens.length - 1);
  let m;
  try {
    m = c.move(toMove(uci));
  } catch {
    return false;
  }
  moves.push({ uci, san: m.san });
  fens.push(c.fen());
  cursor = fens.length - 1;
  result = terminalResult(c);
  hintShapes = [];
  $('hint-box').textContent = '';
  saveGame();
  return true;
}

// ---------- board ----------

let cg: Api;

function dests(c: Chess): Map<Key, Key[]> {
  const d = new Map<Key, Key[]>();
  for (const m of c.moves({ verbose: true })) {
    const arr = d.get(m.from as Key) ?? [];
    arr.push(m.to as Key);
    d.set(m.from as Key, arr);
  }
  return d;
}

function canUserMove(): boolean {
  const atTip = cursor === fens.length - 1;
  if (mode === 'review') return result === '' || !atTip;
  return atTip && result === '' && !maiaThinking && chessAt(cursor).turn() === userColor;
}

function arrows(): DrawShape[] {
  const shapes: DrawShape[] = [...hintShapes];
  if (mode === 'review') {
    const best = liveOn && liveLines[0]?.pv[0] ? liveLines[0].pv[0] : evals[cursor]?.best;
    if (best) shapes.push({ orig: best.slice(0, 2) as Key, dest: best.slice(2, 4) as Key, brush: 'green' });
    const h = human[cursor]?.moves[0];
    if (h && h.uci !== best) shapes.push({ orig: h.uci.slice(0, 2) as Key, dest: h.uci.slice(2, 4) as Key, brush: 'blue' });
  }
  return shapes;
}

function renderBoard() {
  const c = chessAt(cursor);
  const last = cursor > 0 ? moves[cursor - 1].uci : undefined;
  const movable = canUserMove();
  const orientation: 'white' | 'black' = (userColor === 'w') !== flipped ? 'white' : 'black';
  cg.set({
    fen: c.fen(),
    orientation,
    turnColor: c.turn() === 'w' ? 'white' : 'black',
    lastMove: last ? [last.slice(0, 2) as Key, last.slice(2, 4) as Key] : undefined,
    check: c.inCheck(),
    movable: {
      free: false,
      color: movable ? (c.turn() === 'w' ? 'white' : 'black') : undefined,
      dests: movable ? dests(c) : new Map(),
    },
  });
  cg.setAutoShapes(arrows());
}

function askPromotion(color: Color): Promise<string> {
  const dlg = $<HTMLDialogElement>('dlg-promo');
  const box = $('promo-choices');
  const glyph: Record<string, string> = color === 'w' ? { q: '♕', r: '♖', b: '♗', n: '♘' } : { q: '♛', r: '♜', b: '♝', n: '♞' };
  return new Promise((resolve) => {
    box.innerHTML = '';
    for (const p of 'qrbn') {
      const b = document.createElement('button');
      b.textContent = glyph[p];
      b.onclick = () => {
        dlg.close();
        resolve(p);
      };
      box.appendChild(b);
    }
    dlg.onclose = () => resolve('q');
    dlg.showModal();
  });
}

async function onUserMove(orig: Key, dest: Key) {
  const c = chessAt(cursor);
  const piece = c.get(orig as Square);
  let uci = orig + dest;
  if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) uci += await askPromotion(c.turn());
  if (cursor !== fens.length - 1) {
    if (moves[cursor].uci === uci) {
      cursor++;
      update();
      return;
    }
    truncate(cursor);
  }
  if (!pushMove(uci)) {
    renderBoard();
    return;
  }
  update();
  if (mode === 'play') void maiaTurn();
}

// ---------- play ----------

async function maiaTurn() {
  const tip = fens.length - 1;
  if (mode !== 'play' || result !== '' || chessAt(tip).turn() === userColor) return;
  const token = ++gameToken;
  maiaThinking = true;
  update();
  try {
    const m = await getMaia();
    const t0 = performance.now();
    const c = chessAt(tip);
    const res = await m.evaluate(c, fens.slice(0, tip + 1), settings.elo, settings.elo);
    if (token !== gameToken) return;
    const pick = sampleMove(res.moves, settings.temperature, 1);
    if (settings.thinkDelay) {
      // longer "thinking" when the position is less obvious to a human
      const certainty = res.moves[0].p;
      const want = 300 + Math.random() * 600 + (1 - certainty) * 2500;
      const wait = want - (performance.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (token !== gameToken) return;
    }
    maiaThinking = false;
    pushMove(pick.uci);
  } catch (err) {
    console.error(err);
  } finally {
    if (token === gameToken) maiaThinking = false;
    update();
  }
}

function newGame() {
  gameToken++;
  maiaThinking = false;
  batchCtrl?.abort();
  userColor = settings.color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : settings.color;
  flipped = false;
  startFen = START_FEN;
  moves = [];
  fens = [START_FEN];
  cursor = 0;
  result = '';
  evals = [];
  human = [];
  hintShapes = [];
  $('hint-box').textContent = '';
  setMode('play');
  saveGame();
  update();
  void maiaTurn();
}

function undo() {
  if (moves.length === 0) return;
  gameToken++;
  maiaThinking = false;
  let ply = fens.length - 1;
  do ply--;
  while (ply > 0 && new Chess(fens[ply]).turn() !== userColor);
  if (new Chess(fens[ply]).turn() !== userColor) ply = 0;
  truncate(ply);
  cursor = ply;
  hintShapes = [];
  $('hint-box').textContent = '';
  saveGame();
  update();
  void maiaTurn();
}

async function hint() {
  const ply = fens.length - 1;
  if (result !== '' || mode !== 'play') return;
  const box = $('hint-box');
  box.textContent = '思考中…';
  try {
    const s = await getSf();
    const r = await s.analyse(startFen, { moves: moves.map((m) => m.uci), movetime: settings.sfMovetime, multipv: 1 });
    if (ply !== fens.length - 1) return;
    const best = r.bestmove;
    const turn = chessAt(ply).turn();
    hintShapes = best ? [{ orig: best.slice(0, 2) as Key, dest: best.slice(2, 4) as Key, brush: 'green' }] : [];
    let text = best ? `Stockfish 推荐：${sanOf(fens[ply], best)}（${r.lines[0] ? evalText(r.lines[0], turn) : ''}）` : '';
    if (!settings.lowMemory) {
      const m = await getMaia();
      const h = await m.evaluate(chessAt(ply), fens.slice(0, ply + 1), settings.elo, settings.elo);
      if (ply !== fens.length - 1) return;
      const top = h.moves[0];
      if (top.uci !== best) hintShapes.push({ orig: top.uci.slice(0, 2) as Key, dest: top.uci.slice(2, 4) as Key, brush: 'blue' });
      text += `\n${settings.elo} 分棋手最常走：` + h.moves.slice(0, 3).map((x) => `${sanOf(fens[ply], x.uci)} ${(x.p * 100).toFixed(0)}%`).join('，');
    }
    box.textContent = text;
    cg.setAutoShapes(arrows());
  } catch (err) {
    box.textContent = '提示失败：' + (err as Error).message;
  }
}

function resign() {
  if (result !== '' || moves.length === 0) return;
  gameToken++;
  maiaThinking = false;
  result = userColor === 'w' ? '0-1' : '1-0';
  saveGame();
  update();
}

// ---------- review ----------

function posEvalFrom(ply: number, lines: SfLine[], best: string | null): PosEval {
  const c = chessAt(ply);
  const turn = c.turn();
  if (c.isGameOver() || !lines[0]) {
    const white = c.isCheckmate() ? (turn === 'w' ? 0 : 100) : 50;
    return { lines: [], best: null, white, text: c.isCheckmate() ? '#' : '½' };
  }
  return { lines, best, white: whiteWinPct(lines[0], turn), text: evalText(lines[0], turn) };
}

async function analyseGame() {
  batchCtrl?.abort();
  const ctrl = new AbortController();
  batchCtrl = ctrl;
  setLive(false);
  const bar = $('analyse-progress');
  bar.classList.remove('hidden');
  const fill = bar.firstElementChild as HTMLElement;
  const n = fens.length;
  try {
    const s = await getSf();
    for (let i = 0; i < n; i++) {
      if (ctrl.signal.aborted) return;
      if (!evals[i]) {
        const r = await s.analyse(startFen, {
          moves: moves.slice(0, i).map((m) => m.uci),
          movetime: settings.sfMovetime,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        evals[i] = posEvalFrom(i, r.lines, r.bestmove);
      }
      fill.style.width = `${((i + 1) / n) * (settings.lowMemory ? 50 : 70)}%`;
      if (i === cursor || i % 4 === 0) update();
    }
    const m = await getMaia();
    for (let i = 0; i < n - 1; i++) {
      if (ctrl.signal.aborted) return;
      if (!human[i]) {
        human[i] = await m.evaluate(chessAt(i), fens.slice(0, i + 1), settings.elo, settings.elo);
      }
      const base = settings.lowMemory ? 50 : 70;
      fill.style.width = `${base + ((i + 1) / (n - 1)) * (100 - base)}%`;
    }
    setStatus('分析完成');
  } catch (err) {
    console.error(err);
  } finally {
    if (batchCtrl === ctrl) {
      batchCtrl = null;
      bar.classList.add('hidden');
    }
    update();
  }
}

interface MoveReview {
  judgement: Judgement;
  before: number;
  after: number;
  accuracy: number;
}

function reviewOf(i: number): MoveReview | null {
  const a = evals[i];
  const b = evals[i + 1];
  if (!a || !b) return null;
  const white = chessAt(i).turn() === 'w';
  const before = white ? a.white : 100 - a.white;
  const after = white ? b.white : 100 - b.white;
  return { judgement: judge(before, after, moves[i].uci === a.best), before, after, accuracy: moveAccuracy(before, after) };
}

function setLive(on: boolean) {
  liveOn = on;
  $('btn-live').textContent = `实时分析：${on ? '开' : '关'}`;
  if (!on) {
    liveCtrl?.abort();
    liveLines = [];
  }
  runLive();
}

async function runLive() {
  liveCtrl?.abort();
  liveLines = [];
  renderLines();
  if (!liveOn || mode !== 'review') return;
  const ctrl = new AbortController();
  liveCtrl = ctrl;
  const ply = cursor;
  try {
    const s = await getSf();
    if (ctrl.signal.aborted) return;
    await s.analyse(startFen, {
      moves: moves.slice(0, ply).map((m) => m.uci),
      movetime: 60000,
      multipv: 3,
      signal: ctrl.signal,
      onInfo: (lines) => {
        if (ctrl.signal.aborted || ply !== cursor) return;
        liveLines = lines;
        renderLines();
        cg.setAutoShapes(arrows());
      },
    });
  } catch (err) {
    console.error(err);
  }
}

function renderLines() {
  const box = $('sf-lines');
  const lines = liveOn && liveLines.length ? liveLines : [];
  const turn = chessAt(cursor).turn();
  box.innerHTML = lines
    .map((l) => `<div><b>${evalText(l, turn)}</b> <small>d${l.depth}</small> ${pvToSan(fens[cursor], l.pv)}</div>`)
    .join('');
}

function renderGraph() {
  const svg = $('graph');
  const n = fens.length;
  const pts: string[] = [];
  const dots: string[] = [];
  for (let i = 0; i < n; i++) {
    const e = evals[i];
    if (!e) continue;
    const x = n > 1 ? (i / (n - 1)) * 100 : 0;
    const y = 40 - (e.white / 100) * 40;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    if (i > 0) {
      const r = reviewOf(i - 1);
      if (r && ['mistake', 'blunder', 'inaccuracy'].includes(r.judgement)) {
        dots.push(`<circle cx="${x}" cy="${y}" r="0.9" fill="${JUDGEMENT_INFO[r.judgement].color}"/>`);
      }
    }
  }
  const cx = n > 1 ? (cursor / (n - 1)) * 100 : 0;
  const area = pts.length ? `<polygon points="0,40 ${pts.join(' ')} ${pts[pts.length - 1].split(',')[0]},40" fill="#ddd" opacity="0.85"/>` : '';
  svg.innerHTML =
    `<rect width="100" height="40" fill="#333"/>${area}` +
    `<line x1="0" y1="20" x2="100" y2="20" stroke="#888" stroke-width="0.2"/>` +
    (pts.length ? `<polyline points="${pts.join(' ')}" fill="none" stroke="#e6b422" stroke-width="0.4"/>` : '') +
    dots.join('') +
    `<line x1="${cx}" y1="0" x2="${cx}" y2="40" stroke="#4a90d9" stroke-width="0.4"/>`;
}

function renderSummary() {
  const box = $('summary');
  const stats = { w: { acc: [] as number[], c: {} as Record<string, number> }, b: { acc: [] as number[], c: {} as Record<string, number> } };
  for (let i = 0; i < moves.length; i++) {
    const r = reviewOf(i);
    if (!r) continue;
    const s = stats[chessAt(i).turn()];
    s.acc.push(r.accuracy);
    s.c[r.judgement] = (s.c[r.judgement] ?? 0) + 1;
  }
  if (!stats.w.acc.length && !stats.b.acc.length) {
    box.innerHTML = '';
    return;
  }
  const row = (k: Color, name: string) => {
    const s = stats[k];
    const avg = s.acc.length ? s.acc.reduce((a, b) => a + b, 0) / s.acc.length : 0;
    const counts = (['inaccuracy', 'mistake', 'blunder'] as Judgement[])
      .map((j) => `<span style="color:${JUDGEMENT_INFO[j].color}">${JUDGEMENT_INFO[j].label} ${s.c[j] ?? 0}</span>`)
      .join(' ');
    return `<div><b>${name}</b> 准确率 ${avg.toFixed(1)}% ${counts}</div>`;
  };
  box.innerHTML = row('w', userColor === 'w' ? '白（我）' : '白（Maia）') + row('b', userColor === 'b' ? '黑（我）' : '黑（Maia）');
}

function renderCoach() {
  const box = $('coach-box');
  const parts: string[] = [];
  const e = evals[cursor];
  if (cursor > 0) {
    const i = cursor - 1;
    const r = reviewOf(i);
    const prev = evals[i];
    const turnNum = chessAt(i).fen().split(' ')[5];
    const san = moves[i].san;
    if (r && prev) {
      const info = JUDGEMENT_INFO[r.judgement];
      parts.push(
        `<div class="j" style="color:${info.color}">${turnNum}${chessAt(i).turn() === 'w' ? '.' : '…'} ${san}${info.symbol} — ${info.label}</div>`,
        `<div>行棋方胜率 ${r.before.toFixed(0)}% → ${r.after.toFixed(0)}%</div>`,
      );
      if (prev.best && prev.best !== moves[i].uci) {
        parts.push(`<div>更好的是 <b>${sanOf(fens[i], prev.best)}</b>（${prev.text}）：${pvToSan(fens[i], prev.lines[0]?.pv ?? [])}</div>`);
      }
    }
    const h = human[i];
    if (h) {
      const played = h.moves.find((m) => m.uci === moves[i].uci);
      parts.push(
        `<div class="human">${settings.elo} 分棋手在此常走：` +
          h.moves
            .slice(0, 3)
            .map((m) => `${sanOf(fens[i], m.uci)} ${(m.p * 100).toFixed(0)}%`)
            .join('，') +
          `；实战着法人类选择率 ${played ? (played.p * 100).toFixed(1) : '?'}%</div>`,
      );
    }
  }
  if (e && cursor === fens.length - 1 && e.best) {
    parts.push(`<div>当前最佳：<b>${sanOf(fens[cursor], e.best)}</b>（${e.text}）</div>`);
  }
  if (!parts.length && mode === 'review') parts.push('<div class="muted">点击“分析整局”，Stockfish 会逐步评估，Maia 会告诉你同水平的人通常怎么走。</div>');
  box.innerHTML = parts.join('');
}

// ---------- rendering ----------

function renderMoves() {
  const box = $('moves');
  const firstBlack = new Chess(startFen).turn() === 'b';
  const startNum = Number(startFen.split(' ')[5]) || 1;
  let html = '';
  for (let i = 0; i < moves.length; i++) {
    const black = (i % 2 === 1) !== firstBlack;
    if (!black || i === 0) html += `<span class="num">${startNum + Math.floor((i + (firstBlack ? 1 : 0)) / 2)}.${black ? '…' : ''}</span>`;
    const r = reviewOf(i);
    const sym = r ? JUDGEMENT_INFO[r.judgement].symbol : '';
    const color = r && r.judgement !== 'good' && r.judgement !== 'best' ? `style="color:${JUDGEMENT_INFO[r.judgement].color}"` : '';
    html += `<span class="mv${cursor === i + 1 ? ' cur' : ''}" data-ply="${i + 1}" ${color}>${moves[i].san}${sym === '★' ? '' : sym}</span>`;
  }
  if (resultText()) html += `<span class="res">${resultText()}</span>`;
  box.innerHTML = html;
  // 只滚动着法框内部，避免 scrollIntoView 带动整个页面跳动
  const cur = box.querySelector<HTMLElement>('.cur');
  if (cur) {
    const b = box.getBoundingClientRect();
    const c = cur.getBoundingClientRect();
    if (c.top < b.top) box.scrollTop += c.top - b.top;
    else if (c.bottom > b.bottom) box.scrollTop += c.bottom - b.bottom;
  } else {
    box.scrollTop = box.scrollHeight;
  }
}

function renderPlayers() {
  const maiaName = `🤖 ${MODELS[settings.model].label.split('（')[0]} · ${settings.elo}`;
  const me = `🙂 我 · ${settings.elo}`;
  const bottomIsUser = !flipped;
  $('player-top').textContent = bottomIsUser ? maiaName : me;
  $('player-bottom').textContent = bottomIsUser ? me : maiaName;
  $('player-top').classList.toggle('thinking', maiaThinking && bottomIsUser);
  $('player-bottom').classList.toggle('thinking', maiaThinking && !bottomIsUser);
}

function renderEvalBar() {
  const e = liveOn && liveLines[0] ? posEvalFrom(cursor, liveLines, liveLines[0].pv[0]) : evals[cursor];
  const bar = $('evalbar');
  bar.classList.toggle('hidden', mode !== 'review');
  const white = e ? e.white : 50;
  const whiteAtBottom = (userColor === 'w') !== flipped;
  bar.classList.toggle('flip', !whiteAtBottom);
  $('evalbar-fill').style.height = `${white}%`;
  $('evalbar-text').textContent = e ? e.text : '';
}

function renderPlayInfo() {
  const box = $('play-info');
  if (result) box.textContent = `对局结束：${resultText()}`;
  else if (maiaThinking) box.textContent = 'Maia 思考中…';
  else if (cursor !== fens.length - 1) box.textContent = '正在查看历史局面';
  else box.textContent = chessAt(cursor).turn() === userColor ? '轮到你走' : '等待 Maia';
}

function update() {
  renderBoard();
  renderMoves();
  renderPlayers();
  renderPlayInfo();
  renderEvalBar();
  renderGraph();
  renderSummary();
  renderCoach();
  renderLines();
}

function goto(ply: number) {
  const p = Math.max(0, Math.min(fens.length - 1, ply));
  if (p === cursor) return;
  cursor = p;
  hintShapes = [];
  update();
  if (liveOn) void runLive();
}

function setMode(m: 'play' | 'review') {
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === m));
  $('tab-play').classList.toggle('hidden', m !== 'play');
  $('tab-review').classList.toggle('hidden', m !== 'review');
  if (m === 'play') {
    setLive(false);
    batchCtrl?.abort();
  }
  update();
  if (m === 'play') void maiaTurn();
}

// ---------- settings dialog ----------

function openSettings() {
  const dlg = $<HTMLDialogElement>('dlg-settings');
  const f = dlg.querySelector('form')!;
  const el = (n: string) => f.elements.namedItem(n) as HTMLInputElement;
  for (const [k, v] of Object.entries(settings)) {
    const input = el(k);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(v);
    else input.value = String(v);
  }
  const outs = () => {
    const v = Number(el('elo').value);
    (f.elements.namedItem('eloOut') as HTMLOutputElement).value = v < 600 ? `${v}（低于 600 为模型外推）` : String(v);
    (f.elements.namedItem('tempOut') as HTMLOutputElement).value = el('temperature').value;
  };
  f.oninput = outs;
  outs();
  $('env-info').innerHTML =
    `跨源隔离：${self.crossOriginIsolated ? '✅（多线程可用）' : '❌（单线程）'}<br>` +
    `WebGPU：${'gpu' in navigator ? '✅' : '❌'}　CPU 核心：${navigator.hardwareConcurrency || '?'}<br>` +
    `Stockfish：${sf ? (sf.multiThreaded ? sf.threads + ' 线程' : '单线程') : '未加载'}　Maia：${maia ? maia.model : '未加载'}`;
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const old = settings;
    const num = (n: string) => Number(el(n).value);
    settings = {
      model: el('model').value as Settings['model'],
      elo: num('elo'),
      color: el('color').value as Settings['color'],
      temperature: num('temperature'),
      backend: el('backend').value as Settings['backend'],
      thinkDelay: el('thinkDelay').checked,
      sfMovetime: Math.max(100, num('sfMovetime') || 1000),
      sfThreads: Math.max(1, num('sfThreads') || 1),
      sfHash: Math.max(16, num('sfHash') || 64),
      lowMemory: el('lowMemory').checked,
    };
    saveSettings(settings);
    if (old.sfThreads !== settings.sfThreads || old.sfHash !== settings.sfHash) unloadSf();
    if (old.model !== settings.model || old.backend !== settings.backend) unloadMaia();
    if (old.elo !== settings.elo || old.model !== settings.model) human = [];
    if (old.sfMovetime !== settings.sfMovetime) evals = [];
    update();
  };
  dlg.showModal();
}

// ---------- PGN ----------

function exportPgn(): string {
  const c = new Chess(startFen);
  const white = userColor === 'w' ? '我' : `Maia-3 ${settings.model} (${settings.elo})`;
  const black = userColor === 'b' ? '我' : `Maia-3 ${settings.model} (${settings.elo})`;
  c.setHeader('Event', 'Maia 教练对局');
  c.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
  c.setHeader('White', white);
  c.setHeader('Black', black);
  for (const m of moves) c.move(toMove(m.uci));
  c.setHeader('Result', result || '*');
  return c.pgn();
}

function importText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const c = new Chess();
  try {
    c.loadPgn(t);
  } catch {
    try {
      const f = new Chess(t);
      return loadGame({ startFen: f.fen(), moves: [], userColor: f.turn(), result: '' });
    } catch {
      return false;
    }
  }
  const hist = c.history({ verbose: true });
  const first = hist[0]?.before ?? c.fen();
  return loadGame({ startFen: first, moves: hist.map(uciOf), userColor: 'w', result: c.getHeaders().Result ?? '' });
}

// ---------- init ----------

function bind() {
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((b) => {
    b.onclick = () => {
      const nav = b.dataset.nav;
      goto(nav === 'first' ? 0 : nav === 'prev' ? cursor - 1 : nav === 'next' ? cursor + 1 : fens.length - 1);
    };
  });
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => {
    b.onclick = () => setMode(b.dataset.tab as 'play' | 'review');
  });
  $('btn-flip').onclick = () => {
    flipped = !flipped;
    update();
  };
  $('btn-new').onclick = newGame;
  $('btn-undo').onclick = undo;
  $('btn-hint').onclick = () => void hint();
  $('btn-resign').onclick = resign;
  $('btn-analyse').onclick = () => void analyseGame();
  $('btn-live').onclick = () => setLive(!liveOn);
  $('btn-settings').onclick = openSettings;
  $('moves').onclick = (e) => {
    const ply = (e.target as HTMLElement).dataset.ply;
    if (ply) goto(Number(ply));
  };
  $('graph').onclick = (e) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    goto(Math.round(((e.clientX - rect.left) / rect.width) * (fens.length - 1)));
  };
  $('btn-pgn-copy').onclick = async () => {
    const pgn = exportPgn();
    try {
      await navigator.clipboard.writeText(pgn);
      setStatus('PGN 已复制');
    } catch {
      prompt('复制 PGN：', pgn);
    }
  };
  $('btn-pgn-import').onclick = () => {
    const dlg = $<HTMLDialogElement>('dlg-pgn');
    const f = dlg.querySelector('form')!;
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      gameToken++;
      maiaThinking = false;
      batchCtrl?.abort();
      if (!importText((f.elements.namedItem('pgn') as HTMLTextAreaElement).value)) {
        setStatus('无法解析 PGN/FEN');
        return;
      }
      cursor = 0;
      saveGame();
      setMode('review');
    };
    dlg.showModal();
  };
  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('dialog')) return;
    if (e.key === 'ArrowLeft') goto(cursor - 1);
    else if (e.key === 'ArrowRight') goto(cursor + 1);
    else if (e.key === 'Home') goto(0);
    else if (e.key === 'End') goto(fens.length - 1);
  });
}

function init() {
  cg = Chessground($('board'), {
    animation: { duration: 180 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: (o, d) => void onUserMove(o, d) } },
    premovable: { enabled: false },
    drawable: { enabled: true },
  });
  bind();
  const saved = localStorage.getItem(GAME_KEY);
  if (!saved || !loadGame(JSON.parse(saved) as SavedGame)) userColor = settings.color === 'b' ? 'b' : 'w';
  update();
  setStatus(self.crossOriginIsolated ? '就绪（多线程）' : '就绪（单线程模式）');
  void maiaTurn();

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').then(() => {
      // first visit: reload once so the SW can add COOP/COEP headers (enables multi-threading)
      if (!self.crossOriginIsolated && !sessionStorage.getItem('coi-reloaded')) {
        navigator.serviceWorker.ready.then(() => {
          sessionStorage.setItem('coi-reloaded', '1');
          location.reload();
        });
      }
    });
  }
}

init();
