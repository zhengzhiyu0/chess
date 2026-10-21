import { Chess, type Square } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key, MoveMetadata } from '@lichess-org/chessground/types';
import type { DrawBrushes, DrawShape } from '@lichess-org/chessground/draw';
import '@lichess-org/chessground/assets/chessground.base.css';
import './style.css';

import { MODELS, type MaiaResult } from './maia/maia';
import { sampleMove } from './maia/sample';
import type { Stockfish, SfLine } from './engine/stockfish';
import { evalText, judge, JUDGEMENT_INFO, moveAccuracy, whiteWinPct, winPct, type Judgement } from './coach/coach';
import { loadSettings, saveSettings, type Settings } from './settings';
import { GameTree, mainChild, type GNode } from './game/tree';
import { END_REASON_TEXT, START_FEN, pvToSan, sanOf, terminalOf, timeoutResult, toMove, turnOf, type Color, type EndReason } from './game/rules';
import { exportPgn as treeToPgn, parsePgn, type Annotation } from './game/pgn';
import { ChessClock, TIME_CONTROLS, fmtClockShort, pgnTimeControl, thinkBudget, timeControlOf } from './game/clock';
import { computeStats, loadHistory, newGameId, saveHistory, upsert, type StoredGame } from './game/history';
import { SOUND_THEMES, configureSound, play, previewTheme, soundForSan, unlockAudio } from './audio/sound';
import { $, escapeHtml, setStatus } from './app/dom';
import { BOARD_THEMES, PIECE_SETS, applyAppearance, boardColors, pieceUrl } from './app/appearance';
import { Engines } from './app/engines';
import { autoOffline, openEngines, type EnginesCtx } from './app/engines-ui';
import { findNode, movesHtml } from './app/moves-ui';
import { HANGING_BADGE, HANGING_GLOW, judgeBoardSvg, judgeColor, judgeIcon } from './app/judge-icon';
import { openHistory } from './app/history-ui';

// ---------- state ----------

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

/** Per-position analysis cache stored on tree nodes. */
interface Ann {
  eval: PosEval;
  human: MaiaResult;
  /** null = computed, nothing serious */
  threat: Threat | null;
}

type Node = GNode<Ann>;

/** Save format before the move tree existed. */
interface LegacyGame {
  startFen: string;
  moves: string[];
  userColor: Color;
  result: string;
  coach?: boolean;
}

const GAME_KEY = 'maia-coach.game';

let settings: Settings = loadSettings();
let tree = new GameTree<Ann>(START_FEN);
let node: Node = tree.root;
let gameId = newGameId();
let gameDate = Date.now();
let gameElo: number | undefined = settings.elo;
let gameModel: string = settings.model;
let userColor: Color = 'w';
let result = '';
let reason: EndReason | undefined;
let imported = false;
let headers: Record<string, string> | undefined;
let tcId = 'none';
let clock: ChessClock | null = null;
let lowTimeWarned = false;
let drawOfferPly = -100;
let mode: 'play' | 'review' = 'play';
let flipped = false;
let gameToken = 0;
let maiaThinking = false;
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
/** position before the user's move that the coach is judging */
let coachFrom: Node | null = null;
/** moves taken back with "重走这步", re-attached as variations once a different move is played */
let retried: { from: Node; nodes: Node[] } | null = null;
let history: StoredGame[] = loadHistory();

const engines = new Engines(
  () => settings,
  // coached play alternates Maia and Stockfish every move; see Engines
  () => coachOn && mode === 'play',
  () => liveCtrl?.abort(),
);
const getMaia = () => engines.getMaia();
const getSf = () => engines.getSf();
const enginesCtx: EnginesCtx = {
  settings: () => settings,
  patchSettings: (patch) => {
    settings = { ...settings, ...patch };
    saveSettings(settings);
  },
  warmup: () => engines.warmup(),
};

// ---------- game helpers ----------

function tip(): Node {
  let n = tree.root;
  for (let c = mainChild(n); c; c = mainChild(c)) n = c;
  return n;
}

/** Nearest position of `n` that belongs to the game record (not an analysis exploration). */
function realOf(n: Node): Node {
  let a = n;
  while (a.x && a.parent) a = a.parent;
  return a;
}

const fensTo = (n: Node) => tree.pathTo(n).map((x) => x.fen);
const movesTo = (n: Node) => tree.pathTo(n).slice(1).map((x) => x.uci);
const chessOf = (n: Node) => new Chess(n.fen);
const currentLine = () => tree.lineThrough(node);
/** the recorded game line through the current position, ignoring explorations (graph, summary, batch analysis) */
const gameLine = () => tree.lineThrough(realOf(node));
const arrow = (u: string, brush: string): DrawShape => ({ orig: u.slice(0, 2) as Key, dest: u.slice(2, 4) as Key, brush });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clearAnn(...keys: (keyof Ann)[]) {
  for (const n of tree.nodes()) for (const k of keys) delete n.a[k];
}

function resultText(): string {
  if (!result) return '';
  return reason ? `${result}（${END_REASON_TEXT[reason]}）` : result;
}

function stored(): StoredGame {
  if (!result && !imported) {
    gameElo = settings.elo;
    gameModel = settings.model;
  }
  return {
    id: gameId,
    date: gameDate,
    startFen: tree.root.fen,
    tree: tree.serialize(),
    userColor,
    result,
    reason,
    coach: coachOn,
    elo: imported ? undefined : gameElo,
    model: imported ? undefined : gameModel,
    tc: tcId,
    clock: clock && !result ? clock.snapshot(performance.now()) : undefined,
    headers,
    imported: imported || undefined,
  };
}

function saveGame() {
  const g = stored();
  try {
    localStorage.setItem(GAME_KEY, JSON.stringify(g));
  } catch (err) {
    console.warn('保存对局失败', err);
  }
  if (result && !imported) {
    history = upsert(history, g);
    saveHistory(history);
  }
}

function resetTransient() {
  shownResult = result;
  lowTimeWarned = false;
  drawOfferPly = -100;
  hintShapes = [];
  retried = null;
  liveLines = [];
  coachReset();
  $('hint-box').textContent = '';
}

function loadGame(raw: StoredGame | LegacyGame): boolean {
  try {
    const g: StoredGame =
      'tree' in raw
        ? raw
        : {
            id: newGameId(),
            date: Date.now(),
            startFen: raw.startFen,
            tree: GameTree.fromMoves(raw.startFen, raw.moves).serialize(),
            userColor: raw.userColor,
            result: raw.result,
            coach: raw.coach,
          };
    tree = GameTree.deserialize<Ann>(g.startFen, g.tree);
    node = tip();
    gameId = g.id;
    gameDate = g.date;
    userColor = g.userColor;
    result = g.result || '';
    reason = g.reason;
    if (!result) {
      const end = terminalOf(fensTo(node));
      if (end) ({ result, reason } = end);
    }
    imported = Boolean(g.imported);
    headers = g.headers;
    coachOn = Boolean(g.coach);
    gameElo = g.elo ?? (imported ? undefined : settings.elo);
    gameModel = g.model ?? settings.model;
    tcId = g.tc ?? 'none';
    const tc = timeControlOf(tcId);
    clock = tc ? new ChessClock(tc, g.clock ?? node.clock) : null;
    resetTransient();
    return true;
  } catch (err) {
    console.warn('读取对局失败', err);
    return false;
  }
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
  if (mode === 'review') return true;
  return node === tip() && result === '' && !maiaThinking && coachState === 'idle' && turnOf(node.fen) === userColor;
}

function canPremove(): boolean {
  return mode === 'play' && settings.premove && node === tip() && result === '' && coachState === 'idle' && turnOf(node.fen) !== userColor;
}

/** Arrow brushes for review: green = engine best / the move you should have played, blue = what players at your rating usually play. */
const BRUSHES = {
  best: { key: 'kb', color: '#5fa83f', opacity: 0.85, lineWidth: 7 },
  human: { key: 'kh', color: '#3b82d6', opacity: 0.8, lineWidth: 5 },
  /** opponent's threat (coach) */
  threat: { key: 'kt', color: '#e8402f', opacity: 0.75, lineWidth: 6 },
};
const LEGEND_TEXT: Record<string, string> = { best: '最佳', human: '常见' };

interface ReviewArrow {
  uci: string;
  kind: keyof typeof BRUSHES;
  text: string;
}

