import { Chess, type Square } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './style.css';

import { Maia, MODELS, type MaiaResult } from './maia/maia';
import { sampleMove } from './maia/sample';
import { Stockfish, type SfLine } from './engine/stockfish';
import { evalText, judge, JUDGEMENT_INFO, moveAccuracy, whiteWinPct, winPct, type Judgement } from './coach/coach';
import { loadSettings, saveSettings, type Color, type Settings } from './settings';
import {
  deletePackage,
  downloadPackage,
  fmtMB,
  isComplete,
  listPackages,
  loadPrecache,
  pruneStale,
  requestPersistence,
  storageInfo,
  type Package,
  type PackageId,
} from './offline';

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

interface Threat {
  uci: string;
  text: string;
}

interface SavedGame {
  startFen: string;
  moves: string[];
  userColor: Color;
  result: string;
  coach?: boolean;
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
let screen: 'home' | 'game' = 'home';
let shownResult = '';
let coachOn = false;
let coachState: 'idle' | 'checking' | 'paused' = 'idle';
let coachCtrl: AbortController | null = null;
let coachPly = -1;
let threats: (Threat | null | undefined)[] = [];

let maia: Maia | null = null;
let maiaLoading: Promise<Maia> | null = null;
let sf: Stockfish | null = null;
let sfLoading: Promise<Stockfish> | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- engines ----------

let toastTimer = 0;

function setStatus(text: string) {
  const t = $('status');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
  $('home-env').textContent = text;
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

/**
 * Coached play alternates Maia and Stockfish every move. Unloading one to load the other would
 * reload hundreds of MB per move, and iOS does not reliably free a terminated worker's wasm memory,
 * so the page gets killed after a few moves. Keep both resident instead.
 */
function needBothEngines() {
  return coachOn && mode === 'play';
}

async function getMaia(): Promise<Maia> {
  if (maia && maia.model === settings.model && maia.backend === settings.backend) return maia;
  if (maiaLoading) {
    const m = await maiaLoading;
    if (m.model === settings.model && m.backend === settings.backend) return m;
  }
  unloadMaia();
  if (settings.lowMemory && !needBothEngines()) unloadSf();
  const model = settings.model;
  const lean = settings.lowMemory;
  setStatus(`加载 ${MODELS[model].label}…`);
  maiaLoading = Maia.create(
    model,
    settings.backend,
    (l, t) => setStatus(`加载 Maia ${((l / t) * 100).toFixed(0)}%（${(t / 1048576).toFixed(0)}MB）`),
    lean,
  )
    .catch(async (err) => {
      if (settings.backend !== 'webgpu') throw err;
      console.warn('WebGPU 失败，回退 WASM', err);
      return Maia.create(model, 'wasm', undefined, lean);
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
  if (settings.lowMemory && !needBothEngines()) unloadMaia();
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
  const g: SavedGame = { startFen, moves: moves.map((m) => m.uci), userColor, result, coach: coachOn };
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
    shownResult = result;
    cursor = fens.length - 1;
    evals = [];
    human = [];
    threats = [];
    coachOn = Boolean(g.coach);
    coachReset();
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
  threats = threats.slice(0, ply);
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
  return atTip && result === '' && !maiaThinking && coachState === 'idle' && chessAt(cursor).turn() === userColor;
}

function arrows(): DrawShape[] {
  const shapes: DrawShape[] = [...hintShapes, ...coachShapes()];
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
  if (mode !== 'play') return;
  if (coachOn && result === '') void coachCheck(fens.length - 2);
  else void maiaTurn();
}

// ---------- play ----------

/** Positions fed to Maia for `ply`; without history the current position is repeated (official UCI default). */
function maiaFens(ply: number): string[] {
  return settings.useHistory ? fens.slice(0, ply + 1) : [fens[ply]];
}

async function maiaTurn() {
  const tip = fens.length - 1;
  if (screen !== 'game' || mode !== 'play' || result !== '' || coachState !== 'idle' || chessAt(tip).turn() === userColor) return;
  const token = ++gameToken;
  maiaThinking = true;
  update();
  try {
    const m = await getMaia();
    const t0 = performance.now();
    const c = chessAt(tip);
    const res = await m.evaluate(c, maiaFens(tip), settings.elo, settings.elo);
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
    void coachTurn();
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
  shownResult = '';
  threats = [];
  coachOn = settings.gameType === 'coach';
  coachReset();
  $('hint-box').textContent = '';
  setMode('play');
  saveGame();
  update();
  void maiaTurn();
  void coachTurn();
}

function undo() {
  if (moves.length === 0) return;
  gameToken++;
  maiaThinking = false;
  let ply = fens.length - 1;
  do ply--;
  while (ply > 0 && new Chess(fens[ply]).turn() !== userColor);
  if (new Chess(fens[ply]).turn() !== userColor) ply = 0;
  coachReset();
  truncate(ply);
  cursor = ply;
  hintShapes = [];
  $('hint-box').textContent = '';
  saveGame();
  update();
  void maiaTurn();
  void coachTurn();
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
      const h = await m.evaluate(chessAt(ply), maiaFens(ply), settings.elo, settings.elo);
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
  coachReset();
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
        human[i] = await m.evaluate(chessAt(i), maiaFens(i), settings.elo, settings.elo);
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
  $('btn-live').classList.toggle('on', on);
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
  const area = pts.length ? `<polygon points="0,40 ${pts.join(' ')} ${pts[pts.length - 1].split(',')[0]},40" fill="#ffffff" opacity="0.95"/>` : '';
  svg.innerHTML =
    `<rect width="100" height="40" fill="#403e3b"/>${area}` +
    `<line x1="0" y1="20" x2="100" y2="20" stroke="#8b8987" stroke-width="0.2" stroke-dasharray="1 1"/>` +
    (pts.length ? `<polyline points="${pts.join(' ')}" fill="none" stroke="#81b64c" stroke-width="2" vector-effect="non-scaling-stroke"/>` : '') +
    dots.join('') +
    `<line x1="${cx}" y1="0" x2="${cx}" y2="40" stroke="#f7c045" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
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

// ---------- coach ----------

const PIECE_NAME: Record<string, string> = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };
const SEVERITY: Record<Judgement, number> = { best: 0, good: 0, inaccuracy: 1, mistake: 2, blunder: 3 };

let prepCtrl: AbortController | null = null;
let prep: { ply: number; p: Promise<void> } | null = null;
let coachNote = '';

function coachReset() {
  coachCtrl?.abort();
  prepCtrl?.abort();
  coachCtrl = null;
  prepCtrl = null;
  prep = null;
  coachState = 'idle';
  coachPly = -1;
  coachNote = '';
}

async function evalPly(s: Stockfish, i: number, signal: AbortSignal) {
  if (evals[i]) return;
  const r = await s.analyse(startFen, { moves: moves.slice(0, i).map((m) => m.uci), movetime: settings.sfMovetime, signal });
  if (!signal.aborted && i < fens.length) evals[i] = posEvalFrom(i, r.lines, r.bestmove);
}

/** Same position with the opponent to move: its best move is what they threaten. */
function nullMoveFen(fen: string): string | null {
  if (new Chess(fen).inCheck()) return null;
  const p = fen.split(' ');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  p[3] = '-';
  try {
    return new Chess(p.join(' ')).fen();
  } catch {
    return null;
  }
}

async function computeThreat(s: Stockfish, ply: number, signal: AbortSignal) {
  if (threats[ply] !== undefined) return;
  const nf = nullMoveFen(fens[ply]);
  const e = evals[ply];
  if (!nf || !e) {
    threats[ply] = null;
    return;
  }
  const r = await s.analyse(nf, { movetime: Math.min(settings.sfMovetime, 600), signal });
  if (signal.aborted || ply >= fens.length) return;
  const line = r.lines[0];
  if (!r.bestmove || !line) {
    threats[ply] = null;
    return;
  }
  const oppNow = chessAt(ply).turn() === 'w' ? 100 - e.white : e.white;
  const oppThreat = line.mate !== undefined ? (line.mate > 0 ? 100 : 0) : winPct(line.cp ?? 0);
  if (oppThreat - oppNow < 12) {
    threats[ply] = null;
    return;
  }
  const mv = new Chess(nf).move(toMove(r.bestmove));
  let text = `对手威胁 <b>${mv.san}</b>`;
  if (line.mate !== undefined && line.mate > 0) text += `，${line.mate} 步杀`;
  else if (mv.captured) text += `，吃掉你的${PIECE_NAME[mv.captured]}`;
  threats[ply] = { uci: r.bestmove, text };
}

/** Pre-analyse the position on the user's turn (evaluation + opponent threat). */
function coachTurn() {
  const tip = fens.length - 1;
  if (!coachOn || screen !== 'game' || mode !== 'play' || result !== '' || coachState !== 'idle') return;
  if (chessAt(tip).turn() !== userColor || prep?.ply === tip) return;
  prepCtrl?.abort();
  const ctrl = new AbortController();
  prepCtrl = ctrl;
  const p = (async () => {
    try {
      const s = await getSf();
      await evalPly(s, tip, ctrl.signal);
      if (ctrl.signal.aborted) return;
      update();
      await computeThreat(s, tip, ctrl.signal);
      if (!ctrl.signal.aborted) update();
    } catch (err) {
      console.error(err);
    }
  })();
  prep = { ply: tip, p };
}

/** After the user's move from `ply`: judge it and pause the game if it was bad enough. */
async function coachCheck(ply: number) {
  coachCtrl?.abort();
  const ctrl = new AbortController();
  coachCtrl = ctrl;
  coachState = 'checking';
  coachPly = ply;
  coachNote = '';
  update();
  try {
    if (prep?.ply === ply) await prep.p;
    const s = await getSf();
    await evalPly(s, ply, ctrl.signal);
    await evalPly(s, ply + 1, ctrl.signal);
    if (ctrl.signal.aborted) return;
    const r = reviewOf(ply);
    coachState = r && SEVERITY[r.judgement] >= SEVERITY[settings.coachLevel] ? 'paused' : 'idle';
  } catch (err) {
    console.error(err);
    if (ctrl.signal.aborted) return;
    coachState = 'idle';
  } finally {
    if (coachCtrl === ctrl) coachCtrl = null;
  }
  update();
  if (coachState === 'idle') void maiaTurn();
}

function coachRetry() {
  const ply = coachPly;
  if (coachState !== 'paused' || ply < 0) return;
  gameToken++;
  maiaThinking = false;
  const e = evals[ply];
  const t = threats[ply];
  coachReset();
  truncate(ply);
  evals[ply] = e;
  threats[ply] = t;
  cursor = ply;
  hintShapes = [];
  coachNote = '再想一想，找一步更好的棋。';
  $('hint-box').textContent = '';
  saveGame();
  update();
  coachTurn();
}

/** On entering the game: review an unjudged last user move before Maia replies. */
function resumeCoach() {
  const tip = fens.length - 1;
  if (coachOn && mode === 'play' && result === '' && coachState === 'idle' && tip > 0 && chessAt(tip).turn() !== userColor && !reviewOf(tip - 1)) {
    void coachCheck(tip - 1);
    return;
  }
  void maiaTurn();
  coachTurn();
}

function coachContinue() {
  coachState = 'idle';
  coachPly = -1;
  update();
  void maiaTurn();
}

/** User pieces that are attacked and either undefended or attacked by something cheaper. */
function hangingSquares(): Square[] {
  const c = chessAt(cursor);
  const opp: Color = userColor === 'w' ? 'b' : 'w';
  const out: Square[] = [];
  for (const row of c.board())
    for (const sq of row) {
      if (!sq || sq.color !== userColor || sq.type === 'k') continue;
      const atk = c.attackers(sq.square, opp);
      if (!atk.length) continue;
      const cheapest = Math.min(...atk.map((a) => (c.get(a)?.type === 'k' ? 100 : PIECE_VALUE[c.get(a)!.type])));
      if (!c.attackers(sq.square, userColor).length || cheapest < PIECE_VALUE[sq.type]) out.push(sq.square);
    }
  return out;
}

function coachShapes(): DrawShape[] {
  const tip = fens.length - 1;
  if (!coachOn || mode !== 'play' || cursor !== tip || result !== '') return [];
  const arrow = (u: string, brush: string): DrawShape => ({ orig: u.slice(0, 2) as Key, dest: u.slice(2, 4) as Key, brush });
  if (coachState === 'paused') {
    const out: DrawShape[] = [];
    const ref = evals[coachPly + 1]?.best;
    if (ref) out.push(arrow(ref, 'red'));
    const better = evals[coachPly]?.best;
    if (better && better !== moves[coachPly]?.uci) out.push({ ...arrow(better, 'green'), modifiers: { lineWidth: 8 } });
    return out;
  }
  if (coachState !== 'idle' || chessAt(tip).turn() !== userColor) return [];
  const out: DrawShape[] = [];
  if (settings.coachBest && evals[tip]?.best) out.push(arrow(evals[tip]!.best!, 'green'));
  const t = threats[tip];
  if (settings.coachThreats && t) out.push(arrow(t.uci, 'red'));
  if (settings.coachHanging) for (const sq of hangingSquares()) out.push({ orig: sq as Key, brush: 'red' });
  return out;
}

function explainMistake(ply: number): string {
  const r = reviewOf(ply);
  const before = evals[ply];
  const after = evals[ply + 1];
  if (!r || !before || !after) return '';
  const info = JUDGEMENT_INFO[r.judgement];
  const num = chessAt(ply).fen().split(' ')[5];
  const parts = [
    `<div class="cc-head"><span class="cc-title" style="color:${info.color}">${num}${chessAt(ply).turn() === 'w' ? '.' : '…'} ${moves[ply].san}${info.symbol} ${info.label}</span>` +
      `<span class="cc-win">胜率 ${r.before.toFixed(0)}% → <b style="color:${info.color}">${r.after.toFixed(0)}%</b></span></div>`,
  ];
  if (after.best) {
    const mv = chessAt(ply + 1).move(toMove(after.best));
    const l = after.lines[0];
    let why: string;
    if (l?.mate !== undefined && l.mate > 0) why = `对手有 ${l.mate} 步杀：${pvToSan(fens[ply + 1], l.pv, 6)}`;
    else if (mv.captured) why = `对手可以 <b>${mv.san}</b> 吃掉你的${PIECE_NAME[mv.captured]}`;
    else why = `对手的最佳应对是 <b>${mv.san}</b>：${pvToSan(fens[ply + 1], l?.pv ?? [], 6)}`;
    parts.push(`<div class="cc-why"><span class="tag bad">问题</span><span>${why}</span></div>`);
  }
  if (before.best && before.best !== moves[ply].uci) {
    const mv = chessAt(ply).move(toMove(before.best));
    const l = before.lines[0];
    let why = '';
    if (l?.mate !== undefined && l.mate > 0) why = `，${l.mate} 步杀`;
    else if (mv.captured) why = `，吃掉对方的${PIECE_NAME[mv.captured]}`;
    else if (mv.san.includes('+')) why = '，并将军';
    parts.push(
      `<div class="cc-why"><span class="tag good">更好</span><span><b>${mv.san}</b>（${before.text}）${why}</span></div>`,
      `<div class="cc-pv">${pvToSan(fens[ply], l?.pv ?? [], 5)}</div>`,
    );
  }
  return parts.join('');
}

function renderCoachLive() {
  const box = $('coach-live');
  $('game').classList.toggle('show-eval', coachOn && settings.coachEval);
  if (!coachOn || mode !== 'play') {
    box.innerHTML = '';
    return;
  }
  const tip = fens.length - 1;
  if (coachState === 'checking') {
    box.innerHTML = '<div class="cl-row muted"><span class="dots"><i></i><i></i><i></i></span>教练正在看你这步…</div>';
    return;
  }
  if (coachState === 'paused') {
    box.innerHTML =
      `<div class="coach-card">${explainMistake(coachPly)}` +
      `<div class="cc-actions"><button class="primary" data-act="retry">重走这步</button><button data-act="go">继续对局</button></div></div>`;
    return;
  }
  const parts: string[] = [];
  if (coachNote) parts.push(`<div class="cl-row">${coachNote}</div>`);
  let last = tip - 1;
  while (last >= 0 && chessAt(last).turn() !== userColor) last--;
  const r = last >= 0 && !coachNote ? reviewOf(last) : null;
  if (r) {
    const info = JUDGEMENT_INFO[r.judgement];
    const ok = SEVERITY[r.judgement] === 0;
    parts.push(`<div class="cl-row"><span class="tag" style="background:${info.color}">${ok ? '✓' : info.symbol}</span><span>${moves[last].san} ${info.label}</span></div>`);
  }
  if (result === '' && cursor === tip && chessAt(tip).turn() === userColor) {
    const t = threats[tip];
    if (settings.coachThreats && t) parts.push(`<div class="cl-row warn"><span class="tag bad">!</span><span>${t.text}</span></div>`);
    if (settings.coachHanging) {
      const h = hangingSquares();
      if (h.length) parts.push(`<div class="cl-row warn"><span class="tag bad">!</span><span>保护不足：${h.map((q) => PIECE_NAME[chessAt(tip).get(q)!.type] + q).join('、')}</span></div>`);
    }
    const e = evals[tip];
    if (settings.coachBest && e?.best) parts.push(`<div class="cl-row"><span class="tag good">★</span><span>推荐 <b>${sanOf(fens[tip], e.best)}</b>（${e.text}）</span></div>`);
  }
  box.innerHTML = parts.join('');
}

function openCoachSettings() {
  const dlg = $<HTMLDialogElement>('dlg-coach');
  const f = dlg.querySelector('form')!;
  const el = (n: string) => f.elements.namedItem(n) as HTMLInputElement;
  el('coachEnabled').checked = coachOn;
  el('coachEnabled').closest('label')!.classList.toggle('hidden', screen !== 'game');
  el('coachLevel').value = settings.coachLevel;
  for (const k of ['coachThreats', 'coachHanging', 'coachBest', 'coachEval'] as const) el(k).checked = settings[k];
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    settings = {
      ...settings,
      coachLevel: el('coachLevel').value as Settings['coachLevel'],
      coachThreats: el('coachThreats').checked,
      coachHanging: el('coachHanging').checked,
      coachBest: el('coachBest').checked,
      coachEval: el('coachEval').checked,
    };
    saveSettings(settings);
    if (screen === 'game' && el('coachEnabled').checked !== coachOn) setCoach(el('coachEnabled').checked);
    else update();
  };
  dlg.showModal();
}

function setCoach(on: boolean) {
  coachOn = on;
  if (!on) coachReset();
  saveGame();
  update();
  resumeCoach();
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
    if (c.left < b.left) box.scrollLeft += c.left - b.left - 24;
    else if (c.right > b.right) box.scrollLeft += c.right - b.right + 24;
  } else {
    box.scrollTop = cursor === 0 ? 0 : box.scrollHeight;
    box.scrollLeft = cursor === 0 ? 0 : box.scrollWidth;
  }
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PIECE_GLYPH: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };

/** Captured pieces (shown next to the capturer) and material lead for `color`. */
function material(color: Color): { html: string; diff: number } {
  const count: Record<Color, Record<string, number>> = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of chessAt(cursor).board()) for (const sq of row) if (sq && sq.type !== 'k') count[sq.color][sq.type]++;
  const full: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const opp: Color = color === 'w' ? 'b' : 'w';
  let html = '';
  let score = 0;
  for (const t of ['p', 'n', 'b', 'r', 'q']) {
    const taken = Math.max(0, full[t] - count[opp][t]);
    html += PIECE_GLYPH[t].repeat(taken);
    score += PIECE_VALUE[t] * (count[color][t] - count[opp][t]);
  }
  return { html, diff: score };
}

function renderPlayers() {
  const model = MODELS[settings.model].label.split('（')[0];
  const bottomIsUser = !flipped;
  const oppColor: Color = userColor === 'w' ? 'b' : 'w';
  const turn = chessAt(cursor).turn();
  const card = (who: 'me' | 'maia') => {
    const color = who === 'me' ? userColor : oppColor;
    const m = material(color);
    const name = who === 'me' ? '我' : model;
    const avatar = who === 'me' ? '<div class="avatar me">♙</div>' : '<div class="avatar bot">♞</div>';
    const thinking = who === 'maia' && maiaThinking ? '<span class="dots"><i></i><i></i><i></i></span>' : '';
    return (
      `${avatar}<div class="pinfo"><div class="pname">${name} <span class="elo">(${settings.elo})</span>${thinking}</div>` +
      `<div class="caps ${color === 'w' ? 'by-w' : 'by-b'}">${m.html}${m.diff > 0 ? `<span class="adv">+${m.diff}</span>` : ''}</div></div>` +
      `<div class="clock${turn === color && result === '' ? ' active' : ''}">${color === 'w' ? '白' : '黑'}</div>`
    );
  };
  $('player-top').innerHTML = card(bottomIsUser ? 'maia' : 'me');
  $('player-bottom').innerHTML = card(bottomIsUser ? 'me' : 'maia');
}

function renderEvalBar() {
  const e = liveOn && liveLines[0] ? posEvalFrom(cursor, liveLines, liveLines[0].pv[0]) : evals[cursor];
  const bar = $('evalbar');
  bar.classList.toggle('hidden', mode !== 'review' && !(coachOn && settings.coachEval));
  const white = e ? e.white : 50;
  const whiteAtBottom = (userColor === 'w') !== flipped;
  bar.classList.toggle('flip', !whiteAtBottom);
  $('evalbar-fill').style.height = `${white}%`;
  $('evalbar-text').textContent = e ? e.text : '';
}

function renderPlayInfo() {
  const box = $('play-info');
  if (result) box.textContent = `对局结束：${resultText()}`;
  else if (coachState === 'paused') box.textContent = '';
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
  renderCoachLive();
  renderLines();
  checkResult();
}

function checkResult() {
  if (result === '' || result === shownResult || mode !== 'play' || screen !== 'game') return;
  shownResult = result;
  const win = (result === '1-0' && userColor === 'w') || (result === '0-1' && userColor === 'b');
  const draw = result === '1/2-1/2';
  $('result-icon').textContent = draw ? '½' : win ? '♔' : '♚';
  $('result-icon').className = `result-icon ${draw ? 'draw' : win ? 'win' : 'loss'}`;
  $('result-title').textContent = draw ? '和棋' : win ? '你赢了！' : 'Maia 获胜';
  $('result-sub').textContent = resultText();
  setTimeout(() => $<HTMLDialogElement>('dlg-result').showModal(), 450);
}

function showScreen(s: 'home' | 'game', push = true) {
  screen = s;
  if (push && s === 'game' && location.hash !== '#game') history.pushState(null, '', '#game');
  if (push && s === 'home' && location.hash === '#game') history.back();
  $('home').classList.toggle('active', s === 'home');
  $('game').classList.toggle('active', s === 'game');
  if (s === 'home') {
    gameToken++;
    maiaThinking = false;
    prepCtrl?.abort();
    prep = null;
    if (coachState === 'checking') coachReset();
    setLive(false);
    renderHome();
  } else {
    requestAnimationFrame(() => {
      cg.redrawAll();
      update();
      resumeCoach();
    });
  }
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
  $('game').dataset.mode = m;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === m));
  $('tab-play').classList.toggle('hidden', m !== 'play');
  $('tab-review').classList.toggle('hidden', m !== 'review');
  if (m === 'play') {
    setLive(false);
    batchCtrl?.abort();
  } else if (coachState !== 'idle') coachReset();
  update();
  if (m === 'play') {
    void maiaTurn();
    coachTurn();
  }
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
      ...old,
      model: el('model').value as Settings['model'],
      elo: num('elo'),
      color: el('color').value as Settings['color'],
      temperature: num('temperature'),
      backend: el('backend').value as Settings['backend'],
      useHistory: el('useHistory').checked,
      thinkDelay: el('thinkDelay').checked,
      sfMovetime: Math.max(100, num('sfMovetime') || 1000),
      sfThreads: Math.max(1, num('sfThreads') || 1),
      sfHash: Math.max(16, num('sfHash') || 64),
      lowMemory: el('lowMemory').checked,
      warmup: old.warmup,
    };
    saveSettings(settings);
    if (old.sfThreads !== settings.sfThreads || old.sfHash !== settings.sfHash) unloadSf();
    if (old.model !== settings.model || old.backend !== settings.backend) unloadMaia();
    if (old.elo !== settings.elo || old.model !== settings.model || old.useHistory !== settings.useHistory) human = [];
    if (old.sfMovetime !== settings.sfMovetime) evals = [];
    update();
    renderHome();
  };
  dlg.showModal();
}

// ---------- engine manager ----------

const downloads = new Map<PackageId, AbortController>();

async function warmup() {
  try {
    await getMaia();
    // in low-memory mode both engines can't be resident; keep the one needed to play
    if (!settings.lowMemory) await getSf();
    setStatus(settings.lowMemory ? `${MODELS[settings.model].label} 已预加载` : 'Maia 与 Stockfish 已预加载');
  } catch (err) {
    console.warn('预加载失败', err);
  }
}

async function renderPackages() {
  const list = $('pkg-list');
  if (!(await loadPrecache()) || !('caches' in self)) {
    list.innerHTML = '<p class="muted">引擎管理仅在生产构建（npm run build + preview / 部署）下可用。</p>';
    $<HTMLButtonElement>('btn-dl-rec').disabled = true;
    return;
  }
  const pkgs = await listPackages();
  list.replaceChildren(
    ...pkgs.map((p) => {
      const row = document.createElement('div');
      row.className = 'pkg';
      row.dataset.id = p.id;
      const done = isComplete(p);
      const busy = downloads.has(p.id);
      const using = p.id === `maia-${settings.model}` ? '（当前）' : '';
      row.innerHTML =
        `<div class="pkg-main"><b>${p.label}${using}</b><span class="muted">${p.desc} · ${fmtMB(p.size)}</span>` +
        `<div class="progress${busy ? '' : ' hidden'}"><div></div></div>` +
        `<span class="pkg-state">${done ? '✅ 已下载' : busy ? '下载中…' : p.cached ? `部分（${p.cached}/${p.files.length}）` : '未下载'}</span></div>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = busy ? '取消' : done ? '删除' : '下载';
      btn.onclick = async () => {
        if (busy) downloads.get(p.id)!.abort();
        else if (done) {
          if (p.id === 'core' && !confirm('删除应用本体后需联网才能打开，确定？')) return;
          await deletePackage(p);
        } else void startDownload(p);
        await renderPackages();
      };
      row.append(btn);
      return row;
    }),
  );
  const info = await storageInfo();
  if (info)
    $('storage-info').textContent =
      `已用存储 ${fmtMB(info.usage)} / 配额 ${fmtMB(info.quota)}　持久化：${info.persisted ? '✅' : '❌（系统空间不足时可能被清理）'}`;
}

function pkgRow(id: PackageId) {
  return document.querySelector<HTMLElement>(`#pkg-list .pkg[data-id="${id}"]`);
}

async function startDownload(p: Package) {
  if (downloads.has(p.id)) return;
  const ctrl = new AbortController();
  downloads.set(p.id, ctrl);
  void requestPersistence();
  try {
    await downloadPackage(p, ctrl.signal, (l, t) => {
      const row = pkgRow(p.id);
      if (!row) return;
      row.querySelector<HTMLElement>('.progress')?.classList.remove('hidden');
      const bar = row.querySelector<HTMLElement>('.progress > div');
      if (bar) bar.style.width = `${t ? (l / t) * 100 : 0}%`;
      const st = row.querySelector('.pkg-state');
      if (st) st.textContent = `下载中 ${fmtMB(l)} / ${fmtMB(t)}`;
    });
    setStatus(`${p.label} 已下载`);
  } catch (err) {
    if (!ctrl.signal.aborted) setStatus(`${p.label} 下载失败：${(err as Error).message}`);
  } finally {
    downloads.delete(p.id);
    if ($<HTMLDialogElement>('dlg-engines').open) await renderPackages();
  }
}

async function downloadRecommended() {
  const pkgs = await listPackages();
  const want: PackageId[] = ['core', 'stockfish', `maia-${settings.model}`];
  // sequential: parallel downloads would only compete for bandwidth
  for (const id of want) {
    const p = pkgs.find((x) => x.id === id);
    if (p && !isComplete(p)) await startDownload(p);
  }
  if (settings.warmup) void warmup();
}

function openEngines() {
  const dlg = $<HTMLDialogElement>('dlg-engines');
  const chk = $<HTMLInputElement>('chk-warm');
  chk.checked = settings.warmup;
  chk.onchange = () => {
    settings = { ...settings, warmup: chk.checked };
    saveSettings(settings);
  };
  $('btn-dl-rec').onclick = () => void downloadRecommended();
  $('btn-warm').onclick = () => void warmup();
  void loadPrecache().then((ok) => (ok ? pruneStale() : 0));
  void renderPackages();
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

// ---------- home ----------

let homeCg: Api;

function renderHome() {
  const elo = $<HTMLInputElement>('home-elo');
  elo.value = String(settings.elo);
  $('home-elo-val').textContent = String(settings.elo);
  document.querySelectorAll<HTMLButtonElement>('#home-color button').forEach((b) => b.classList.toggle('active', b.dataset.color === settings.color));
  document.querySelectorAll<HTMLButtonElement>('#home-type button').forEach((b) => b.classList.toggle('active', b.dataset.type === settings.gameType));
  $('home-coach-desc').textContent = settings.gameType === 'coach' ? '走出' + JUDGEMENT_INFO[settings.coachLevel].label + '时暂停讲解，可重走' : '无提示，自由对弈';
  const has = moves.length > 0;
  const btn = $<HTMLButtonElement>('btn-continue');
  btn.disabled = !has;
  $('continue-title').textContent = has && result === '' ? '继续对局' : '上一局';
  $('continue-sub').textContent = has ? `${coachOn ? '教练 · ' : ''}${Math.ceil(moves.length / 2)} 回合 · ${result || '进行中'}` : '暂无';
  homeCg?.set({ fen: fens[fens.length - 1], orientation: userColor === 'w' ? 'white' : 'black', lastMove: undefined });
}

function saveHomeSettings(patch: Partial<Settings>) {
  const old = settings;
  settings = { ...settings, ...patch };
  saveSettings(settings);
  if (old.elo !== settings.elo) human = [];
  renderHome();
}

function openPgnImport() {
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
    flipped = false;
    saveGame();
    setMode('review');
    showScreen('game');
  };
  dlg.showModal();
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
  document.querySelectorAll<HTMLButtonElement>('dialog [data-close]').forEach((b) => {
    b.onclick = () => b.closest('dialog')!.close();
  });
  // tap outside a dialog's box closes it
  document.querySelectorAll<HTMLDialogElement>('dialog').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target === d && d.id !== 'dlg-promo') d.close();
    });
  });
  const menu = $<HTMLDialogElement>('dlg-menu');
  const fromMenu = (fn: () => void) => () => {
    menu.close();
    fn();
  };

  $('btn-play').onclick = () => {
    newGame();
    showScreen('game');
  };
  $('btn-continue').onclick = () => {
    setMode(result === '' ? 'play' : 'review');
    showScreen('game');
  };
  $('btn-home-import').onclick = openPgnImport;
  $<HTMLInputElement>('home-elo').oninput = (e) => {
    $('home-elo-val').textContent = (e.target as HTMLInputElement).value;
  };
  $<HTMLInputElement>('home-elo').onchange = (e) => saveHomeSettings({ elo: Number((e.target as HTMLInputElement).value) });
  document.querySelectorAll<HTMLButtonElement>('#home-color button').forEach((b) => {
    b.onclick = () => saveHomeSettings({ color: b.dataset.color as Settings['color'] });
  });
  document.querySelectorAll<HTMLButtonElement>('#home-type button').forEach((b) => {
    b.onclick = () => saveHomeSettings({ gameType: b.dataset.type as Settings['gameType'] });
  });
  $('btn-home-coach').onclick = openCoachSettings;
  $('btn-coach').onclick = openCoachSettings;
  $('coach-live').onclick = (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'retry') coachRetry();
    else if (act === 'go') coachContinue();
  };
  $('btn-back').onclick = () => showScreen('home');
  $('btn-flip').onclick = () => {
    flipped = !flipped;
    update();
  };
  $('btn-menu').onclick = () => menu.showModal();
  $('btn-new').onclick = fromMenu(newGame);
  $('btn-resign').onclick = fromMenu(() => {
    if (result === '' && moves.length && confirm('确定认输？')) resign();
  });
  $('btn-menu-settings').onclick = fromMenu(openSettings);
  $('btn-undo').onclick = undo;
  $('btn-hint').onclick = () => void hint();
  $('btn-analyse').onclick = () => void analyseGame();
  $('btn-live').onclick = () => setLive(!liveOn);
  $('btn-settings').onclick = openSettings;
  $('btn-engines').onclick = openEngines;
  $('btn-result-review').onclick = () => {
    $<HTMLDialogElement>('dlg-result').close();
    cursor = 0;
    setMode('review');
    void analyseGame();
  };
  $('btn-result-new').onclick = () => {
    $<HTMLDialogElement>('dlg-result').close();
    newGame();
  };
  $('moves').onclick = (e) => {
    const ply = (e.target as HTMLElement).dataset.ply;
    if (ply) goto(Number(ply));
  };
  $('graph').onclick = (e) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    goto(Math.round(((e.clientX - rect.left) / rect.width) * (fens.length - 1)));
  };
  $('btn-pgn-copy').onclick = fromMenu(async () => {
    const pgn = exportPgn();
    try {
      await navigator.clipboard.writeText(pgn);
      setStatus('PGN 已复制');
    } catch {
      prompt('复制 PGN：', pgn);
    }
  });
  $('btn-pgn-import').onclick = fromMenu(openPgnImport);
  document.addEventListener('keydown', (e) => {
    if (screen !== 'game' || (e.target as HTMLElement).closest('dialog')) return;
    if (e.key === 'ArrowLeft') goto(cursor - 1);
    else if (e.key === 'ArrowRight') goto(cursor + 1);
    else if (e.key === 'Home') goto(0);
    else if (e.key === 'End') goto(fens.length - 1);
  });
}