/** Whether the move leading to `n` is judged in review (by default only the user's own moves). */
function showMove(n: Node): boolean {
  return Boolean(n.parent) && (settings.reviewOpponent || imported || turnOf(n.parent!.fen) === userColor);
}

/** Whether suggestions for the side to move in `n` are shown. */
const showSide = (n: Node) => settings.reviewOpponent || imported || turnOf(n.fen) === userColor;

/** Review arrows, chess.com style: after a bad move, the move that should have been played; otherwise the best (and typical human) move here. */
function reviewArrows(): ReviewArrow[] {
  const out: ReviewArrow[] = [];
  const p = node.parent;
  const r = p && showMove(node) ? reviewOf(node) : null;
  if (p && r && SEVERITY[r.judgement] > 0 && p.a.eval?.best) {
    out.push({ uci: p.a.eval.best, kind: 'best', text: `应走 ${sanOf(p.fen, p.a.eval.best)}` });
    return out;
  }
  if (!showSide(node)) return out;
  const best = liveOn && liveLines[0]?.pv[0] ? liveLines[0].pv[0] : node.a.eval?.best;
  if (best) out.push({ uci: best, kind: 'best', text: `最佳 ${sanOf(node.fen, best)}` });
  const h = node.a.human?.moves[0];
  if (h && h.uci !== best) out.push({ uci: h.uci, kind: 'human', text: `${settings.elo} 分常走 ${sanOf(node.fen, h.uci)}（${(h.p * 100).toFixed(0)}%）` });
  return out;
}

function arrows(): DrawShape[] {
  const shapes: DrawShape[] = [...hintShapes, ...coachShapes()];
  if (mode === 'review') {
    for (const a of reviewArrows()) shapes.push(arrow(a.uci, a.kind));
    const r = node.uci && showMove(node) ? reviewOf(node) : null;
    if (r && node.uci) shapes.push({ orig: node.uci.slice(2, 4) as Key, customSvg: { html: judgeBoardSvg(r.judgement) } });
  }
  return shapes;
}

function renderLegend() {
  const box = $('arrow-legend');
  if (mode !== 'review') {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = reviewArrows()
    .map((a) => `<span class="lg" title="${LEGEND_TEXT[a.kind] ?? ''}"><i style="background:${BRUSHES[a.kind].color}"></i>${escapeHtml(a.text)}</span>`)
    .join('');
}

function renderBoard() {
  const c = chessOf(node);
  const movable = canUserMove();
  const pre = !movable && canPremove();
  const turn = c.turn() === 'w' ? 'white' : 'black';
  const orientation: 'white' | 'black' = (userColor === 'w') !== flipped ? 'white' : 'black';
  cg.set({
    fen: node.fen,
    orientation,
    turnColor: turn,
    lastMove: node.uci ? [node.uci.slice(0, 2) as Key, node.uci.slice(2, 4) as Key] : undefined,
    check: c.inCheck(),
    movable: {
      free: false,
      color: movable ? turn : pre ? (userColor === 'w' ? 'white' : 'black') : undefined,
      dests: movable ? dests(c) : new Map(),
    },
    premovable: { enabled: pre },
  });
  cg.setAutoShapes(arrows());
}

function askPromotion(color: Color): Promise<string> {
  const dlg = $<HTMLDialogElement>('dlg-promo');
  const box = $('promo-choices');
  return new Promise((resolve) => {
    box.innerHTML = '';
    for (const p of 'qrbn') {
      const b = document.createElement('button');
      b.style.backgroundImage = `url('${pieceUrl(settings.pieceSet, color, p)}')`;
      b.setAttribute('aria-label', p);
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

async function onUserMove(orig: Key, dest: Key, meta?: MoveMetadata) {
  unlockAudio();
  const from = node;
  const c = chessOf(from);
  const piece = c.get(orig as Square);
  let uci = orig + dest;
  if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) uci += meta?.premove ? 'q' : await askPromotion(c.turn());
  if (node !== from) return;
  if (mode === 'play') {
    if (!playMove(uci)) {
      play('illegal');
      renderBoard();
      return;
    }
    if (result) return;
    if (coachOn) void coachCheck(tip().parent!);
    else void maiaTurn();
    return;
  }
  // review: explore freely; explorations never change the game record
  const next = tree.add(from, uci, true);
  if (!next) {
    play('illegal');
    renderBoard();
    return;
  }
  node = next;
  hintShapes = [];
  play(soundForSan(next.san));
  saveGame();
  update();
  if (liveOn) void runLive();
}

// ---------- play ----------

/** Positions fed to Maia for `n`; without history the current position is repeated (official UCI default). */
function maiaFens(n: Node): string[] {
  return settings.useHistory ? fensTo(n) : [n.fen];
}

async function maiaEval(n: Node): Promise<MaiaResult> {
  if (n.a.human) return n.a.human;
  const m = await getMaia();
  const res = await m.evaluate(chessOf(n), maiaFens(n), settings.elo, settings.elo);
  n.a.human = res;
  return res;
}

/** Plays `uci` at the end of the game (either side). */
function playMove(uci: string): boolean {
  if (result) return false;
  const parent = tip();
  const mover = turnOf(parent.fen);
  const now = performance.now();
  if (clock && clock.time(mover, now) <= 0) {
    flag(mover);
    return false;
  }
  const next = tree.add(parent, uci);
  if (!next) return false;
  tree.makeMainline(next);
  if (retried && retried.from === parent) {
    for (const r of retried.nodes) {
      if (r.uci === uci) continue;
      r.comment ??= '教练提示后重走';
      parent.children.push(r);
    }
  }
  retried = null;
  if (clock) {
    if (clock.active === mover) clock.moved(mover, now);
    next.clock = clock.snapshot(now);
  }
  node = next;
  hintShapes = [];
  $('hint-box').textContent = '';
  play(soundForSan(next.san));
  const end = terminalOf(fensTo(next));
  if (end) endGame(end.result, end.reason);
  else saveGame();
  update();
  return true;
}

function endGame(res: string, why: EndReason) {
  result = res;
  reason = why;
  gameToken++;
  maiaThinking = false;
  clock?.stop(performance.now());
  cg.cancelPremove();
  coachReset();
  setTimeout(() => play('end'), 250);
  saveGame();
}

function flag(color: Color) {
  if (result) return;
  endGame(timeoutResult(tip().fen, color), 'timeout');
  update();
}

async function maiaTurn(attempt = 0) {
  const t = tip();
  if (screen !== 'game' || mode !== 'play' || result !== '' || coachState !== 'idle' || turnOf(t.fen) === userColor) return;
  const token = ++gameToken;
  maiaThinking = true;
  update();
  let retry = false;
  try {
    const t0 = performance.now();
    const res = await maiaEval(t);
    if (token !== gameToken) return;
    const pick = sampleMove(res.moves, settings.temperature, 1);
    if (settings.thinkDelay) {
      // longer "thinking" when the position is less obvious to a human
      const unclear = 1 - res.moves[0].p;
      const want = clock
        ? thinkBudget(clock.time(turnOf(t.fen), performance.now()), clock.tc.inc, unclear) * (0.7 + Math.random() * 0.6)
        : 300 + Math.random() * 600 + unclear * 2500;
      const wait = want - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
      if (token !== gameToken) return;
    }
    maiaThinking = false;
    if (playMove(pick.uci) && settings.premove) cg.playPremove();
  } catch (err) {
    console.error(err);
    // a crashed / hung worker is replaced by getMaia() on the next call
    retry = token === gameToken && attempt < 2;
    if (token === gameToken) setStatus(retry ? 'Maia 无响应，正在重启…' : 'Maia 出错：' + (err as Error).message);
  } finally {
    if (token === gameToken) {
      maiaThinking = false;
      update();
      if (retry) void maiaTurn(attempt + 1);
      else void coachTurn();
    }
  }
}

function newGame(fen = START_FEN, color?: Color) {
  gameToken++;
  maiaThinking = false;
  batchCtrl?.abort();
  userColor = color ?? (settings.color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : settings.color);
  flipped = false;
  tree = new GameTree<Ann>(fen);
  node = tree.root;
  gameId = newGameId();
  gameDate = Date.now();
  gameElo = settings.elo;
  gameModel = settings.model;
  result = '';
  reason = undefined;
  imported = false;
  headers = undefined;
  tcId = settings.timeControl;
  const tc = timeControlOf(tcId);
  clock = tc ? new ChessClock(tc) : null;
  if (clock) tree.root.clock = [...clock.remaining];
  coachOn = settings.gameType === 'coach';
  resetTransient();
  cg.cancelPremove();
  play('start');
  saveGame();
  setMode('play');
}

function undo() {
  const t = tip();
  if (t === tree.root || mode !== 'play') return;
  if (result) {
    setStatus('对局已结束，不能悔棋');
    return;
  }
  gameToken++;
  maiaThinking = false;
  let target: Node = t;
  do target = target.parent!;
  while (target.parent && turnOf(target.fen) !== userColor);
  coachReset();
  retried = null;
  target.children = [];
  node = target;
  if (clock) clock.set(target.clock ?? [clock.tc.base, clock.tc.base], performance.now());
  cg.cancelPremove();
  hintShapes = [];
  $('hint-box').textContent = '';
  saveGame();
  update();
  void maiaTurn();
  void coachTurn();
}

async function hint() {
  const t = tip();
  if (result !== '' || mode !== 'play') return;
  const box = $('hint-box');
  box.textContent = '思考中…';
  try {
    const s = await getSf();
    const r = await s.analyse(tree.root.fen, { moves: movesTo(t), movetime: settings.sfMovetime, multipv: 1 });
    if (t !== tip()) return;
    const best = r.bestmove;
    hintShapes = best ? [arrow(best, 'green')] : [];
    let text = best ? `Stockfish 推荐：${sanOf(t.fen, best)}（${r.lines[0] ? evalText(r.lines[0], turnOf(t.fen)) : ''}）` : '';
    if (!settings.lowMemory) {
      const h = await maiaEval(t);
      if (t !== tip()) return;
      const top = h.moves[0];
      if (top.uci !== best) hintShapes.push(arrow(top.uci, 'blue'));
      text += `\n${settings.elo} 分棋手最常走：` + h.moves.slice(0, 3).map((x) => `${sanOf(t.fen, x.uci)} ${(x.p * 100).toFixed(0)}%`).join('，');
    }
    box.textContent = text;
    cg.setAutoShapes(arrows());
  } catch (err) {
    box.textContent = '提示失败：' + (err as Error).message;
  }
}

function resign() {
  if (result !== '' || tip() === tree.root) return;
  endGame(userColor === 'w' ? '0-1' : '1-0', 'resign');
  update();
}

/** Maia accepts a draw when the game is not too young and it does not expect to win. */
async function offerDraw() {
  const t = tip();
  if (result || mode !== 'play') return;
  if (t.ply < 20) {
    setStatus('Maia 拒绝了和棋：对局还早');
    return;
  }
  if (t.ply - drawOfferPly < 6) {
    setStatus('刚提过和棋，过几步再试');
    return;
  }
  drawOfferPly = t.ply;
  setStatus('Maia 正在考虑和棋…');
  try {
    const [w, d, l] = (await maiaEval(t)).wdl;
    if (t !== tip() || result) return;
    const maiaToMove = turnOf(t.fen) !== userColor;
    const maiaScore = maiaToMove ? w + d / 2 : l + d / 2;
    if (maiaScore <= 0.55) {
      endGame('1/2-1/2', 'agreement');
      update();
      setStatus('Maia 接受了和棋');
    } else setStatus('Maia 拒绝了和棋');
  } catch (err) {
    setStatus('求和失败：' + (err as Error).message);
  }
}

// ---------- clock ----------

function clockShouldRun(): Color | null {
  if (!clock || result || screen !== 'game' || mode !== 'play' || coachState !== 'idle' || document.hidden) return null;
  const t = tip();
  // the clock starts after White's first move
  if (t === tree.root) return null;
  return turnOf(t.fen);
}

function syncClock() {
  if (!clock) return;
  const now = performance.now();
  const want = clockShouldRun();
  if (want) clock.run(want, now);
  else clock.stop(now);
}

function clockView(color: Color): { text: string; active: boolean; low: boolean } {
  const i = color === 'w' ? 0 : 1;
  let ms: number | null = null;
  if (mode === 'review' && node.clock) ms = node.clock[i];
  else if (clock) ms = clock.time(color, performance.now());
  if (ms === null) return { text: color === 'w' ? '白' : '黑', active: turnOf(node.fen) === color && !result, low: false };
  const active = clock ? clock.active === color : false;
  return { text: fmtClockShort(ms), active, low: ms < 20_000 && (active || mode === 'play') };
}

function renderClocks() {
  document.querySelectorAll<HTMLElement>('[data-clock]').forEach((el) => {
    const v = clockView(el.dataset.clock as Color);
    el.textContent = v.text;
    el.classList.toggle('active', v.active);
    el.classList.toggle('low', v.low);
  });
}

function tickClock() {
  if (!clock?.active) return;
  const now = performance.now();
  const f = clock.flagged(now);
  if (f) {
    flag(f);
    return;
  }
  if (!lowTimeWarned && clock.active === userColor && clock.time(userColor, now) < Math.min(10_000, clock.tc.base / 6)) {
    lowTimeWarned = true;
    play('lowtime');
  }
  renderClocks();
}

// ---------- review ----------

function posEvalFrom(n: Node, lines: SfLine[], best: string | null): PosEval {
  const c = chessOf(n);
  const turn = c.turn();
  if (c.isGameOver() || !lines[0]) {
    const white = c.isCheckmate() ? (turn === 'w' ? 0 : 100) : 50;
    return { lines: [], best: null, white, text: c.isCheckmate() ? '#' : '½' };
  }
  return { lines, best, white: whiteWinPct(lines[0], turn), text: evalText(lines[0], turn) };
}

async function evalNode(s: Stockfish, n: Node, signal: AbortSignal) {
  if (n.a.eval) return;
  const r = await s.analyse(tree.root.fen, { moves: movesTo(n), movetime: settings.sfMovetime, signal });
  if (signal.aborted) return;
  // no bestmove on a live position means the engine died mid-search; don't cache a fake "½"
  if (!r.bestmove && !chessOf(n).isGameOver()) return;
  n.a.eval = posEvalFrom(n, r.lines, r.bestmove);
}

/** Review mode runs automatically: whole-game analysis first, then live multi-PV on the current position. */
function startReview() {
  if (mode !== 'review' || screen !== 'game') return;
  liveOn = true;
  if (!batchCtrl || batchCtrl.signal.aborted) void analyseGame();
}

async function analyseGame() {
  batchCtrl?.abort();
  const ctrl = new AbortController();
  batchCtrl = ctrl;
  // the batch and live search share one Stockfish; live resumes when the batch ends
  liveCtrl?.abort();
  const bar = $('analyse-progress');
  bar.classList.remove('hidden');
  const fill = bar.firstElementChild as HTMLElement;
  const nodes = gameLine();
  const n = nodes.length;
  const sfShare = settings.lowMemory ? 50 : 70;
  try {
    const s = await getSf();
    for (let i = 0; i < n; i++) {
      if (ctrl.signal.aborted) return;
      await evalNode(s, nodes[i], ctrl.signal);
      fill.style.width = `${((i + 1) / n) * sfShare}%`;
      if (nodes[i] === node || i % 4 === 0) update();
    }
    // Stockfish needs every position (both sides of each judged move); Maia only where the judged side is to move
    const maiaNodes = nodes.slice(0, -1).filter(showSide);
    for (let i = 0; i < maiaNodes.length; i++) {
      if (ctrl.signal.aborted) return;
      await maiaEval(maiaNodes[i]);
      fill.style.width = `${sfShare + ((i + 1) / maiaNodes.length) * (100 - sfShare)}%`;
    }
    setStatus('分析完成');
  } catch (err) {
    console.error(err);
  } finally {
    if (batchCtrl === ctrl) {
      batchCtrl = null;
      bar.classList.add('hidden');
      void runLive();
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

/** Review of the move that led to `n`. */
function reviewOf(n: Node): MoveReview | null {
  const p = n.parent;
  const a = p?.a.eval;
  const b = n.a.eval;
  if (!p || !a || !b) return null;
  const white = turnOf(p.fen) === 'w';
  const before = white ? a.white : 100 - a.white;
  const after = white ? b.white : 100 - b.white;
  return { judgement: judge(before, after, n.uci === a.best), before, after, accuracy: moveAccuracy(before, after) };
}

function setLive(on: boolean) {
  liveOn = on;
  if (!on) {
    liveCtrl?.abort();
    liveLines = [];
  }
  void runLive();
}

async function runLive() {
  liveCtrl?.abort();
  liveLines = [];
  renderLines();
  if (!liveOn || mode !== 'review' || (batchCtrl && !batchCtrl.signal.aborted)) return;
  const ctrl = new AbortController();
  liveCtrl = ctrl;
  const n = node;
  try {
    const s = await getSf();
    if (ctrl.signal.aborted) return;
    await s.analyse(tree.root.fen, {
      moves: movesTo(n),
      movetime: 60000,
      multipv: 3,
      signal: ctrl.signal,
      onInfo: (lines) => {
        if (ctrl.signal.aborted || n !== node) return;
        liveLines = lines;
        renderLines();
        renderEvalBar();
        cg.setAutoShapes(arrows());
        renderLegend();
      },
    });
  } catch (err) {
    console.error(err);
  }
}

function renderLines() {
  const box = $('sf-lines');
  const lines = liveOn && liveLines.length ? liveLines : [];
  const turn = turnOf(node.fen);
  box.innerHTML = lines.map((l) => `<div><b>${evalText(l, turn)}</b> <small>d${l.depth}</small> ${pvToSan(node.fen, l.pv)}</div>`).join('');
}

function renderGraph() {
  const svg = $('graph');
  const nodes = gameLine();
  const n = nodes.length;
  const pts: string[] = [];
  const dots: string[] = [];
  for (let i = 0; i < n; i++) {
    const e = nodes[i].a.eval;
    if (!e) continue;
    const x = n > 1 ? (i / (n - 1)) * 100 : 0;
    const y = 40 - (e.white / 100) * 40;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    const r = showMove(nodes[i]) ? reviewOf(nodes[i]) : null;
    if (r && ['mistake', 'blunder', 'inaccuracy'].includes(r.judgement)) {
      dots.push(`<circle cx="${x}" cy="${y}" r="0.9" fill="${judgeColor(r.judgement)}"/>`);
    }
  }
  const cx = n > 1 ? (realOf(node).ply / (n - 1)) * 100 : 0;
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
  for (const n of gameLine()) {
    const r = showMove(n) ? reviewOf(n) : null;
    if (!r) continue;
    const s = stats[turnOf(n.parent!.fen)];
    s.acc.push(r.accuracy);
    s.c[r.judgement] = (s.c[r.judgement] ?? 0) + 1;
  }
  if (!stats.w.acc.length && !stats.b.acc.length) {
    box.innerHTML = '';
    return;
  }
  const row = (k: Color, name: string) => {
    const s = stats[k];
    if (!s.acc.length) return '';
    const avg = s.acc.reduce((a, b) => a + b, 0) / s.acc.length;
    const counts = (['inaccuracy', 'mistake', 'blunder'] as Judgement[])
      .map((j) => `<span class="cnt" title="${JUDGEMENT_INFO[j].label}">${judgeIcon(j)}${s.c[j] ?? 0}</span>`)
      .join('');
    return `<div class="sum-row"><b>${name}</b><span>准确率 ${avg.toFixed(1)}%</span>${counts}</div>`;
  };
  const who = (c: Color) => (imported ? (c === 'w' ? '白' : '黑') : `${c === 'w' ? '白' : '黑'}（${userColor === c ? '我' : 'Maia'}）`);
  box.innerHTML = row('w', who('w')) + row('b', who('b'));
}

function renderCoach() {
  const box = $('coach-box');
  const parts: string[] = [];
  const p = node.parent;
  if (p && (mode !== 'review' || showMove(node))) {
    const r = reviewOf(node);
    const prev = p.a.eval;
    const num = `${Number(p.fen.split(' ')[5])}${turnOf(p.fen) === 'w' ? '.' : '…'}`;
    if (r && prev) {
      const info = JUDGEMENT_INFO[r.judgement];
      parts.push(
        `<div class="j" style="color:${judgeColor(r.judgement)}">${judgeIcon(r.judgement)}${num} ${node.san} ${info.label}</div>`,
        `<div>行棋方胜率 ${r.before.toFixed(0)}% → ${r.after.toFixed(0)}%</div>`,
      );
      if (prev.best && prev.best !== node.uci) {
        parts.push(`<div>更好的是 <b>${sanOf(p.fen, prev.best)}</b>（${prev.text}）：${pvToSan(p.fen, prev.lines[0]?.pv ?? [])}</div>`);
      }
    }
    const h = p.a.human;
    if (h) {
      const played = h.moves.find((m) => m.uci === node.uci);
      parts.push(
        `<div class="human">${settings.elo} 分棋手在此常走：` +
          h.moves
            .slice(0, 3)
            .map((m) => `${sanOf(p.fen, m.uci)} ${(m.p * 100).toFixed(0)}%`)
            .join('，') +
          `；实战着法人类选择率 ${played ? (played.p * 100).toFixed(1) : '?'}%</div>`,
      );
    }
  }
  const e = node.a.eval;
  if (e && !node.children.length && e.best && showSide(node)) parts.push(`<div>当前最佳：<b>${sanOf(node.fen, e.best)}</b>（${e.text}）</div>`);
  if (node.comment) parts.push(`<div class="note">${escapeHtml(node.comment)}</div>`);
  if (!parts.length && mode === 'review') parts.push('<div class="muted">进入复盘会自动分析整局：Stockfish 逐步评估，Maia 告诉你同水平的人通常怎么走。在棋盘上走子是“试走”，不会改动对局记录，可随时“回到对局”。</div>');
  box.innerHTML = parts.join('');
}

function renderVarActions() {
  const box = $('var-actions');
  if (mode !== 'review' || node === tree.root || tree.isMainline(node)) {
    box.innerHTML = '';
    return;
  }
  if (node.x) {
    const at = realOf(node);
    const where = at === tree.root ? '开局' : `${at.san} 之后`;
    box.innerHTML = `<span class="muted">试走中（从 ${escapeHtml(where)}），不影响对局记录</span><button class="primary" data-va="back">回到对局</button><button data-va="del">删除试走</button>`;
    return;
  }
  box.innerHTML = '<span class="muted">变着</span><button data-va="back">回到主线</button><button data-va="main">设为主线</button><button data-va="del">删除变着</button>';
}

function varAction(act: string) {
  if (act === 'back') {
    // back to the game position where the exploration / variation branched off
    let v = node;
    while (v.parent && !tree.isMainline(v)) v = v.parent;
    goto(v);
    return;
  }
  if (act === 'main') tree.makeMainline(node);
  else if (act === 'del') {
    let v = node;
    if (v.x) while (v.parent?.x) v = v.parent;
    // remove the innermost variation that contains the current position
    else while (v.parent && v.parent.children[0] === v) v = v.parent;
    if (!v.parent) return;
    const back = v.parent;
    tree.remove(v);
    node = back;
  } else return;
  const end = terminalOf(fensTo(tip()));
  if (!imported && end && !result) ({ result, reason } = end);
  saveGame();
  update();
  if (liveOn) void runLive();
}

// ---------- coach ----------

const PIECE_NAME: Record<string, string> = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' };
const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PIECE_GLYPH: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };
const SEVERITY: Record<Judgement, number> = { best: 0, good: 0, inaccuracy: 1, mistake: 2, blunder: 3 };

let prepCtrl: AbortController | null = null;
let prep: { node: Node; p: Promise<void> } | null = null;
let coachNote = '';

function coachReset() {
  coachCtrl?.abort();
  prepCtrl?.abort();
  coachCtrl = null;
  prepCtrl = null;
  prep = null;
  coachState = 'idle';
  coachFrom = null;
  coachNote = '';
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

async function computeThreat(s: Stockfish, n: Node, signal: AbortSignal) {
  if (n.a.threat !== undefined) return;
  const nf = nullMoveFen(n.fen);
  const e = n.a.eval;
  if (!nf || !e) {
    n.a.threat = null;
    return;
  }
  const r = await s.analyse(nf, { movetime: Math.min(settings.sfMovetime, 600), signal });
  if (signal.aborted) return;
  const line = r.lines[0];
  if (!r.bestmove || !line) {
    n.a.threat = null;
    return;
  }
  const oppNow = turnOf(n.fen) === 'w' ? 100 - e.white : e.white;
  const oppThreat = line.mate !== undefined ? (line.mate > 0 ? 100 : 0) : winPct(line.cp ?? 0);
  if (oppThreat - oppNow < 12) {
    n.a.threat = null;
    return;
  }
  const mv = new Chess(nf).move(toMove(r.bestmove));
  let text = `对手威胁 <b>${mv.san}</b>`;
  if (line.mate !== undefined && line.mate > 0) text += `，${line.mate} 步杀`;
  else if (mv.captured) text += `，吃掉你的${PIECE_NAME[mv.captured]}`;
  n.a.threat = { uci: r.bestmove, text };
}

/** Pre-analyse the position on the user's turn (evaluation + opponent threat). */
function coachTurn() {
  const t = tip();
  if (!coachOn || screen !== 'game' || mode !== 'play' || result !== '' || coachState !== 'idle') return;
  if (turnOf(t.fen) !== userColor || prep?.node === t) return;
  prepCtrl?.abort();
  const ctrl = new AbortController();
  prepCtrl = ctrl;
  const p = (async () => {
    try {
      const s = await getSf();
      await evalNode(s, t, ctrl.signal);
      if (ctrl.signal.aborted) return;
      update();
      await computeThreat(s, t, ctrl.signal);
      if (!ctrl.signal.aborted) update();
    } catch (err) {
      console.error(err);
    }
  })();
  prep = { node: t, p };
}

/** After the user's move from `from`: judge it and pause the game if it was bad enough. */
async function coachCheck(from: Node) {
  coachCtrl?.abort();
  const ctrl = new AbortController();
  coachCtrl = ctrl;
  coachState = 'checking';
  coachFrom = from;
  coachNote = '';
  update();
  try {
    if (prep?.node === from) await prep.p;
    const s = await getSf();
    await evalNode(s, from, ctrl.signal);
    const mv = from.children[0];
    if (mv) await evalNode(s, mv, ctrl.signal);
    if (ctrl.signal.aborted) return;
    const r = mv ? reviewOf(mv) : null;
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
  const from = coachFrom;
  if (coachState !== 'paused' || !from || !from.children.length) return;
  gameToken++;
  maiaThinking = false;
  coachReset();
  retried = { from, nodes: from.children.splice(0) };
  node = from;
  if (clock && from.clock) clock.set(from.clock, performance.now());
  cg.cancelPremove();
  hintShapes = [];
  coachNote = '再想一想，找一步更好的棋。';
  $('hint-box').textContent = '';
  saveGame();
  update();
  coachTurn();
}

/** On entering the game: review an unjudged last user move before Maia replies. */
function resumeCoach() {
  const t = tip();
  if (coachOn && mode === 'play' && result === '' && coachState === 'idle' && t.parent && turnOf(t.fen) !== userColor && !reviewOf(t)) {
    void coachCheck(t.parent);
    return;
  }
  void maiaTurn();
  coachTurn();
}

function coachContinue() {
  coachState = 'idle';
  coachFrom = null;
  update();
  void maiaTurn();
}

/** User pieces that are attacked and either undefended or attacked by something cheaper. */
function hangingSquares(n: Node): Square[] {
  const c = chessOf(n);
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
  const t = tip();
  if (!coachOn || mode !== 'play' || node !== t || result !== '') return [];
  if (coachState === 'paused' && coachFrom) {
    const out: DrawShape[] = [];
    const bad = coachFrom.children[0];
    const ref = bad?.a.eval?.best;
    if (ref) out.push(arrow(ref, 'red'));
    const better = coachFrom.a.eval?.best;
    if (better && better !== bad?.uci) out.push({ ...arrow(better, 'green'), modifiers: { lineWidth: 8 } });
    return out;
  }
  if (coachState !== 'idle' || turnOf(t.fen) !== userColor) return [];
  const out: DrawShape[] = [];
  if (settings.coachBest && t.a.eval?.best) out.push(arrow(t.a.eval.best, 'green'));
  if (settings.coachThreats && t.a.threat) out.push(arrow(t.a.threat.uci, 'threat'));
  if (settings.coachHanging)
    for (const sq of hangingSquares(t))
      out.push({ orig: sq as Key, customSvg: { html: HANGING_GLOW }, below: true }, { orig: sq as Key, customSvg: { html: HANGING_BADGE } });
  return out;
}

function explainMistake(from: Node): string {
  const mv = from.children[0];
  const r = mv && reviewOf(mv);
  const before = from.a.eval;
  const after = mv?.a.eval;
  if (!mv || !r || !before || !after) return '';
  const info = JUDGEMENT_INFO[r.judgement];
  const num = from.fen.split(' ')[5];
  const parts = [
    `<div class="cc-head"><span class="cc-title" style="color:${info.color}">${num}${turnOf(from.fen) === 'w' ? '.' : '…'} ${mv.san}${info.symbol} ${info.label}</span>` +
      `<span class="cc-win">胜率 ${r.before.toFixed(0)}% → <b style="color:${info.color}">${r.after.toFixed(0)}%</b></span></div>`,
  ];
  if (after.best) {
    const reply = chessOf(mv).move(toMove(after.best));
    const l = after.lines[0];
    let why: string;
    if (l?.mate !== undefined && l.mate > 0) why = `对手有 ${l.mate} 步杀：${pvToSan(mv.fen, l.pv, 6)}`;
    else if (reply.captured) why = `对手可以 <b>${reply.san}</b> 吃掉你的${PIECE_NAME[reply.captured]}`;
    else why = `对手的最佳应对是 <b>${reply.san}</b>：${pvToSan(mv.fen, l?.pv ?? [], 6)}`;
    parts.push(`<div class="cc-why"><span class="tag bad">问题</span><span>${why}</span></div>`);
  }
  if (before.best && before.best !== mv.uci) {
    const good = chessOf(from).move(toMove(before.best));
    const l = before.lines[0];
    let why = '';
    if (l?.mate !== undefined && l.mate > 0) why = `，${l.mate} 步杀`;
    else if (good.captured) why = `，吃掉对方的${PIECE_NAME[good.captured]}`;
    else if (good.san.includes('+')) why = '，并将军';
    parts.push(
      `<div class="cc-why"><span class="tag good">更好</span><span><b>${good.san}</b>（${before.text}）${why}</span></div>`,
      `<div class="cc-pv">${pvToSan(from.fen, l?.pv ?? [], 5)}</div>`,
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
  const t = tip();
  if (coachState === 'checking') {
    box.innerHTML = '<div class="cl-row muted"><span class="dots"><i></i><i></i><i></i></span>教练正在看你这步…</div>';
    return;
  }
  if (coachState === 'paused' && coachFrom) {
    box.innerHTML =
      `<div class="coach-card">${explainMistake(coachFrom)}` +
      `<div class="cc-actions"><button class="primary" data-act="retry">重走这步</button><button data-act="go">继续对局</button></div></div>`;
    return;
  }
  const parts: string[] = [];
  if (coachNote) parts.push(`<div class="cl-row">${coachNote}</div>`);
  // most recent move made by the user
  let last: Node | null = t;
  while (last?.parent && turnOf(last.parent.fen) !== userColor) last = last.parent;
  const r = last?.parent && !coachNote ? reviewOf(last) : null;
  if (r && last) {
    const info = JUDGEMENT_INFO[r.judgement];
    const ok = SEVERITY[r.judgement] === 0;
    parts.push(`<div class="cl-row"><span class="tag" style="background:${info.color}">${ok ? '✓' : info.symbol}</span><span>${last.san} ${info.label}</span></div>`);
  }
  if (result === '' && node === t && turnOf(t.fen) === userColor) {
    if (settings.coachThreats && t.a.threat) parts.push(`<div class="cl-row warn"><span class="tag bad">!</span><span>${t.a.threat.text}</span></div>`);
    if (settings.coachHanging) {
      const h = hangingSquares(t);
      const c = chessOf(t);
      if (h.length) parts.push(`<div class="cl-row warn"><span class="tag bad">!</span><span>保护不足：${h.map((q) => PIECE_NAME[c.get(q)!.type] + q).join('、')}</span></div>`);
    }
    const e = t.a.eval;
    if (settings.coachBest && e?.best) parts.push(`<div class="cl-row"><span class="tag good">★</span><span>推荐 <b>${sanOf(t.fen, e.best)}</b>（${e.text}）</span></div>`);
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
  dlg.returnValue = '';
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
  const review = mode === 'review';
  let html = movesHtml(
    tree,
    node,
    (n) => {
      const r = !review || showMove(n) ? reviewOf(n) : null;
      if (!r) return null;
      const j = r.judgement;
      // like chess.com: icons only where they matter
      if (j === 'good') return null;
      return { symbol: '', color: j === 'best' ? undefined : judgeColor(j), icon: judgeIcon(j) };
    },
    review,
  );
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
    box.scrollTop = node === tree.root ? 0 : box.scrollHeight;
    box.scrollLeft = node === tree.root ? 0 : box.scrollWidth;
  }
}

/** Captured pieces (shown next to the capturer) and material lead for `color`. */
function material(n: Node, color: Color): { html: string; diff: number } {
  const count: Record<Color, Record<string, number>> = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of chessOf(n).board()) for (const sq of row) if (sq && sq.type !== 'k') count[sq.color][sq.type]++;
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
  const oppColor: Color = userColor === 'w' ? 'b' : 'w';
  const card = (who: 'me' | 'maia') => {
    const color = who === 'me' ? userColor : oppColor;
    const m = material(node, color);
    let name = who === 'me' ? '我' : model;
    let elo = `(${gameElo ?? settings.elo})`;
    if (imported) {
      name = escapeHtml((color === 'w' ? headers?.White : headers?.Black) || (color === 'w' ? '白方' : '黑方'));
      const e = color === 'w' ? headers?.WhiteElo : headers?.BlackElo;
      elo = e ? `(${escapeHtml(e)})` : '';
    }
    const avatar = who === 'me' && !imported ? '<div class="avatar me">♙</div>' : '<div class="avatar bot">♞</div>';
    const thinking = who === 'maia' && maiaThinking ? '<span class="dots"><i></i><i></i><i></i></span>' : '';
    const v = clockView(color);
    return (
      `${avatar}<div class="pinfo"><div class="pname">${name} <span class="elo">${elo}</span>${thinking}</div>` +
      `<div class="caps ${color === 'w' ? 'by-w' : 'by-b'}">${m.html}${m.diff > 0 ? `<span class="adv">+${m.diff}</span>` : ''}</div></div>` +
      `<div class="clock${v.active ? ' active' : ''}${v.low ? ' low' : ''}${clock || node.clock ? ' timed' : ''}" data-clock="${color}">${v.text}</div>`
    );
  };
  $('player-top').innerHTML = card(flipped ? 'me' : 'maia');
  $('player-bottom').innerHTML = card(flipped ? 'maia' : 'me');
}

function renderEvalBar() {
  const e = liveOn && liveLines[0] ? posEvalFrom(node, liveLines, liveLines[0].pv[0]) : node.a.eval;
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
  else if (node !== tip()) box.textContent = '正在查看历史局面';
  else box.textContent = turnOf(node.fen) === userColor ? (cg.state.premovable.current ? '轮到你走（已预走）' : '轮到你走') : '等待 Maia';
}

function update() {
  syncClock();
  renderBoard();
  renderMoves();
  renderPlayers();
  renderPlayInfo();
  renderEvalBar();
  renderGraph();
  renderSummary();
  renderCoach();
  renderVarActions();
  renderLegend();
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
  if (push && s === 'game' && location.hash !== '#game') history_.pushState(null, '', '#game');
  if (push && s === 'home' && location.hash === '#game') history_.back();
  $('home').classList.toggle('active', s === 'home');
  $('game').classList.toggle('active', s === 'game');
  if (s === 'home') {
    gameToken++;
    maiaThinking = false;
    prepCtrl?.abort();
    prep = null;
    if (coachState === 'checking') coachReset();
    setLive(false);
    syncClock();
    saveGame();
    renderHome();
  } else {
    requestAnimationFrame(() => {
      cg.redrawAll();
      update();
      resumeCoach();
      startReview();
    });
  }
}

const history_ = window.history;

function goto(n: Node | null | undefined) {
  if (!n || n === node) return;
  node = n;
  hintShapes = [];
  update();
  if (liveOn) void runLive();
}

function lastOfLine(): Node {
  const l = currentLine();
  return l[l.length - 1];
}

function setMode(m: 'play' | 'review') {
  mode = m;
  if (m === 'play' && !tree.isMainline(node)) node = tip();
  $('game').dataset.mode = m;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === m));
  $('tab-play').classList.toggle('hidden', m !== 'play');
  $('tab-review').classList.toggle('hidden', m !== 'review');
  cg.cancelPremove();
  if (m === 'play') {
    setLive(false);
    batchCtrl?.abort();
  } else if (coachState !== 'idle') coachReset();
  update();
  if (m === 'play') {
    void maiaTurn();
    coachTurn();
  } else startReview();
}

// ---------- settings dialog ----------

function openSettings() {
  const dlg = $<HTMLDialogElement>('dlg-settings');
  const f = dlg.querySelector('form')!;
  const el = (n: string) => f.elements.namedItem(n) as HTMLInputElement;
  const themeSel = $<HTMLSelectElement>('sound-theme');
  if (!themeSel.options.length)
    for (const [id, th] of Object.entries(SOUND_THEMES)) themeSel.add(new Option(th.label, id));
  themeSel.onchange = () => previewTheme(themeSel.value);
  const boardSel = $<HTMLSelectElement>('board-theme');
  const pieceSel = $<HTMLSelectElement>('piece-set');
  if (!boardSel.options.length) {
    for (const [id, th] of Object.entries(BOARD_THEMES)) boardSel.add(new Option(th.label, id));
    boardSel.add(new Option('自定义颜色…', 'custom'));
    for (const [id, label] of Object.entries(PIECE_SETS)) pieceSel.add(new Option(label, id));
  }
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
  let prevBoard = settings.boardTheme;
  boardSel.onchange = () => {
    // 切到自定义时，以刚才选中的预设颜色为起点
    if (boardSel.value === 'custom' && prevBoard !== 'custom') {
      const c = boardColors(prevBoard, '', '');
      el('customLight').value = c.light;
      el('customDark').value = c.dark;
    }
    prevBoard = boardSel.value;
    look();
  };
  let shownSet = '';
  const look = () => {
    $('look-custom').hidden = boardSel.value !== 'custom';
    const c = boardColors(boardSel.value, el('customLight').value, el('customDark').value);
    const pv = $('look-preview');
    pv.style.setProperty('--light-sq', c.light);
    pv.style.setProperty('--dark-sq', c.dark);
    // 只在棋子样式变化时重建预览，避免拖动滑块时反复重绘 SVG
    if (shownSet === pieceSel.value) return;
    shownSet = pieceSel.value;
    const pieces: [Color, string][] = [['b', 'r'], ['b', 'n'], ['b', 'b'], ['b', 'q'], ['b', 'k'], ['b', 'p'], ['w', 'p'], ['w', 'k'], ['w', 'q'], ['w', 'b'], ['w', 'n'], ['w', 'r']];
    pv.innerHTML = pieces.map(([col, r]) => `<span style="background-image:url('${pieceUrl(pieceSel.value, col, r)}')"></span>`).join('');
  };
  f.oninput = () => {
    outs();
    look();
  };
  outs();
  look();
  const sf = engines.sf;
  $('env-info').innerHTML =
    `跨源隔离：${self.crossOriginIsolated ? '✅（多线程可用）' : '❌（单线程）'}<br>` +
    `WebGPU：${'gpu' in navigator ? '✅' : '❌'}　CPU 核心：${navigator.hardwareConcurrency || '?'}<br>` +
    `Stockfish：${sf ? (sf.multiThreaded ? sf.threads + ' 线程' : '单线程') : '未加载'}　Maia：${engines.maia ? engines.maia.model : '未加载'}<br>` +
    `视口：${innerWidth}×${innerHeight}　屏幕：${window.screen.width}×${window.screen.height}${document.documentElement.classList.contains('letterbox') ? '（底部已补偿）' : ''}<br>` +
    `版本：${__APP_VERSION__}`;
  dlg.returnValue = '';
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
      sfLite: el('sfLite').checked,
      lowMemory: el('lowMemory').checked,
      sound: el('sound').checked,
      soundTheme: el('soundTheme').value,
      haptics: el('haptics').checked,
      boardTheme: el('boardTheme').value,
      customLight: el('customLight').value,
      customDark: el('customDark').value,
      pieceSet: el('pieceSet').value,
      premove: el('premove').checked,
      reviewOpponent: el('reviewOpponent').checked,
    };
    applySettings(old);
  };
  dlg.showModal();
}

function applySettings(old: Settings) {
  saveSettings(settings);
  configureSound(settings.sound, settings.haptics, settings.soundTheme);
  applyAppearance(settings.boardTheme, settings.customLight, settings.customDark, settings.pieceSet);
  if (old.sfThreads !== settings.sfThreads || old.sfHash !== settings.sfHash || old.sfLite !== settings.sfLite) engines.unloadSf();
  if (old.model !== settings.model || old.backend !== settings.backend) engines.unloadMaia();
  if (old.elo !== settings.elo || old.model !== settings.model || old.useHistory !== settings.useHistory) clearAnn('human');
  if (old.sfMovetime !== settings.sfMovetime || old.sfLite !== settings.sfLite) clearAnn('eval', 'threat');
  if (!settings.premove) cg.cancelPremove();
  if (old.reviewOpponent !== settings.reviewOpponent && mode === 'review' && screen === 'game') void analyseGame();
  update();
  renderHome();
}

// ---------- PGN ----------

const JUDGE_NAG: Partial<Record<Judgement, number>> = { inaccuracy: 6, mistake: 2, blunder: 4 };

function gameHeaders(): Record<string, string> {
  const d = new Date(gameDate);
  const p = (n: number) => String(n).padStart(2, '0');
  if (imported && headers) return { ...headers, Result: result || '*' };
  const elo = String(gameElo ?? settings.elo);
  const name = `Maia-3 ${gameModel}`;
  const h: Record<string, string> = {
    Event: coachOn ? 'Maia 教练对局' : 'Maia 对局',
    Site: 'Maia Coach',
    Date: `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`,
    White: userColor === 'w' ? '我' : name,
    Black: userColor === 'b' ? '我' : name,
    Result: result || '*',
  };
  h[userColor === 'w' ? 'BlackElo' : 'WhiteElo'] = elo;
  h.TimeControl = pgnTimeControl(clock?.tc ?? null);
  h.Termination = !result ? 'Unterminated' : reason === 'timeout' ? 'Time forfeit' : 'Normal';
  return h;
}

function annotate(n: Node): Annotation | undefined {
  const out: Annotation = {};
  const l = n.a.eval?.lines[0];
  if (l) {
    const sign = turnOf(n.fen) === 'w' ? 1 : -1;
    out.commands = [l.mate !== undefined ? `[%eval #${sign * l.mate}]` : `[%eval ${((sign * (l.cp ?? 0)) / 100).toFixed(2)}]`];
  }
  const r = showMove(n) ? reviewOf(n) : null;
  const nag = r && JUDGE_NAG[r.judgement];
  if (nag && !n.nags?.length) out.nags = [nag];
  return out;
}

function exportPgn(): string {
  return treeToPgn(tree, gameHeaders(), annotate);
}

interface Parsed {
  tree: GameTree<Ann>;
  headers: Record<string, string>;
  result: string;
}

function parseInput(text: string): Parsed | string {
  const t = text.trim();
  if (!t) return '内容为空';
  try {
    return { tree: new GameTree<Ann>(new Chess(t).fen()), headers: {}, result: '*' };
  } catch {
    /* not a FEN */
  }
  try {
    const p = parsePgn<Ann>(t);
    return { tree: p.tree, headers: p.headers, result: p.result };
  } catch (err) {
    return (err as Error).message;
  }
}

function loadImported(p: Parsed) {
  tree = p.tree;
  node = tree.root;
  gameId = newGameId();
  gameDate = Date.now();
  gameElo = undefined;
  userColor = 'w';
  result = p.result === '*' ? '' : p.result;
  reason = undefined;
  if (!result) {
    const end = terminalOf(fensTo(tip()));
    if (end) ({ result, reason } = end);
  }
  imported = true;
  headers = Object.keys(p.headers).length ? p.headers : undefined;
  coachOn = false;
  tcId = 'none';
  clock = null;
  flipped = false;
  resetTransient();
}

/** Starts a new game against Maia from `fen`; the user takes `color` (default: side to move). */
function playFrom(fens: string[], color?: Color) {
  const fen = fens[fens.length - 1];
  if (terminalOf(fens)) {
    setStatus('该局面对局已结束，无法继续对弈');
    return false;
  }
  newGame(fen, color ?? turnOf(fen));
  return true;
}

function openPgnImport() {
  const dlg = $<HTMLDialogElement>('dlg-pgn');
  const f = dlg.querySelector('form')!;
  dlg.returnValue = '';
  dlg.onclose = () => {
    const v = dlg.returnValue;
    if (v !== 'ok' && v !== 'play') return;
    const p = parseInput((f.elements.namedItem('pgn') as HTMLTextAreaElement).value);
    if (typeof p === 'string') {
      setStatus('无法解析 PGN/FEN：' + p);
      return;
    }
    gameToken++;
    maiaThinking = false;
    batchCtrl?.abort();
    if (v === 'play') {
      const side = (f.elements.namedItem('playAs') as HTMLSelectElement).value;
      const end = p.tree.mainline();
      if (playFrom(end.map((n) => n.fen), side === 'w' || side === 'b' ? side : undefined)) showScreen('game');
      return;
    }
    loadImported(p);
    saveGame();
    setMode('review');
    showScreen('game');
  };
  dlg.showModal();
}

// ---------- home ----------

let homeCg: Api;

function renderHome() {
  const elo = $<HTMLInputElement>('home-elo');
  elo.value = String(settings.elo);
  $('home-elo-val').textContent = String(settings.elo);
  document.querySelectorAll<HTMLButtonElement>('#home-color button').forEach((b) => b.classList.toggle('active', b.dataset.color === settings.color));
  document.querySelectorAll<HTMLButtonElement>('#home-type button').forEach((b) => b.classList.toggle('active', b.dataset.type === settings.gameType));
  $<HTMLSelectElement>('home-tc').value = settings.timeControl;
  $('home-coach-desc').textContent = settings.gameType === 'coach' ? '走出' + JUDGEMENT_INFO[settings.coachLevel].label + '时暂停讲解，可重走' : '无提示，自由对弈';
  const t = tip();
  const has = t !== tree.root;
  const btn = $<HTMLButtonElement>('btn-continue');
  btn.disabled = !has;
  $('continue-title').textContent = has && result === '' ? '继续对局' : '上一局';
  const tc = clock ? `${tcId} · ` : '';
  $('continue-sub').textContent = has ? `${coachOn ? '教练 · ' : ''}${tc}${Math.ceil(t.ply / 2)} 回合 · ${result || '进行中'}` : '暂无';
  const s = computeStats(history).all;
  $('history-sub').textContent = history.length ? `${history.length} 局${s.games ? ` · 得分 ${s.score.toFixed(0)}%` : ''}` : '暂无';
  homeCg?.set({ fen: t.fen, orientation: userColor === 'w' ? 'white' : 'black', lastMove: undefined });
}

function saveHomeSettings(patch: Partial<Settings>) {
  const old = settings;
  settings = { ...settings, ...patch };
  applySettings(old);
}

function showHistory(tab: 'list' | 'stats' = 'list') {
  openHistory(
    {
      games: () => history,
      open: (g) => {
        if (result === '' && tip() !== tree.root && !imported && g.id !== gameId && !confirm('当前对局还没下完，打开记录会替换它。继续吗？')) return;
        gameToken++;
        maiaThinking = false;
        batchCtrl?.abort();
        if (!loadGame(g)) {
          setStatus('无法打开这局记录');
          return;
        }
        flipped = false;
        node = tree.root;
        saveGame();
        setMode('review');
        showScreen('game');
      },
      remove: (id) => {
        history = history.filter((x) => x.id !== id);
        saveHistory(history);
        renderHome();
      },
      clear: () => {
        history = [];
        saveHistory(history);
        renderHome();
      },
    },
    tab,
  );
}

// ---------- init ----------

function bind() {
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((b) => {
    b.onclick = () => {
      const nav = b.dataset.nav;
      goto(nav === 'first' ? tree.root : nav === 'prev' ? node.parent : nav === 'next' ? mainChild(node) : lastOfLine());
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
      if (e.target === d && d.id !== 'dlg-promo' && d.id !== 'dlg-update') d.close();
    });
  });
  const menu = $<HTMLDialogElement>('dlg-menu');
  const fromMenu = (fn: () => void) => () => {
    menu.close();
    fn();
  };

  const tcSel = $<HTMLSelectElement>('home-tc');
  tcSel.innerHTML = TIME_CONTROLS.map((t) => `<option value="${t.id}">${t.label}</option>`).join('');
  tcSel.onchange = () => saveHomeSettings({ timeControl: tcSel.value });

  $('btn-play').onclick = () => {
    unlockAudio();
    newGame();
    showScreen('game');
  };
  $('btn-continue').onclick = () => {
    setMode(result === '' && !imported ? 'play' : 'review');
    showScreen('game');
  };
  $('btn-home-import').onclick = openPgnImport;
  $('btn-history').onclick = () => showHistory('list');
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
  $('var-actions').onclick = (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-va]')?.dataset.va;
    if (act) varAction(act);
  };
  $('btn-back').onclick = () => showScreen('home');
  $('btn-flip').onclick = () => {
    flipped = !flipped;
    update();
  };
  $('btn-menu-top').onclick = () => $('btn-menu').click();
  $('btn-menu').onclick = () => {
    const live = mode === 'play' && result === '' && !imported && tip() !== tree.root;
    $<HTMLButtonElement>('btn-resign').disabled = !live;
    $<HTMLButtonElement>('btn-draw').disabled = !live;
    menu.showModal();
  };
  $('btn-new').onclick = fromMenu(() => newGame());
  $('btn-resign').onclick = fromMenu(() => {
    if (result === '' && confirm('确定认输？')) resign();
  });
  $('btn-draw').onclick = fromMenu(() => void offerDraw());
  $('btn-play-here').onclick = fromMenu(() => {
    if (result === '' && !imported && tip() !== tree.root && mode === 'play' && !confirm('从当前局面开始新对局？当前对局会被替换。')) return;
    playFrom(fensTo(node));
  });
  $('btn-menu-history').onclick = fromMenu(() => showHistory('list'));
  $('btn-menu-settings').onclick = fromMenu(openSettings);
  $('btn-undo').onclick = undo;
  $('btn-hint').onclick = () => void hint();
  $('btn-settings').onclick = openSettings;
  $('btn-engines').onclick = () => openEngines(enginesCtx);
  $('btn-result-review').onclick = () => {
    $<HTMLDialogElement>('dlg-result').close();
    node = tree.root;
    setMode('review');
  };
  $('btn-result-new').onclick = () => {
    $<HTMLDialogElement>('dlg-result').close();
    newGame();
  };
  $('moves').onclick = (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('.mv')?.dataset.id;
    if (id) goto(findNode(tree, Number(id)));
  };
  $('graph').onclick = (e) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const l = currentLine();
    goto(l[Math.round(((e.clientX - rect.left) / rect.width) * (l.length - 1))]);
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
  const updateDlg = $<HTMLDialogElement>('dlg-update');
  // 强制弹窗：禁止 Esc 关闭，被意外关闭时重新弹出
  updateDlg.addEventListener('cancel', (e) => e.preventDefault());
  updateDlg.addEventListener('close', () => updateDlg.showModal());
  const reloadForUpdate = (e: Event) => {
    e.preventDefault();
    saveGame();
    location.reload();
  };
  const reloadBtn = $('btn-update-reload');
  reloadBtn.addEventListener('click', reloadForUpdate);
  // iOS 上 click 偶尔不触发，用 touchend 兜底
  reloadBtn.addEventListener('touchend', reloadForUpdate);
  document.addEventListener('keydown', (e) => {
    if (screen !== 'game' || (e.target as HTMLElement).closest('dialog')) return;
    if (e.key === 'ArrowLeft') goto(node.parent);
    else if (e.key === 'ArrowRight') goto(mainChild(node));
    else if (e.key === 'Home') goto(tree.root);
    else if (e.key === 'End') goto(lastOfLine());
  });
  // 对话框里点击包着下拉框/滑块的标签文字时不要激活控件（iOS 会直接弹出选择器）
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const lab = t.closest('dialog label:not(.check)');
    if (lab && !t.closest('input, select, textarea, button')) e.preventDefault();
  });
  // iOS only allows audio after a user gesture
  document.addEventListener('pointerdown', () => unlockAudio(), { once: true, capture: true });
  document.addEventListener('visibilitychange', () => {
    syncClock();
    renderClocks();
    if (document.hidden) saveGame();
  });
  window.addEventListener('pagehide', () => saveGame());
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  // a new deployment's SW took over: the running page is the old version
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    const dlg = $<HTMLDialogElement>('dlg-update');
    if (!dlg.open) dlg.showModal();
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    // first visit: reload once so the SW can add COOP/COEP headers (enables multi-threading)
    if (!self.crossOriginIsolated && !sessionStorage.getItem('coi-reloaded')) {
      navigator.serviceWorker.ready.then(() => {
        sessionStorage.setItem('coi-reloaded', '1');
        location.reload();
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
  });
}

/**
 * iOS 主屏幕 App（standalone）在部分系统版本上，网页视口比屏幕短一截（WebKit bug 313800），
 * 底部那条区域网页无法布局，Home 指示条就落在其中。此时：
 * - 不再额外预留 safe-area-inset-bottom（否则会在视口内再空出一截）；
 * - 把 html 背景设为工具栏颜色，让那条区域与工具栏连成一体。
 */
function fitStandalone() {
  const standalone = (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (!standalone) return;
  const root = document.documentElement;
  root.classList.add('standalone');
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(probe);
  const fit = () => {
    const { width: w, height: h } = window.screen;
    const landscape = innerWidth > innerHeight;
    const sw = landscape ? Math.max(w, h) : Math.min(w, h);
    const sh = landscape ? Math.min(w, h) : Math.max(w, h);
    const gap = Math.abs(innerWidth - sw) <= 1 ? sh - innerHeight : 0;
    const safeB = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
    root.classList.toggle('letterbox', gap > 8 && safeB > 0);
  };
  fit();
  addEventListener('resize', fit);
  addEventListener('orientationchange', () => setTimeout(fit, 300));
}

function init() {
  fitStandalone();
  configureSound(settings.sound, settings.haptics, settings.soundTheme);
  applyAppearance(settings.boardTheme, settings.customLight, settings.customDark, settings.pieceSet);
  cg = Chessground($('board'), {
    animation: { duration: 180 },
    ranksPosition: 'left',
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: (o, d, meta) => void onUserMove(o, d, meta) } },
    premovable: { enabled: false, showDests: true, events: { set: () => renderPlayInfo(), unset: () => renderPlayInfo() } },
    drawable: { enabled: true, brushes: { ...BRUSHES } as unknown as DrawBrushes },
  });
  homeCg = Chessground($('home-board'), { viewOnly: true, coordinates: false, animation: { enabled: false } });
  // chessground caches the board rect and only refreshes it on scroll/resize; layout shifts without a
  // size change (e.g. the screen slide-in transition) leave it stale and taps land on the wrong square
  const freshBounds = () => cg.state.dom.bounds.clear();
  for (const ev of ['touchstart', 'mousedown']) $('board').addEventListener(ev, freshBounds, { capture: true, passive: true });
  bind();
  const saved = localStorage.getItem(GAME_KEY);
  let ok = false;
  try {
    ok = Boolean(saved) && loadGame(JSON.parse(saved!) as StoredGame | LegacyGame);
  } catch {
    ok = false;
  }
  if (!ok) userColor = settings.color === 'b' ? 'b' : 'w';
  setMode(result === '' && !imported ? 'play' : 'review');
  renderHome();
  setInterval(tickClock, 100);
  // 系统返回键/手势回到主页
  window.addEventListener('popstate', () => {
    if (screen === 'game' && location.hash !== '#game') showScreen('home', false);
    else if (screen === 'home' && location.hash === '#game') showScreen('game', false);
  });
  if (location.hash === '#game') showScreen('game', false);
  setStatus(self.crossOriginIsolated ? '就绪（多线程）' : '就绪（单线程模式）');

  const willReload = import.meta.env.PROD && 'serviceWorker' in navigator && !self.crossOriginIsolated && !sessionStorage.getItem('coi-reloaded');
  const idle = (cb: () => void) => ('requestIdleCallback' in self ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1500));
  if (!willReload) {
    idle(async () => {
      // download first so warmup reads from the local cache instead of fetching the same files twice
      if (settings.autoOffline && import.meta.env.PROD) await autoOffline(enginesCtx).catch(() => false);
      if (settings.warmup) void engines.warmup();
    });
  }
  registerServiceWorker();
}

init();