function init() {
  cg = Chessground($('board'), {
    animation: { duration: 180 },
    ranksPosition: 'left',
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: (o, d) => void onUserMove(o, d) } },
    premovable: { enabled: false },
    drawable: { enabled: true },
  });
  homeCg = Chessground($('home-board'), { viewOnly: true, coordinates: false, animation: { enabled: false } });
  // chessground caches the board rect and only refreshes it on scroll/resize; layout shifts without a
  // size change (e.g. the screen slide-in transition) leave it stale and taps land on the wrong square
  const freshBounds = () => cg.state.dom.bounds.clear();
  for (const ev of ['touchstart', 'mousedown']) $('board').addEventListener(ev, freshBounds, { capture: true, passive: true });
  bind();
  const saved = localStorage.getItem(GAME_KEY);
  if (!saved || !loadGame(JSON.parse(saved) as SavedGame)) userColor = settings.color === 'b' ? 'b' : 'w';
  update();
  renderHome();
  // 系统返回键/手势回到主页
  window.addEventListener('popstate', () => {
    if (screen === 'game' && location.hash !== '#game') showScreen('home', false);
    else if (screen === 'home' && location.hash === '#game') showScreen('game', false);
  });
  if (location.hash === '#game') showScreen('game', false);
  setStatus(self.crossOriginIsolated ? '就绪（多线程）' : '就绪（单线程模式）');
  void maiaTurn();

  const willReload = import.meta.env.PROD && 'serviceWorker' in navigator && !self.crossOriginIsolated && !sessionStorage.getItem('coi-reloaded');
  if (settings.warmup && !willReload) {
    const idle = (cb: () => void) => ('requestIdleCallback' in self ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1500));
    idle(() => void warmup());
  }

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
