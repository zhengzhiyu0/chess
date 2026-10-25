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
import { flushEvals, getEval, putEval } from './engine/eval-cache';
import { classify, evalText, JUDGEMENTS, JUDGEMENT_INFO, moveAccuracy, SEVERITY, whiteWinPct, winPct, type Judgement } from './coach/coach';
import { bookReady, inBook, loadBook } from './coach/book';
import { PIECE_NAME, confirmedMotifs, explainMove, hangingSquares as hangingOf, isSacrifice, plainEval, type MoveInsight, type Sides } from './coach/explain';
import { ELO_MAX, ELO_MIN, isIOS, loadSettings, saveSettings, type Settings } from './settings';
import { assistCount, computeRating, emptyAssists, ratingBreakdown, type Assists, type RatingInfo } from './game/rating';
import { onStorageFull, readJson, safeSet } from './storage';
import { addMistakes, loadMistakes, mistakeStats, setDeletedMistakes, setMistakes, type Mistake } from './training/mistakes';
import { loadProgress, setProgress, THEME_LABEL } from './training/puzzles';
import { themesForTag } from './training/recommend';
import { backupFileName, makeBackup, mergeBackup, parseBackup, pickFile, shareFile, type BackupData } from './backup';
import { bindTrainer, notebookSummary, openMistake, openNotebook, openPuzzles, openPuzzlesForTheme, puzzleSummary, trainerRedraw, type TrainerCtx } from './app/trainer-ui';
import { mistakeTag } from './coach/explain';
import { isNative, thermalState } from './native';
import { GameTree, mainChild, type GNode } from './game/tree';
import { END_REASON_TEXT, START_FEN, moveNumberOf, pvToSan, sanOf, terminalOf, timeoutResult, toMove, turnOf, type Color, type EndReason } from './game/rules';
import { exportPgn as treeToPgn, parsePgn, splitPgn, type Annotation } from './game/pgn';
import { ChessClock, TIME_CONTROLS, fmtClockShort, pgnTimeControl, thinkBudget, timeControlOf } from './game/clock';
import { computeStats, loadHistory, newGameId, sanitizeGame, saveHistory, upsert, type StoredGame } from './game/history';
import { dragHaptics, installTapHaptics } from './audio/haptics';
import { SOUND_THEMES, configureSound, play, previewTheme, soundForSan, unlockAudio, type EndKind } from './audio/sound';
import { $, escapeHtml, setStatus } from './app/dom';
import { BOARD_THEMES, PIECE_SETS, applyAppearance, boardColors, pieceUrl } from './app/appearance';
import { Engines } from './app/engines';
import { autoOffline, openEngines, type EnginesCtx } from './app/engines-ui';
import { AVATAR_PRESETS, avatarFromFile, avatarHtml, coachAvatarHtml } from './app/avatar';
import { COACHES } from './app/coach-avatars';
import { findNode, movesHtml } from './app/moves-ui';
import { HANGING_BADGE, HANGING_GLOW, judgeBoardSvg, judgeColor, judgeIcon } from './app/judge-icon';
import { BoardFx, moveFxOf, type MoveFx } from './app/fx';
import { DodgeFx } from './app/dodge';
import { openHistory } from './app/history-ui';
import { opponentTalk, OPPONENT_PERSONALITIES, type OpponentPersonality } from './opponent';

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
  /** finished review live (multi-PV) search, so revisiting a position doesn't search it again */
  live: SfLine[];
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

function resetAnalysisStatus() {
  analysisStatus = 'idle';
  analysisError = '';
  analysisDone = 0;
  analysisTotal = 0;
}

function isLegacy(v: unknown): v is LegacyGame {
  const g = v as LegacyGame;
  return Boolean(v) && typeof v === 'object' && !('tree' in g) && typeof g.startFen === 'string' && Array.isArray(g.moves) && g.moves.every((m) => typeof m === 'string') && (g.userColor === 'w' || g.userColor === 'b');
}

let settings: Settings = loadSettings();
let tree = new GameTree<Ann>(START_FEN);
let node: Node = tree.root;
let gameId = newGameId();
let gameDate = Date.now();
let gameElo: number | undefined = settings.elo;
let eloAfter: number | undefined;
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
/** Maia gave up after its retries: its clock stops until the user asks for another try */
let maiaFailed = false;
/** most user moves the current game ever had, so taking moves back can't dodge "leaving counts as a loss" */
let peakUserMoves = 0;
let hintShapes: DrawShape[] = [];
let liveOn = false;
let liveCtrl: AbortController | null = null;
let liveLines: SfLine[] = [];
let batchCtrl: AbortController | null = null;
/** whole-game analysis interrupted by the app going to the background, resumed on return */
let pausedBatch = false;
type AnalysisStatus = 'idle' | 'running' | 'complete' | 'interrupted' | 'failed';
/** Whole-game review status; summaries are only final once this is complete. */
let analysisStatus: AnalysisStatus = 'idle';
let analysisError = '';
let analysisDone = 0;
let analysisTotal = 0;
let screen: 'home' | 'game' | 'train' = 'home';
type HomeTab = 'play' | 'train' | 'data';
let homeTab: HomeTab = 'play';
let opponentLine = '';
let lastOpponentLine = '';
let opponentTalkSeed = 0;
let shownResult = '';
let coachOn = false;
let coachState: 'idle' | 'checking' | 'paused' = 'idle';
let coachCtrl: AbortController | null = null;
/** position before the user's move that the coach is judging */
let coachFrom: Node | null = null;
/** The answer stays hidden until the player explicitly asks to reveal it. */
let coachReveal = false;
/** moves taken back with "重走这步", re-attached as variations once a different move is played */
let retried: { from: Node; nodes: Node[] } | null = null;
let history: StoredGame[] = loadHistory();
/** help used in the current game */
let assists: Assists = emptyAssists();
/** how the rating change of the current (finished) game was computed */
let rating: RatingInfo | undefined;
/** the current game is over but its rating waits for the analysis of the game */
let ratePending = false;
let abandoned = false;

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
  warmup: () => engines.warmup().catch(() => {}),
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
    eloAfter,
    model: imported ? undefined : gameModel,
    tc: tcId,
    clock: clock && !result ? clock.snapshot(performance.now()) : undefined,
    headers,
    imported: imported || undefined,
    assists: assistCount(assists) ? assists : undefined,
    rating,
    abandoned: abandoned || undefined,
    ratePending: ratePending || undefined,
  };
}

function saveGame() {
  const g = stored();
  peakUserMoves = Math.max(peakUserMoves, userMovesOf().length);
  safeSet(GAME_KEY, JSON.stringify({ ...g, peak: peakUserMoves }));
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
  hintedAt = null;
  opponentLine = '';
  lastOpponentLine = '';
  opponentTalkSeed = 0;
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
    eloAfter = g.eloAfter;
    gameModel = g.model ?? settings.model;
    assists = g.assists ? { ...g.assists } : emptyAssists();
    rating = g.rating;
    // Older saved games may have a pending rating from before coach games were
    // excluded. Never apply that pending adjustment when reopening a coach game.
    ratePending = Boolean(g.ratePending) && !coachOn;
    abandoned = Boolean(g.abandoned);
    const peak = (raw as { peak?: unknown }).peak;
    peakUserMoves = Math.max(typeof peak === 'number' ? peak : 0, userMovesOf().length);
    maiaFailed = false;
    tcId = g.tc ?? 'none';
    const tc = timeControlOf(tcId);
    clock = tc ? new ChessClock(tc, g.clock ?? node.clock) : null;
    resetAnalysisStatus();
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

/** Arrow brushes for review: green = engine best, blue = what players at your rating usually play, amber = what the previous (bad) move should have been. */
const BRUSHES = {
  best: { key: 'kb', color: '#5fa83f', opacity: 0.85, lineWidth: 7 },
  human: { key: 'kh', color: '#3b82d6', opacity: 0.8, lineWidth: 5 },
  /** after a bad move: what should have been played in the previous position */
  should: { key: 'ks', color: '#d9a43a', opacity: 0.75, lineWidth: 6 },
  /** opponent's threat (coach) */
  threat: { key: 'kt', color: '#e8402f', opacity: 0.75, lineWidth: 6 },
  /** next move while stepping through a line */
  demo: { key: 'kd', color: '#8a5cd6', opacity: 0.8, lineWidth: 7 },
};
const LEGEND_TEXT: Record<string, string> = { best: '最佳', human: '常见', should: '上一步应走' };

interface ReviewArrow {
  uci: string;
  kind: keyof typeof BRUSHES;
  text: string;
}

/** Whether the move leading to `n` is judged in review (by default only the user's own moves; both sides in tried-out lines). */
function showMove(n: Node): boolean {
  return Boolean(n.parent) && (settings.reviewOpponent || imported || Boolean(n.x) || turnOf(n.parent!.fen) === userColor);
}

/** Whether suggestions for the side to move in `n` are shown; in a tried-out line always, e.g. how the opponent should answer. */
const showSide = (n: Node) => settings.reviewOpponent || imported || Boolean(n.x) || turnOf(n.fen) === userColor;

/** Review arrows: after a bad move, the move that should have been played; plus the best (and typical human) move for the side to move now. */
function reviewArrows(): ReviewArrow[] {
  const out: ReviewArrow[] = [];
  const p = node.parent;
  const r = p && showMove(node) ? reviewOf(node) : null;
  if (p && r && SEVERITY[r.judgement] > 0 && p.a.eval?.best) {
    out.push({ uci: p.a.eval.best, kind: 'should', text: `上一步应走 ${sanOf(p.fen, p.a.eval.best)}` });
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

/** Redraws the arrows for the current position; a running demo owns the board and keeps its own. */
function refreshShapes() {
  if (!demo) cg.setAutoShapes(arrows());
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
  const df = demoFen();
  if (df && demo) {
    const last = demo.idx > 0 ? demo.pv[demo.idx - 1] : null;
    const next = demo.pv[demo.idx];
    cg.set({
      fen: df,
      turnColor: turnOf(df) === 'w' ? 'white' : 'black',
      lastMove: last ? [last.slice(0, 2) as Key, last.slice(2, 4) as Key] : undefined,
      check: new Chess(df).inCheck(),
      movable: { color: undefined, dests: new Map() },
      premovable: { enabled: false },
    });
    cg.setAutoShapes(next ? [arrow(next, 'demo')] : []);
    return;
  }
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
  moveFx();
}

// ---------- board effects & autoplay ----------

let fx: BoardFx;
let dodge: DodgeFx;
let fxLast: Node | null = null;

function applyFx() {
  fx.enabled = settings.boardFx;
  fx.badgeEnabled = settings.boardFxBadge;
  fx.captureEnabled = settings.boardFxCapture;
  fx.checkEnabled = settings.boardFxCheck;
  fx.mateEnabled = settings.boardFxMate;
  fx.arrowStyle = settings.boardFxArrowStyle;
  dodge.enabled = settings.boardFx;
  const wrap = $('board').parentElement!;
  wrap.classList.toggle('fx-on', settings.boardFx);
  wrap.classList.toggle('fx-badge-on', settings.boardFx && settings.boardFxBadge);
  wrap.classList.toggle('fx-check-on', settings.boardFx && settings.boardFxCheck);
  if (!settings.boardFx) fx.clear();
}

/** Fires move effects when the shown position advanced by exactly one move; any other jump cancels them. */
function moveFx() {
  if (node === fxLast) return;
  const prev = fxLast;
  fxLast = node;
  if (!prev || node.parent !== prev || !node.uci) {
    fx.clear();
    return;
  }
  const r = mode === 'review' && showMove(node) ? reviewOf(node) : null;
  const m = moveFxOf(prev.fen, node.uci, r?.judgement);
  if (m) playFx(m);
}

/** Starts move effects right after the board has been set; the rook flight replaces chessground's rook slide. */
function playFx(m: MoveFx) {
  if (m.rook && fx.enabled) {
    cg.state.animation.current?.plan.anims.delete(m.rook.to as Key);
    // render synchronously so the rook element is already keyed to its new square for the flight
    cg.state.dom.redrawNow(true);
  }
  fx.move(m);
}

let autoTimer = 0;
/** true while an autoplay step is moving the board (autoTimer is momentarily 0 then) */
let autoStepping = false;

function autoplayOn() {
  return autoTimer !== 0 || autoStepping;
}

function stopAutoplay() {
  if (!autoTimer) return;
  clearTimeout(autoTimer);
  autoTimer = 0;
  renderAutoplay();
  if (liveOn) void runLive();
}

function autoplayEnd() {
  renderAutoplay();
  if (liveOn) void runLive();
}

function autoplayStep() {
  autoTimer = 0;
  if (mode !== 'review' || screen !== 'game' || document.hidden) return autoplayEnd();
  if (demo) {
    if (demo.idx >= demo.pv.length) return autoplayEnd();
    stepDemo(1);
  } else {
    const next = mainChild(node);
    if (!next) return autoplayEnd();
    autoStepping = true;
    try {
      goto(next, true);
    } finally {
      autoStepping = false;
    }
    play(soundForSan(next.san));
  }
  autoTimer = window.setTimeout(autoplayStep, settings.autoplayMs);
  renderAutoplay();
}

function toggleAutoplay() {
  if (autoplayOn()) return stopAutoplay();
  unlockAudio();
  if (demo ? demo.idx >= demo.pv.length : !mainChild(node)) {
    if (demo) stepDemo(-99);
    else goto(tree.root, true);
  }
  autoTimer = window.setTimeout(autoplayStep, 350);
  liveCtrl?.abort();
  renderAutoplay();
}

function renderAutoplay() {
  const btn = $('btn-autoplay');
  const on = autoplayOn();
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-label', on ? '暂停' : '自动播放');
  btn.innerHTML = on
    ? '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
  $<HTMLSelectElement>('autoplay-speed').value = String(settings.autoplayMs);
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
    // coach overlays shown while the move was chosen count as help
    if (coachOn) {
      if (settings.coachThreats || settings.coachHanging) assists.aids = true;
      if (settings.coachBest) assists.best = true;
    }
    if (result) return;
    if (coachOn) void coachCheck(tip().parent!);
    else void maiaTurn();
    return;
  }
  // review: explore freely; explorations never change the game record
  stopAutoplay();
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

function clearOpponentLine() {
  opponentLine = '';
}

function opponentSpeak(n: Node) {
  if (!settings.opponentTalk || coachOn || imported || mode !== 'play' || !n.parent) return;
  const parent = n.parent;
  const userMove = parent.parent && turnOf(parent.parent.fen) === userColor ? parent : undefined;
  const beforeUser = userMove?.parent;
  const beforeMaterial = beforeUser ? material(beforeUser, userColor).diff : undefined;
  const afterMaterial = userMove ? material(userMove, userColor).diff : undefined;
  let userCaptured: string | undefined;
  let userCapturedValue = 0;
  if (userMove?.uci && userMove.parent) {
    try {
      const captured = chessOf(userMove.parent).move(toMove(userMove.uci)).captured;
      if (captured) {
        userCaptured = PIECE_NAME[captured];
        userCapturedValue = PIECE_VALUE[captured] ?? 0;
      }
    } catch {
      /* an invalid/stale annotation should not prevent a reply */
    }
  }
  const c = chessOf(parent);
  let captured: string | undefined;
  if (n.uci) {
    try {
      const m = c.move(toMove(n.uci));
      captured = m.captured ? PIECE_NAME[m.captured] : undefined;
    } catch {
      /* an already finished position has no legal move to inspect */
    }
  }
  const personality = settings.opponentPersonality as OpponentPersonality;
  opponentLine = opponentTalk(
    personality,
    {
      userSan: userMove?.san,
      opponentSan: n.san,
      captured,
      userCaptured,
      userCapturedValue,
      userMaterialSwing: beforeMaterial === undefined || afterMaterial === undefined ? undefined : afterMaterial - beforeMaterial,
      opening: parent === tree.root,
    },
    opponentTalkSeed++,
    lastOpponentLine,
  );
  lastOpponentLine = opponentLine;
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
  if (mover === userColor) clearOpponentLine();
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
  // imported/review games have no "me": treat any decisive end as neutral
  const end: EndKind = res === '1/2-1/2' || imported ? 'draw' : (res === '1-0') === (userColor === 'w') ? 'win' : 'loss';
  setTimeout(() => play('end', end), 250);
  startRating();
  collectMistakes();
  saveGame();
}

const userMovesOf = (): Node[] => {
  const out: Node[] = [];
  for (let n = mainChild(tree.root); n; n = mainChild(n)) if (n.parent && turnOf(n.parent.fen) === userColor) out.push(n);
  return out;
};

const MISTAKE_J = new Set<Judgement>(['mistake', 'miss', 'blunder']);

/** Puts the user's analysed mistakes and blunders of this game into the notebook. */
function collectMistakes() {
  if (imported) return;
  const found: Mistake[] = [];
  for (const n of userMovesOf()) {
    const p = n.parent!;
    const r = reviewOf(n);
    const best = p.a.eval?.best;
    if (!r || !best || !MISTAKE_J.has(r.judgement) || best === n.uci) continue;
    const tag = mistakeTag({ fen: p.fen, uci: n.uci, best, bestLine: p.a.eval!.lines[0], replyLine: n.a.eval?.lines[0] });
    found.push({
      id: `${gameId}:${n.ply}`,
      gameId,
      date: gameDate,
      fen: p.fen,
      played: n.uci,
      playedSan: n.san,
      best,
      line: (p.a.eval!.lines[0]?.pv[0] === best ? p.a.eval!.lines[0].pv : [best]).slice(0, 12),
      judgement: r.judgement as Mistake['judgement'],
      drop: Math.round(r.before - r.after),
      tag: tag.id,
      tagLabel: tag.label,
      streak: 0,
      due: Date.now(),
      tries: 0,
      solved: 0,
    });
  }
  const added = found.length ? addMistakes(found) : 0;
  if (added) setStatus(`${added} 步错着已收进错题本`);
}

/** Automatic rating applies only to formal games from the standard start in which the user moved (or resigned). */
function ratingEnabled(): boolean {
  // Coach games are training sessions: hints, retries and explanations make their
  // results incomparable with a normal game, so they must never change Elo.
  return !coachOn && settings.autoElo && !imported && gameElo !== undefined && tree.root.fen === START_FEN;
}

function rateable(): boolean {
  if (!ratingEnabled()) return false;
  return Math.max(peakUserMoves, userMovesOf().length) >= 1 || reason === 'resign';
}

let rateCtrl: AbortController | null = null;

/** Average accuracy of the user's moves, from the review evals or a quick dedicated search. */
async function gameAccuracy(signal: AbortSignal): Promise<number | undefined> {
  const moves = userMovesOf();
  if (moves.length < 3) return undefined;
  const need = new Set<Node>();
  for (const n of moves) for (const x of [n.parent!, n]) if (!x.a.eval) need.add(x);
  const white = new Map<Node, number>();
  if (need.size) {
    const s = await getSf();
    for (const x of need) {
      if (signal.aborted) return undefined;
      const r = await s.analyse(tree.root.fen, { moves: movesTo(x), movetime: 250, depth: 14, signal });
      if (signal.aborted) return undefined;
      white.set(x, posEvalFrom(x, r.lines, r.bestmove).white);
    }
  }
  const w = (x: Node) => x.a.eval?.white ?? white.get(x) ?? 50;
  const accs = moves.map((n) => {
    const me = userColor === 'w';
    const before = me ? w(n.parent!) : 100 - w(n.parent!);
    const after = me ? w(n) : 100 - w(n);
    return moveAccuracy(before, after);
  });
  return accs.reduce((a, b) => a + b, 0) / accs.length;
}

function startRating() {
  rateCtrl?.abort();
  eloAfter = undefined;
  rating = undefined;
  ratePending = rateable();
  if (!ratePending) return;
  if (abandoned) {
    applyRating(undefined);
    return;
  }
  const ctrl = new AbortController();
  rateCtrl = ctrl;
  const id = gameId;
  void gameAccuracy(ctrl.signal)
    .catch((err) => {
      console.warn('评估本局表现失败', err);
      return undefined;
    })
    .then((acc) => {
      if (id !== gameId || !ratePending) return;
      applyRating(acc);
    });
}

function applyRating(accuracy: number | undefined) {
  if (!ratePending) return;
  ratePending = false;
  rateCtrl = null;
  const score = result === '1/2-1/2' ? 0.5 : (result === '1-0') === (userColor === 'w') ? 1 : 0;
  rating = computeRating({ result: score, elo: gameElo!, ratedGames: settings.ratedGames, accuracy, assists, abandoned });
  eloAfter = Math.max(ELO_MIN, Math.min(ELO_MAX, settings.elo + rating.delta));
  settings = { ...settings, elo: eloAfter, ratedGames: settings.ratedGames + 1 };
  saveSettings(settings);
  clearAnn('human');
  saveGame();
  renderRatingResult();
  if (screen === 'home') renderHome();
}

/** Rate an unfinished rated game right away (performance unknown) instead of losing it. */
function flushRating() {
  if (!ratePending) return;
  rateCtrl?.abort();
  applyRating(undefined);
}

/**
 * Leaving an unfinished game (new game, another position, opening a record): after a few moves it
 * counts as a resignation so a bad position can't be escaped for free. Returns false if cancelled.
 */
function leaveGame(): boolean {
  flushRating();
  if (result || imported || (tip() === tree.root && !peakUserMoves)) return true;
  const moved = Math.max(peakUserMoves, userMovesOf().length);
  if (moved < 3 || !rateable()) return true;
  if (!confirm('当前对局还没下完。离开会按认输记录并计算等级分，确定吗？')) return false;
  abandoned = true;
  shownResult = userColor === 'w' ? '0-1' : '1-0';
  endGame(shownResult, 'resign');
  return true;
}

function flag(color: Color) {
  if (result) return;
  endGame(timeoutResult(tip().fen, color), 'timeout');
  update();
}

async function maiaTurn(attempt = 0) {
  const t = tip();
  if (screen !== 'game' || mode !== 'play' || result !== '' || coachState !== 'idle' || turnOf(t.fen) === userColor) return;
  if (attempt === 0) maiaFailed = false;
  const token = ++gameToken;
  maiaThinking = true;
  update();
  let retry = false;
  try {
    const t0 = performance.now();
    const res = await maiaEval(t);
    if (token !== gameToken || mode !== 'play' || screen !== 'game') return;
    const pick = sampleMove(res.moves, settings.temperature, 1);
    if (settings.thinkDelay) {
      // longer "thinking" when the position is less obvious to a human
      const unclear = 1 - res.moves[0].p;
      const want = clock
        ? thinkBudget(clock.time(turnOf(t.fen), performance.now()), clock.tc.inc, unclear) * (0.7 + Math.random() * 0.6)
        : 300 + Math.random() * 600 + unclear * 2500;
      const wait = want - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
      if (token !== gameToken || mode !== 'play' || screen !== 'game') return;
    }
    maiaThinking = false;
    const played = playMove(pick.uci);
    if (played) {
      opponentSpeak(tip());
      update();
      if (settings.premove) cg.playPremove();
    }
  } catch (err) {
    console.error(err);
    // a crashed / hung worker is replaced by getMaia() on the next call
    retry = token === gameToken && attempt < 2;
    if (token === gameToken) {
      // out of retries: stop Maia's clock so an engine failure can't turn into a rated win on time
      maiaFailed = !retry;
      setStatus(retry ? 'Maia 无响应，正在重启…' : 'Maia 出错：' + (err as Error).message + '（返回首页再进入对局可重试）');
      if (maiaFailed) syncClock();
    }
  } finally {
    if (token === gameToken) {
      maiaThinking = false;
      update();
      if (retry) void maiaTurn(attempt + 1);
      else void coachTurn();
    }
  }
}

function newGame(fen = START_FEN, color?: Color): boolean {
  if (!leaveGame()) return false;
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
  eloAfter = undefined;
  gameModel = settings.model;
  result = '';
  reason = undefined;
  imported = false;
  headers = undefined;
  assists = emptyAssists();
  rating = undefined;
  ratePending = false;
  abandoned = false;
  peakUserMoves = 0;
  maiaFailed = false;
  resetAnalysisStatus();
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
  return true;
}

let hintedAt: Node | null = null;
let assistWarned = '';

/** First use of a help in a game that will be rated: say once that it lowers the rating gain. */
function assistOk(what: string): boolean {
  const willRate = ratingEnabled();
  if (!willRate || assistWarned === gameId) return true;
  if (!confirm(`使用${what}后，本局赢棋的加分会按比例减少（输棋照常扣分）。继续吗？`)) return false;
  assistWarned = gameId;
  return true;
}

function undo() {
  const t = tip();
  if (t === tree.root || mode !== 'play') return;
  if (result) {
    setStatus('对局已结束，不能悔棋');
    return;
  }
  if (!assistOk('悔棋')) return;
  gameToken++;
  maiaThinking = false;
  let target: Node = t;
  do target = target.parent!;
  while (target.parent && turnOf(target.fen) !== userColor);
  coachReset();
  retried = null;
  target.children = [];
  node = target;
  assists.undo++;
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
  // a hint is for the user's own move; while Maia thinks or the coach is judging it would show Maia's best
  if (turnOf(t.fen) !== userColor || maiaThinking || coachState !== 'idle') return;
  if (!assistOk('提示')) return;
  const token = gameToken;
  const stale = () => token !== gameToken || t !== tip() || mode !== 'play' || screen !== 'game';
  const box = $('hint-box');
  box.textContent = '思考中…';
  // counted once per position, however often the button is pressed
  if (hintedAt !== t) {
    hintedAt = t;
    assists.hint++;
    saveGame();
  }
  try {
    const s = await getSf();
    const r = await s.analyse(tree.root.fen, { moves: movesTo(t), movetime: settings.sfMovetime, depth: depthCap('hint'), multipv: 1 });
    if (stale()) return;
    const best = r.bestmove;
    hintShapes = best ? [arrow(best, 'green')] : [];
    let text = best ? `Stockfish 推荐：${sanOf(t.fen, best)}（${r.lines[0] ? evalText(r.lines[0], turnOf(t.fen)) : ''}）` : '';
    if (!settings.lowMemory) {
      const h = await maiaEval(t);
      if (stale()) return;
      const top = h.moves[0];
      if (top.uci !== best) hintShapes.push(arrow(top.uci, 'blue'));
      text += `\n${settings.elo} 分棋手最常走：` + h.moves.slice(0, 3).map((x) => `${sanOf(t.fen, x.uci)} ${(x.p * 100).toFixed(0)}%`).join('，');
    }
    box.textContent = text;
    refreshShapes();
  } catch (err) {
    if (!stale()) box.textContent = '提示失败：' + (err as Error).message;
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
  const token = gameToken;
  // the answer only counts while the user is still at the board, in the same game and position
  const stale = () => token !== gameToken || t !== tip() || result !== '' || mode !== 'play' || screen !== 'game';
  try {
    const [w, d, l] = (await maiaEval(t)).wdl;
    if (stale()) {
      setStatus('和棋提议已作废');
      return;
    }
    const maiaToMove = turnOf(t.fen) !== userColor;
    const maiaScore = maiaToMove ? w + d / 2 : l + d / 2;
    if (maiaScore <= 0.55) {
      endGame('1/2-1/2', 'agreement');
      update();
      setStatus('Maia 接受了和棋');
    } else setStatus('Maia 拒绝了和棋');
  } catch (err) {
    if (!stale()) setStatus('求和失败：' + (err as Error).message);
  }
}

// ---------- clock ----------

function clockShouldRun(): Color | null {
  if (!clock || result || maiaFailed || screen !== 'game' || mode !== 'play' || coachState !== 'idle' || document.hidden) return null;
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

/**
 * Depth at which a search is good enough to stop early (eco mode). Judging moves and explaining
 * them to a club player gains nothing past these depths, while running the full movetime on every
 * position (and an open-ended live search in review) keeps all cores busy and heats the phone.
 */
const DEPTH_CAP = { eval: 18, threat: 14, hint: 20, live: 24 } as const;

function depthCap(kind: keyof typeof DEPTH_CAP): number | undefined {
  // the phone is already throttling: back off further so it can cool down
  if (thermalState >= 2) return DEPTH_CAP[kind] - 4;
  return settings.ecoAnalysis ? DEPTH_CAP[kind] : undefined;
}

/** Search settings that change an evaluation's result; part of the persistent cache key. */
const evalSig = () => `${settings.sfLite ? 'l' : 'f'}${settings.sfMovetime}${settings.ecoAnalysis ? 'e' : ''}`;

async function evalNode(s: Stockfish, n: Node, signal: AbortSignal) {
  if (n.a.eval) return;
  // the FEN includes the move counters, so a repetition (scored as a draw) rarely shares a key
  const key = `${evalSig()}|${n.fen}`;
  const hit = getEval(key);
  if (hit) {
    n.a.eval = posEvalFrom(n, hit.line ? [hit.line] : [], hit.best);
    return;
  }
  const r = await s.analyse(tree.root.fen, { moves: movesTo(n), movetime: settings.sfMovetime, depth: depthCap('eval'), signal });
  if (signal.aborted) return;
  // no bestmove on a live position means the engine died mid-search; don't cache a fake "½"
  if (!r.bestmove && !chessOf(n).isGameOver()) return;
  n.a.eval = posEvalFrom(n, r.lines, r.bestmove);
  // a search shortened by overheating isn't representative
  if (thermalState < 2) putEval(key, { line: r.lines[0] ?? null, best: r.bestmove });
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
  const bars = document.querySelectorAll<HTMLElement>('.analyse-progress');
  const fills = [...bars].map((b) => b.firstElementChild as HTMLElement);
  const setFill = (pct: number) => fills.forEach((f) => (f.style.width = `${pct}%`));
  bars.forEach((b) => b.classList.remove('hidden'));
  setFill(0);
  const nodes = gameLine();
  const n = nodes.length;
  analysisStatus = 'running';
  analysisError = '';
  analysisTotal = n;
  analysisDone = nodes.filter((x) => Boolean(x.a.eval)).length;
  renderReportHint();
  try {
    const s = await getSf();
    for (let i = 0; i < n; i++) {
      if (ctrl.signal.aborted) return;
      // killed by the watchdog: its searches now return nothing at once; don't report a hollow "done"
      if (!s.alive) throw new Error('Stockfish 中途退出');
      await evalNode(s, nodes[i], ctrl.signal);
      analysisDone = nodes.filter((x) => Boolean(x.a.eval)).length;
      setFill(((i + 1) / n) * 100);
      if (nodes[i] === node || i % 4 === 0) update();
    }
    // aborted during the last position: the game (and `result`) may already be another one
    if (ctrl.signal.aborted) return;
    analysisDone = nodes.filter((x) => Boolean(x.a.eval)).length;
    if (analysisDone < n) {
      analysisStatus = 'interrupted';
      analysisError = `还有 ${n - analysisDone} 个局面没有完成分析`;
      setStatus(analysisError);
      return;
    }
    analysisDone = n;
    analysisStatus = 'complete';
    setStatus('分析完成');
    if (result && !imported) collectMistakes();
  } catch (err) {
    console.error(err);
    if (!ctrl.signal.aborted) {
      analysisStatus = 'failed';
      analysisError = (err as Error).message || '引擎未能完成分析';
      setStatus('分析中断：' + analysisError);
    }
  } finally {
    if (batchCtrl === ctrl) {
      if (ctrl.signal.aborted && analysisStatus === 'running') analysisStatus = 'interrupted';
      batchCtrl = null;
      bars.forEach((b) => b.classList.add('hidden'));
      void runLive();
    }
    update();
  }
}

/**
 * Maia's "what players at your level play here" for the shown position and the move that led to
 * it, computed when a position is viewed rather than for the whole game up front.
 */
async function reviewHuman() {
  if (mode !== 'review' || screen !== 'game' || autoplayOn()) return;
  // a single resident engine: loading Maia now would evict Stockfish mid-search
  const busy = (batchCtrl && !batchCtrl.signal.aborted) || (liveCtrl && !liveCtrl.signal.aborted);
  if (singleEngine() && busy) return;
  const n = node;
  const want = [n.parent && showMove(n) ? n.parent : null, showSide(n) && !chessOf(n).isGameOver() ? n : null];
  const todo = want.filter((x): x is Node => Boolean(x) && !x!.a.human);
  if (!todo.length) return;
  // settings changed while Maia ran: the answers belong to the old rating / model
  const sig = () => `${settings.elo}|${settings.model}|${settings.useHistory}`;
  const asked = sig();
  try {
    const m = await getMaia();
    const res = await m.evaluateMany(todo.map((x) => ({ chess: chessOf(x), fens: maiaFens(x), selfElo: settings.elo, oppoElo: settings.elo })));
    if (sig() !== asked) return;
    todo.forEach((x, i) => (x.a.human = res[i]));
  } catch (err) {
    console.error(err);
    return;
  }
  if (n === node && mode === 'review') {
    renderCoach();
    refreshShapes();
    renderLegend();
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
  if (!p || !a || !b || !n.uci) return null;
  const white = turnOf(p.fen) === 'w';
  const before = white ? a.white : 100 - a.white;
  const after = white ? b.white : 100 - b.white;
  const gp = p.parent?.a.eval;
  // opponent POV of the previous move = 100 - mover POV
  const oppDrop = gp ? (white ? a.white - gp.white : gp.white - a.white) : undefined;
  const live = p.a.live;
  const secondGap =
    live && live.length >= 2 && live[0].pv[0] === n.uci ? whiteWinPct(live[0], 'w') - whiteWinPct(live[1], 'w') : undefined;
  const key = `${before}|${after}|${a.best}|${oppDrop}|${secondGap}|${bookReady()}`;
  const hit = reviewCache.get(n);
  if (hit?.key === key) return hit.r;
  const judgement = classify({
    before,
    after,
    playedBest: n.uci === a.best,
    book: inBook(n.fen),
    forced: new Chess(p.fen).moves().length === 1,
    sacrifice: before - after < 3 && isSacrifice(p.fen, n.uci),
    oppDrop,
    secondGap,
  });
  const r = { judgement, before, after, accuracy: moveAccuracy(before, after) };
  reviewCache.set(n, { key, r });
  return r;
}
const reviewCache = new WeakMap<Node, { key: string; r: MoveReview }>();

function setLive(on: boolean) {
  liveOn = on;
  if (!on) {
    liveCtrl?.abort();
    liveLines = [];
  }
  void runLive();
}

/** web low-memory mode keeps a single engine resident (see Engines.exclusive) */
const singleEngine = () => !isNative && settings.lowMemory && !settings.sfLite;

async function runLive() {
  // with a single resident engine, Maia must wait until the live search is done
  const early = !singleEngine();
  if (early) void reviewHuman();
  await liveSearch();
  if (!early) void reviewHuman();
}

async function liveSearch() {
  liveCtrl?.abort();
  liveLines = [];
  renderLines();
  if (!liveOn || mode !== 'review' || (batchCtrl && !batchCtrl.signal.aborted)) return;
  const n = node;
  if (n.a.live) {
    liveLines = n.a.live;
    renderLines();
    renderEvalBar();
    refreshShapes();
    renderLegend();
    return;
  }
  // autoplay moves on every ~1s: a search per step would keep the engine busy the whole time
  if (document.hidden || autoplayOn()) return;
  const ctrl = new AbortController();
  liveCtrl = ctrl;
  // engine output arrives every ~50ms; re-rendering PV text + arrows that often costs more than it shows
  let pending: SfLine[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!pending || ctrl.signal.aborted || n !== node) return;
    liveLines = pending;
    pending = null;
    renderLines();
    renderEvalBar();
    refreshShapes();
    renderLegend();
  };
  try {
    const s = await getSf();
    if (ctrl.signal.aborted) return;
    const r = await s.analyse(tree.root.fen, {
      moves: movesTo(n),
      // eco: the position is settled long before a minute; stop at the depth cap or after 15s
      movetime: settings.ecoAnalysis || thermalState >= 2 ? 15000 : 60000,
      depth: depthCap('live'),
      multipv: 3,
      signal: ctrl.signal,
      onInfo: (lines) => {
        if (ctrl.signal.aborted || n !== node) return;
        pending = lines;
        if (liveLines.length === 0) flush();
        else timer ??= setTimeout(flush, 250);
      },
    });
    if (timer) clearTimeout(timer);
    if (!ctrl.signal.aborted && r.bestmove && r.lines.length) n.a.live = r.lines;
    flush();
  } catch (err) {
    console.error(err);
  } finally {
    if (liveCtrl === ctrl) liveCtrl = null;
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
    if (r && ['mistake', 'miss', 'blunder', 'inaccuracy', 'brilliant'].includes(r.judgement)) {
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

const LEARNING_JUDGEMENTS = new Set<Judgement>(['inaccuracy', 'mistake', 'miss', 'blunder']);
const SERIOUS_JUDGEMENTS = new Set<Judgement>(['mistake', 'miss', 'blunder']);

function learningTag(n: Node): { id: string; label: string } {
  const saved = loadMistakes().find((m) => m.gameId === gameId && m.id === `${gameId}:${n.ply}`);
  if (saved) return { id: saved.tag, label: saved.tagLabel };
  const p = n.parent;
  const best = p?.a.eval?.best;
  return best && p?.a.eval?.lines[0]
    ? mistakeTag({ fen: p.fen, uci: n.uci, best, bestLine: p.a.eval.lines[0], replyLine: n.a.eval?.lines[0] })
    : { id: 'other', label: '局面判断失误' };
}

function learningIssues(): Node[] {
  const side: IssueSide = imported ? 'all' : 'me';
  return reviewIssues(side)
    .filter((n) => {
      const r = reviewOf(n);
      return Boolean(r && LEARNING_JUDGEMENTS.has(r.judgement));
    })
    .sort((a, b) => {
      const ra = reviewOf(a)!;
      const rb = reviewOf(b)!;
      return SEVERITY[rb.judgement] - SEVERITY[ra.judgement] || rb.before - rb.after - (ra.before - ra.after) || b.ply - a.ply;
    });
}

function checkForTag(tag: string): string {
  if (tag.includes('mate')) return '走棋前先检查对方的将军、杀棋威胁和王的安全。';
  if (tag.includes('fork')) return '先问自己：对方下一步能否同时攻击两个目标？';
  if (tag.includes('pin') || tag.includes('skewer')) return '检查被牵制或串击的子，确认它是否真的能移动或回吃。';
  if (tag.includes('hanging') || tag.includes('free') || tag.includes('trade-up')) return '落子后再扫一遍对方的将军、吃子和直接威胁。';
  if (tag.includes('discovered') || tag.includes('double-check')) return '检查移动一个棋子后是否打开了另一条攻击线。';
  if (tag.includes('trapped')) return '走之前确认自己的棋子是否还有安全的退路。';
  return '用 CCT 快速检查：对方的将军、吃子和直接威胁。';
}

function trendRecommendation(): { label: string; tag: string; theme?: string; reason: string } | null {
  const stats = mistakeStats(loadMistakes());
  const candidates = stats
    .filter((s) => s.recent > 0)
    .sort((a, b) => b.recent - b.previous - (a.recent - a.previous) || b.recent - a.recent || b.total - a.total);
  const s = candidates[0];
  if (!s) return null;
  const theme = themesForTag(s.tag, settings.elo).find((t) => THEME_LABEL[t]);
  const trend = s.recent > s.previous ? `近 30 天出现 ${s.recent} 次，比之前 30 天更多` : `近 30 天出现 ${s.recent} 次`;
  return { label: s.label, tag: s.tag, theme, reason: trend };
}

function renderLearningSummary() {
  const box = $('learning-report-summary');
  if (mode === 'review' && gameLine().length && analysisStatus !== 'complete') {
    const retry = analysisStatus === 'interrupted' || analysisStatus === 'failed';
    const detail = analysisStatus === 'running' ? 'Stockfish 正在逐步检查整局，完成后才会生成最终的学习结论。' : analysisStatus === 'idle' ? '正在准备完整复盘，完成后才会生成最终的学习结论。' : analysisError || '分析没有覆盖整局，暂不生成最终结论。';
    box.classList.remove('hidden');
    box.innerHTML = `<div class="learning-kicker">本地学习总结</div><h3>等待完整复盘</h3><p>${escapeHtml(detail)}</p>${retry ? '<button type="button" class="primary" data-learning-analysis>继续分析</button>' : ''}`;
    return;
  }
  const issues = learningIssues().slice(0, 3);
  const serious = issues.filter((n) => SERIOUS_JUDGEMENTS.has(reviewOf(n)!.judgement));
  const focus = serious[0] ?? issues[0];
  const good = gameLine()
    .filter((n) => !imported ? turnOf(n.parent?.fen ?? n.fen) === userColor : true)
    .map((n) => ({ n, r: reviewOf(n) }))
    .filter((x): x is { n: Node; r: MoveReview } => Boolean(x.r && ['brilliant', 'great', 'best'].includes(x.r.judgement)))
    .sort((a, b) => b.r.accuracy - a.r.accuracy)[0];
  const trend = trendRecommendation();
  if (!gameLine().length || (!issues.length && !good && !trend)) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }

  const issueCards = issues.length
    ? issues
        .map((n, i) => {
          const r = reviewOf(n)!;
          const tag = learningTag(n);
          const insight = insightOf(n);
          const best = n.parent?.a.eval?.best;
          const themes = themesForTag(tag.id, settings.elo).filter((t) => THEME_LABEL[t]);
          const saved = loadMistakes().find((m) => m.gameId === gameId && m.id === `${gameId}:${n.ply}`);
          const theme = themes[0];
          const explanation = insight?.problem.length ? insight.problem.join('；') : `这步棋被归类为“${tag.label}”。${checkForTag(tag.id)}`;
          return (
            `<div class="learning-issue"><div class="learning-issue-head"><b>${i + 1}. ${escapeHtml(n.san)} · ${escapeHtml(JUDGEMENT_INFO[r.judgement].label)}</b>` +
            `<span>${escapeHtml(tag.label)}</span></div><p>${escapeHtml(explanation)}</p>` +
            `<p>行棋方胜率 ${r.before.toFixed(0)}% → ${r.after.toFixed(0)}%</p>` +
            (best && best !== n.uci ? `<p><b>更好的着法：${escapeHtml(sanOf(n.parent!.fen, best))}</b>${insight?.better.length ? ` · ${escapeHtml(insight.better.join('；'))}` : ' · Stockfish 在当前分析深度下更倾向这步棋'}</p>` : '') +
            `<div class="learning-actions"><button type="button" data-learning-jump="${n.id}">回到这一步</button>` +
            (saved ? `<button type="button" data-learning-mistake="${escapeHtml(saved.id)}">重练错题</button>` : '') +
            (theme ? `<button type="button" data-learning-theme="${theme}">练${escapeHtml(THEME_LABEL[theme])}题</button>` : '') +
            `</div></div>`
          );
        })
        .join('')
    : '<p class="muted">这局没有明显的错误着法，继续保持落子前的检查习惯。</p>';
  const goodPraise = good ? insightOf(good.n)?.praise : null;
  const goodHtml = good
    ? `<p><b>${escapeHtml(good.n.san)}</b> · ${escapeHtml(goodPraise || '这步棋符合 Stockfish 当前分析的优秀选择。')}</p>`
    : '<p class="muted">本局暂时没有足够的引擎数据标出代表性好棋。</p>';
  const next = focus ? checkForTag(learningTag(focus).id) : trend ? `重点练习${escapeHtml(trend.label)}相关的局面。` : '继续做一次 CCT 检查：将军、吃子和直接威胁。';
  const trendHtml = trend
    ? `<div class="learning-next"><b>下一步练什么</b><p>${escapeHtml(trend.label)} · ${escapeHtml(trend.reason)}</p>${trend.theme ? `<button type="button" data-learning-theme="${trend.theme}">练${escapeHtml(THEME_LABEL[trend.theme])}题</button>` : ''}</div>`
    : '';
  box.classList.remove('hidden');
  box.innerHTML = `<div class="learning-kicker">本地学习总结</div><h3>本局最值得学习的 ${issues.length ? `${issues.length} 个问题` : '问题'}</h3>${issueCards}<div class="learning-good"><b>值得保留的好棋</b>${goodHtml}</div><div class="learning-next"><b>下一次检查点</b><p>${escapeHtml(next)}</p></div>${trendHtml}`;
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
  renderReviewNav();
  const sides: Color[] = ['w', 'b'];
  const who = (c: Color) => {
    const side = c === 'w' ? '白' : '黑';
    if (imported) return escapeHtml((c === 'w' ? headers?.White : headers?.Black) || `${side}方`);
    return `${side}（${userColor === c ? '我' : 'Maia'}）`;
  };
  const acc = (c: Color) => {
    const a = stats[c].acc;
    return a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '—';
  };
  const cell = (c: Color, j: Judgement) => {
    if (!stats[c].acc.length) return '<span class="rp-cnt zero">—</span>';
    const count = stats[c].c[j] ?? 0;
    return `<button type="button" class="rp-cnt${count ? '' : ' zero'}" data-side="${c}" data-judgement="${j}" style="color:${judgeColor(j)}" aria-label="${who(c)}${JUDGEMENT_INFO[j].label}${count}次">${count}</button>`;
  };
  const line = (k: string, vals: string[], mid = '', cls = '') =>
    `<div class="rp-row${cls}"><span class="rp-k">${k}</span>${vals[0]}<span class="rp-ico">${mid}</span>${vals[1]}</div>`;
  const core: Judgement[] = ['best', 'good', 'inaccuracy', 'mistake', 'blunder'];
  const rows = JUDGEMENTS.filter((j) => core.includes(j) || stats.w.c[j] || stats.b.c[j])
    .map((j) => line(JUDGEMENT_INFO[j].label, sides.map((c) => cell(c, j)), judgeIcon(j)))
    .join('');
  box.dataset.empty = String(!stats.w.acc.length && !stats.b.acc.length);
  box.innerHTML =
    line('', sides.map((c) => `<div class="rp-who">${sideAvatar(c, 'rp-ava')}<b class="rp-name">${who(c)}</b></div>`), '', ' rp-head') +
    line('准确率', sides.map((c) => `<span class="rp-accv${c === 'w' ? ' w' : ''}">${acc(c)}</span>`), '', ' rp-acc') +
    rows;
  renderLearningSummary();
  box.querySelectorAll<HTMLButtonElement>('.rp-cnt').forEach((button) => {
    button.onclick = () => {
      const side = button.dataset.side as Color;
      const j = button.dataset.judgement as Judgement;
      const target = gameLine().find((n) => n.parent && turnOf(n.parent.fen) === side && showMove(n) && reviewOf(n)?.judgement === j);
      if (!target) return;
      closeReport();
      goto(target);
    };
  });
}

let reportOpen = false;

function openReport() {
  stopAutoplay();
  reportOpen = true;
  $('report').classList.remove('hidden');
  renderReportHint();
}

function closeReport() {
  reportOpen = false;
  $('report').classList.add('hidden');
}

function renderReportHint() {
  const analysing = Boolean(batchCtrl && !batchCtrl.signal.aborted);
  const empty = $('summary').dataset.empty === 'true';
  const hint = $('report-hint');
  if (analysing || analysisStatus === 'running') {
    hint.textContent = analysisTotal ? `正在分析整局… ${analysisDone}/${analysisTotal}` : '正在分析整局…';
  } else if (analysisStatus === 'interrupted') {
    hint.textContent = `${analysisError || '分析未完成'}，可继续分析。`;
  } else if (analysisStatus === 'failed') {
    hint.textContent = `分析失败：${analysisError || '引擎未能完成分析'}，可重试。`;
  } else if (analysisStatus === 'idle') {
    hint.textContent = '等待完整分析后生成学习总结。';
  } else {
    hint.textContent = empty ? '暂无可统计的着法' : '';
  }
}

type IssueSide = 'all' | 'me' | 'opp';

/** With opponent review on, the main issue nav only visits the user's own moves and the opponent's get a separate one. */
const splitIssueNav = () => settings.reviewOpponent && !imported;

function reviewIssues(side: IssueSide = 'all'): Node[] {
  return gameLine().filter((n) => {
    if (side !== 'all' && n.parent && (turnOf(n.parent.fen) === userColor) !== (side === 'me')) return false;
    const r = showMove(n) ? reviewOf(n) : null;
    return r && SEVERITY[r.judgement] > 0;
  });
}

function jumpReviewIssue(direction: -1 | 1, side: IssueSide = splitIssueNav() ? 'me' : 'all') {
  const issues = reviewIssues(side);
  if (!issues.length) {
    setStatus(side === 'opp' ? '对手没有可跳转的问题着法' : '还没有可跳转的问题着法');
    return;
  }
  let target: Node | undefined;
  if (direction > 0) target = issues.find((n) => n.ply > realOf(node).ply);
  else target = [...issues].reverse().find((n) => n.ply < realOf(node).ply);
  target ??= direction > 0 ? issues[0] : issues[issues.length - 1];
  goto(target);
}

function renderReviewNav() {
  const split = splitIssueNav();
  const counts: Record<'me' | 'opp', Node[]> = { me: reviewIssues(split ? 'me' : 'all'), opp: split ? reviewIssues('opp') : [] };
  const label = (issues: Node[]) => {
    const cur = issues.indexOf(realOf(node));
    return issues.length ? `${cur >= 0 ? `${cur + 1}/` : ''}${issues.length}` : '0';
  };
  $('review-issues').textContent = label(counts.me);
  $('review-issues').title = split ? '我的问题着法（不精确/错误/漏着）' : '问题着法（不精确/错误/漏着）';
  $('review-issues-opp').textContent = label(counts.opp);
  $('review-issues-opp').title = '对手的问题着法（不精确/错误/漏着）';
  $('review-opp-nav').classList.toggle('hidden', !split);
  document.querySelectorAll<HTMLButtonElement>('[data-review-nav]').forEach((button) => {
    const opp = button.dataset.reviewSide === 'opp';
    const side: IssueSide = opp ? 'opp' : split ? 'me' : 'all';
    button.disabled = counts[opp ? 'opp' : 'me'].length === 0;
    button.onclick = () => jumpReviewIssue(button.dataset.reviewNav === 'next' ? 1 : -1, side);
  });
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
      const ins = insightOf(node);
      parts.push(
        `<div class="j" style="color:${judgeColor(r.judgement)}">${judgeIcon(r.judgement)}${num} ${node.san} ${info.label}</div>`,
        `<div title="胜率：按引擎评估估算的获胜机会">行棋方胜率 ${r.before.toFixed(0)}% → ${r.after.toFixed(0)}%${plainOf(node) ? `；${plainOf(node)}` : ''}</div>`,
      );
      if (ins?.praise) parts.push(`<div class="praise">★ ${ins.praise}</div>`);
      if (ins?.problem.length) {
        const l = node.a.eval?.lines[0];
        parts.push(
          `<div class="cc-why"><span class="tag bad">问题</span><span>${ins.problem.join('；')}</span></div>`,
          `<div class="cc-pv">${demoControls(node.fen, l?.pv ?? [], `bad:${node.id}`, `演示：${pvToSan(node.fen, l?.pv ?? [], 6)}`)}</div>`,
        );
      }
      if (prev.best && prev.best !== node.uci) {
        const pv = prev.lines[0]?.pv ?? [];
        const why = ins?.better.length ? `：${ins.better.join('，')}` : '';
        parts.push(
          `<div class="cc-why"><span class="tag good">更好</span><span><b>${sanOf(p.fen, prev.best)}</b>${why}（${prev.text}）</span></div>`,
          `<div class="cc-pv">${demoControls(p.fen, pv, `good:${node.id}`, `演示：${pvToSan(p.fen, pv)}`)}</div>`,
        );
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
  // in a game played here the record is what happened; only imported games can have their main line rewritten
  const main = imported ? '<button data-va="main">设为主线</button>' : '';
  box.innerHTML = `<span class="muted">变着</span><button data-va="back">回到主线</button>${main}<button data-va="del">删除变着</button>`;
}

function varAction(act: string) {
  if (act === 'back') {
    // back to the game position where the exploration / variation branched off
    let v = node;
    while (v.parent && !tree.isMainline(v)) v = v.parent;
    goto(v);
    return;
  }
  if (act === 'main') {
    if (!imported) return;
    tree.makeMainline(node);
  } else if (act === 'del') {
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
  if (!analyseMissing() && liveOn) void runLive();
}

// ---------- coach ----------

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PIECE_GLYPH: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };

/** 讲解中双方的称呼：`mover` 是走这步棋的一方。 */
function sidesFor(mover: Color): Sides {
  if (imported) return mover === 'w' ? { me: '白方', opp: '黑方' } : { me: '黑方', opp: '白方' };
  return mover === userColor ? { me: '你', opp: '对手' } : { me: 'Maia', opp: '你' };
}

const povSides = (): Sides => (imported ? { me: '白方', opp: '黑方' } : { me: '你', opp: 'Maia' });
const povColor = (): Color => (imported ? 'w' : userColor);

/** 当前局面形势的大白话。 */
function plainOf(n: Node): string {
  const l = n.a.eval?.lines[0];
  if (!l) {
    const c = chessOf(n);
    if (c.isCheckmate()) return turnOf(n.fen) === povColor() ? `${povSides().opp}将杀` : `${povSides().me}将杀`;
    return c.isGameOver() ? '和棋' : '';
  }
  return plainEval(l, turnOf(n.fen), povColor(), povSides());
}

const insightCache = new WeakMap<Node, { ins: MoveInsight; a: PosEval; b: PosEval; who: string }>();

/** 走到 `n` 的那步棋的新手讲解（需要前后两个局面的评估）。 */
function insightOf(n: Node): MoveInsight | null {
  const p = n.parent;
  const r = reviewOf(n);
  if (!p || !r || !n.uci) return null;
  const a = p.a.eval!;
  const b = n.a.eval!;
  const sides = sidesFor(turnOf(p.fen));
  const hit = insightCache.get(n);
  if (hit && hit.a === a && hit.b === b && hit.who === sides.me) return hit.ins;
  const ins = explainMove({
    fen: p.fen,
    uci: n.uci,
    best: a.best,
    bestLine: a.lines[0],
    replyLine: b.lines[0],
    bad: SEVERITY[r.judgement] > 0,
    sides,
  });
  insightCache.set(n, { ins, a, b, who: sides.me });
  return ins;
}

// ---------- 变化逐步演示 ----------

/** 在棋盘上逐步播放一条引擎变化；`key` 标识是哪张卡片发起的。 */
let demo: { fen: string; pv: string[]; idx: number; key: string; anchor: Node; state: string; mode: string } | null = null;

function demoFen(): string | null {
  return demo ? fenAt(demo.fen, demo.pv, demo.idx) : null;
}

function startDemo(fen: string, pv: string[], key: string) {
  const c = new Chess(fen);
  const ok: string[] = [];
  for (const u of pv.slice(0, 10)) {
    try {
      c.move(toMove(u));
      ok.push(u);
    } catch {
      break;
    }
  }
  if (!ok.length) return;
  cg.cancelPremove();
  demo = { fen, pv: ok, idx: 0, key, anchor: node, state: coachState, mode };
  stepDemo(1);
}

/** 离开发起演示的局面、切换模式或教练状态变化后，演示自动结束。 */
function validateDemo() {
  if (demo && (demo.anchor !== node || demo.state !== coachState || demo.mode !== mode || screen !== 'game')) demo = null;
}

function stepDemo(d: number) {
  if (!demo) return;
  const idx = Math.max(0, Math.min(demo.pv.length, demo.idx + d));
  if (idx === demo.idx) return;
  demo.idx = idx;
  if (idx > 0 && d > 0) play(soundForSan(sanOf(fenAt(demo.fen, demo.pv, idx - 1), demo.pv[idx - 1])));
  const m = d === 1 && idx > 0 ? moveFxOf(fenAt(demo.fen, demo.pv, idx - 1), demo.pv[idx - 1]) : null;
  if (!m) fx.clear();
  update();
  if (m) playFx(m);
}

function fenAt(fen: string, pv: string[], n: number): string {
  const c = new Chess(fen);
  for (const u of pv.slice(0, n)) c.move(toMove(u));
  return c.fen();
}

function stopDemo() {
  if (!demo) return;
  demo = null;
  update();
}

// 用 SVG 而非 ⏮/▶ 等字符：iOS 会把它们渲染成彩色 emoji。
const demoIcon = (d: string) =>
  `<svg class="demo-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
const DEMO_ICONS = {
  play: demoIcon('M4 2.5v11l9-5.5z'),
  first: demoIcon('M3 3h2v10H3zM14 3v10L6 8z'),
  prev: demoIcon('M11 2.5v11L3 8z'),
  next: demoIcon('M5 2.5v11L13 8z'),
  stop: demoIcon('M4.2 2.8 8 6.6l3.8-3.8 1.4 1.4L9.4 8l3.8 3.8-1.4 1.4L8 9.4l-3.8 3.8-1.4-1.4L6.6 8 2.8 4.2z'),
};

/** 卡片里的“演示”按钮，或正在演示时的控制条。 */
function demoControls(fen: string, pv: string[], key: string, label: string): string {
  if (!pv.length) return '';
  if (demo?.key !== key) {
    return `<button type="button" class="demo-btn" data-demo="start" data-key="${escapeHtml(key)}" data-fen="${escapeHtml(fen)}" data-pv="${pv.join(' ')}">${DEMO_ICONS.play}${label}</button>`;
  }
  const san = demo.idx > 0 ? sanOf(fenAt(demo.fen, demo.pv, demo.idx - 1), demo.pv[demo.idx - 1]) : '起始局面';
  return (
    `<div class="demo-bar"><button type="button" data-demo="first" aria-label="回到起点">${DEMO_ICONS.first}</button>` +
    `<button type="button" data-demo="prev" aria-label="上一步">${DEMO_ICONS.prev}</button>` +
    `<span class="demo-pos">${demo.idx}/${demo.pv.length} <b>${san}</b></span>` +
    `<button type="button" data-demo="next" aria-label="下一步">${DEMO_ICONS.next}</button>` +
    `<button type="button" data-demo="stop" aria-label="结束演示">${DEMO_ICONS.stop}</button></div>`
  );
}

function onDemoClick(e: Event): boolean {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-demo]');
  if (!b) return false;
  const act = b.dataset.demo;
  if (act === 'start') startDemo(b.dataset.fen!, b.dataset.pv!.split(' '), b.dataset.key!);
  else if (act === 'first') stepDemo(-99);
  else if (act === 'prev') stepDemo(-1);
  else if (act === 'next') stepDemo(1);
  else if (act === 'stop') stopDemo();
  return true;
}

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
  coachReveal = false;
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
  const r = await s.analyse(nf, { movetime: Math.min(settings.sfMovetime, 600), depth: depthCap('threat'), signal });
  if (signal.aborted) return;
  const line = r.lines[0];
  // no bestmove with legal moves left means the engine died mid-search: leave it unknown so it is searched again
  if (!r.bestmove && new Chess(nf).moves().length) return;
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
  const motif = confirmedMotifs(nf, line.pv, '你的').find((x) => x.kind !== 'check');
  if (line.mate !== undefined && line.mate > 0) text += `，${line.mate} 步杀`;
  else if (motif) text += `：${motif.text}`;
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
  assists.retry++;
  if (clock && from.clock) clock.set(from.clock, performance.now());
  cg.cancelPremove();
  hintShapes = [];
  coachReveal = false;
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
  coachReveal = false;
  update();
  void maiaTurn();
}

/** User pieces that are attacked and either undefended or attacked by something cheaper. */
let hangingMemo: { fen: string; color: Color; out: Square[] } | null = null;
function hangingSquares(n: Node): Square[] {
  if (hangingMemo?.fen !== n.fen || hangingMemo.color !== userColor) hangingMemo = { fen: n.fen, color: userColor, out: hangingOf(n.fen, userColor) };
  return hangingMemo.out;
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
    if (coachReveal && better && better !== bad?.uci) out.push({ ...arrow(better, 'green'), modifiers: { lineWidth: 8 } });
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

function explainMistake(from: Node, reveal = false): string {
  const mv = from.children[0];
  const r = mv && reviewOf(mv);
  const before = from.a.eval;
  const after = mv?.a.eval;
  if (!mv || !r || !before || !after) return '';
  const info = JUDGEMENT_INFO[r.judgement];
  const num = from.fen.split(' ')[5];
  const ins = insightOf(mv);
  const parts = [
    `<div class="cc-head"><span class="cc-title" style="color:${info.color}">${num}${turnOf(from.fen) === 'w' ? '.' : '…'} ${mv.san}${info.symbol} ${info.label}</span>` +
      `<span class="cc-win" title="胜率：按引擎评估估算的获胜机会">胜率 ${r.before.toFixed(0)}% → <b style="color:${info.color}">${r.after.toFixed(0)}%</b></span></div>`,
    `<div class="cc-plain">走完这步后：${plainOf(mv)}</div>`,
  ];
  const l = after.lines[0];
  if (reveal && after.best && ins?.problem.length) {
    parts.push(
      `<div class="cc-why"><span class="tag bad">问题</span><span>${ins.problem.join('；')}</span></div>`,
      `<div class="cc-pv">${demoControls(mv.fen, l?.pv ?? [], 'bad', `演示对手的应对：${pvToSan(mv.fen, l?.pv ?? [], 6)}`)}</div>`,
    );
  }
  if (!reveal) {
    parts.push('<div class="cc-prompt"><b>先想一想：</b>你能找出这步棋漏掉的威胁，以及更安全的候选着吗？</div>');
    return parts.join('');
  }
  if (before.best && before.best !== mv.uci) {
    const good = sanOf(from.fen, before.best);
    const bl = before.lines[0];
    const why = ins?.better.length ? `：${ins.better.join('，')}` : '';
    parts.push(
      `<div class="cc-why"><span class="tag good">更好</span><span><b>${good}</b>${why}（走它的话：${plainOf(from)}）</span></div>`,
      `<div class="cc-pv">${demoControls(from.fen, bl?.pv ?? [], 'good', `演示更好的走法：${pvToSan(from.fen, bl?.pv ?? [], 5)}`)}</div>`,
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
      `<div class="coach-card">${explainMistake(coachFrom, coachReveal)}` +
      `<div class="cc-actions">${
        coachReveal ? '' : '<button data-act="reveal">查看更好的走法</button>'
      }<button class="primary" data-act="retry">重走这步</button><button data-act="go">继续对局</button></div></div>`;
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
    const praise = ok ? insightOf(last)?.praise : null;
    if (praise) parts.push(`<div class="cl-row praise"><span class="tag good">★</span><span><b>${last.san}</b> ${praise}</span></div>`);
    else parts.push(`<div class="cl-row"><span class="tag" style="background:${info.color}">${ok ? '✓' : info.symbol}</span><span>${last.san} ${info.label}</span></div>`);
  }
  if (result === '' && node === t && turnOf(t.fen) === userColor) {
    if (settings.coachEval && t.a.eval) parts.push(`<div class="cl-row muted"><span class="tag">≈</span><span>形势：${plainOf(t)}</span></div>`);
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

/** 与 style.css 中宽屏布局的媒体查询保持一致：宽屏显示整棵着法树，窄屏只显示当前线 */
const WIDE = matchMedia('(min-aspect-ratio: 1/1) and (min-width: 720px)');

function openBranches(parent: Node) {
  const title = $('branch-title');
  const list = $('branch-list');
  const num = moveNumberOf(parent.fen);
  const prefix = turnOf(parent.fen) === 'w' ? `${num}.` : `${num}…`;
  title.textContent = `${prefix} 的其他着法`;
  list.innerHTML = parent.children
    .map((c, i) => {
      const tag = c.x ? '试走' : i === 0 ? '主线' : '变着';
      return `<button data-id="${c.id}"${tree.pathTo(node).includes(c) ? ' class="on"' : ''}><b>${prefix}${escapeHtml(c.san)}</b><span class="muted">${tag}</span></button>`;
    })
    .join('');
  const dlg = $<HTMLDialogElement>('dlg-branch');
  list.onclick = (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.id;
    if (!id) return;
    dlg.close();
    goto(findNode(tree, Number(id)));
  };
  dlg.showModal();
}

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
    WIDE.matches ? 'tree' : 'line',
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
    const pieceClass = opp === 'b' ? 'black' : 'white';
    html += Array.from(
      { length: taken },
      () => `<span class="cap-piece ${pieceClass}" aria-hidden="true">${PIECE_GLYPH[t]}</span>`,
    ).join('');
    score += PIECE_VALUE[t] * (count[color][t] - count[opp][t]);
  }
  return { html, diff: score };
}

/** 我：设置里的头像；Maia：教练形象；导入的对局：默认剪影 */
function sideAvatar(c: Color, cls = ''): string {
  if (imported) return avatarHtml('', cls.replace('pick', ''));
  return c === userColor ? avatarHtml(settings.avatar, cls) : coachAvatarHtml(settings.coachAvatar, cls);
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
    const avatar = sideAvatar(color, who === 'me' ? 'pick' : '');
    const thinking = who === 'maia' && maiaThinking ? '<span class="dots"><i></i><i></i><i></i></span>' : '';
    const v = clockView(color);
    return (
      `${avatar}<div class="pinfo"><div class="pname">${name} <span class="elo">${elo}</span>${thinking}</div>` +
      `<div class="caps ${color === 'w' ? 'by-w' : 'by-b'}">${m.html}${m.diff > 0 ? `<span class="adv">+${m.diff}</span>` : ''}</div></div>` +
      `<div class="clock${v.active ? ' active' : ''}${v.low ? ' low' : ''}${clock || node.clock ? ' timed' : ''}" data-clock="${color}">${v.text}</div>`
    );
  };
  const actions = $('my-actions');
  $('player-top').innerHTML = card(flipped ? 'me' : 'maia');
  $('player-bottom').innerHTML = card(flipped ? 'maia' : 'me');
  // 手机对弈：提示/悔棋/教练放在“我”的信息栏里（时钟左侧）
  const mine = $(flipped ? 'player-top' : 'player-bottom');
  mine.insertBefore(actions, mine.querySelector('.clock'));
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

function renderOpponentDialogue() {
  const box = $('opponent-dialogue');
  const visible = Boolean(opponentLine) && settings.opponentTalk && !coachOn && !imported && mode === 'play';
  box.classList.toggle('show', visible);
  if (!visible) {
    box.innerHTML = '';
    return;
  }
  const personality = OPPONENT_PERSONALITIES[settings.opponentPersonality as OpponentPersonality] ?? OPPONENT_PERSONALITIES.sharp;
  box.innerHTML = `<span class="opponent-label">${escapeHtml(personality.label)} · Maia</span>${escapeHtml(opponentLine)}`;
}

function update() {
  validateDemo();
  syncClock();
  renderBoard();
  renderMoves();
  renderPlayers();
  renderPlayInfo();
  renderOpponentDialogue();
  renderEvalBar();
  renderGraph();
  renderSummary();
  renderReportHint();
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
  renderRatingResult();
  setTimeout(() => {
    const dlg = $<HTMLDialogElement>('dlg-result');
    if (screen === 'game' && !dlg.open) dlg.showModal();
  }, 450);
}

function renderRatingResult() {
  const box = $('result-elo');
  if (ratePending) {
    box.textContent = '正在评估本局表现，稍后计算等级分…';
    box.hidden = false;
  } else if (!coachOn && eloAfter !== undefined && gameElo !== undefined && rating) {
    const d = eloAfter - gameElo;
    box.innerHTML =
      `等级分 ${gameElo} → <b class="${d > 0 ? 'win' : d < 0 ? 'loss' : ''}">${eloAfter}</b>（${d > 0 ? '+' : ''}${d}），下一局 Maia 将按新分数对弈` +
      `<small>${escapeHtml(ratingBreakdown(rating))}</small>`;
    box.hidden = false;
  } else box.hidden = true;
}

function showScreen(s: 'home' | 'game' | 'train', push = true) {
  const prev = screen;
  screen = s;
  const hash = s === 'home' ? '' : `#${s}`;
  if (push && s !== 'home' && location.hash !== hash) {
    if (location.hash) history_.replaceState(null, '', hash);
    else history_.pushState(null, '', hash);
  }
  if (push && s === 'home' && location.hash) history_.back();
  $('home').classList.toggle('active', s === 'home');
  $('game').classList.toggle('active', s === 'game');
  $('train').classList.toggle('active', s === 'train');
  if (s === 'train') {
    requestAnimationFrame(trainerRedraw);
    if (prev !== 'game') return;
  }
  if (s !== 'game') {
    stopAutoplay();
    gameToken++;
    maiaThinking = false;
    prepCtrl?.abort();
    prep = null;
    if (coachState === 'checking') coachReset();
    setLive(false);
    syncClock();
    saveGame();
    renderHome();
  } else if (s === 'game') {
    requestAnimationFrame(() => {
      cg.redrawAll();
      update();
      resumeCoach();
      startReview();
    });
  }
}

const history_ = window.history;

function goto(n: Node | null | undefined, auto = false) {
  if (!auto) stopAutoplay();
  if (!n || n === node) return;
  node = n;
  hintShapes = [];
  update();
  if (!analyseMissing() && liveOn) void runLive();
}

/** Starts the whole-game analysis when the shown game line (e.g. a PGN variation) has unanalysed positions. */
function analyseMissing(): boolean {
  if (mode !== 'review' || screen !== 'game' || (batchCtrl && !batchCtrl.signal.aborted)) return false;
  if (!gameLine().some((x) => !x.a.eval)) return false;
  void analyseGame();
  return true;
}

function lastOfLine(): Node {
  const l = currentLine();
  return l[l.length - 1];
}

function setMode(m: 'play' | 'review') {
  const prev = mode;
  mode = m;
  stopAutoplay();
  if (m === 'play' && !tree.isMainline(node)) node = tip();
  if (m === 'play') closeReport();
  else if (prev !== 'review') openReport();
  $('game').dataset.mode = m;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === m));
  $('tab-play').classList.toggle('hidden', m !== 'play');
  $('tab-review').classList.toggle('hidden', m !== 'review');
  cg.cancelPremove();
  if (m === 'play') {
    setLive(false);
    batchCtrl?.abort();
  } else {
    // a Maia move arriving now would yank the review back to the tip and change the tree under the analysis
    gameToken++;
    maiaThinking = false;
    if (coachState !== 'idle') coachReset();
  }
  update();
  if (m === 'play') resumeCoach();
  else startReview();
}

// ---------- avatar ----------

function openAvatar() {
  const dlg = $<HTMLDialogElement>('dlg-avatar');
  let pick = settings.avatar;
  const draw = () => {
    $('avatar-current').innerHTML = avatarHtml(pick, 'big');
    $('avatar-grid').innerHTML = AVATAR_PRESETS.map(
      (v, i) => `<button type="button" data-i="${i}" class="${v === pick ? 'on' : ''}" aria-label="头像 ${i + 1}">${avatarHtml(v)}</button>`,
    ).join('');
  };
  $('avatar-grid').onclick = (e) => {
    const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i;
    if (i === undefined) return;
    pick = AVATAR_PRESETS[Number(i)];
    draw();
  };
  const file = $<HTMLInputElement>('avatar-file');
  $('btn-avatar-photo').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      pick = await avatarFromFile(f);
      draw();
    } catch (err) {
      setStatus(`图片读取失败：${(err as Error).message}`);
    }
  };
  draw();
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok' || pick === settings.avatar) return;
    settings = { ...settings, avatar: pick };
    saveSettings(settings);
    renderPlayers();
    $('set-avatar').innerHTML = avatarHtml(settings.avatar);
  };
  dlg.showModal();
}

function openCoachAvatar() {
  const dlg = $<HTMLDialogElement>('dlg-coach-avatar');
  let pick = settings.coachAvatar;
  const draw = () => {
    $('coach-current').innerHTML = coachAvatarHtml(pick, 'big');
    $('coach-name').textContent = COACHES[pick]?.name ?? '';
    $('coach-grid').innerHTML = COACHES.map(
      (c, i) => `<button type="button" data-i="${i}" class="${i === pick ? 'on' : ''}" aria-label="${c.name}">${coachAvatarHtml(i)}</button>`,
    ).join('');
  };
  $('coach-grid').onclick = (e) => {
    const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i;
    if (i === undefined) return;
    pick = Number(i);
    draw();
  };
  draw();
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok' || pick === settings.coachAvatar) return;
    settings = { ...settings, coachAvatar: pick };
    saveSettings(settings);
    $('set-coach').innerHTML = coachAvatarHtml(settings.coachAvatar);
    update();
  };
  dlg.showModal();
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
  // Engine warmup is now always enabled; keep the legacy setting checked for old backups.
  el('warmup').checked = true;
  const outs = () => {
    const v = Number(el('elo').value);
    (f.elements.namedItem('eloOut') as HTMLOutputElement).value = v < 600 ? `${v}（低于 600 为模型外推）` : String(v);
    (f.elements.namedItem('tempOut') as HTMLOutputElement).value = el('temperature').value;
    (f.elements.namedItem('bsPlayOut') as HTMLOutputElement).value = `${el('boardSizePlay').value}%`;
    (f.elements.namedItem('bsReviewOut') as HTMLOutputElement).value = `${el('boardSizeReview').value}%`;
  };
  const syncFxDetailControls = () => {
    const on = el('boardFx').checked;
    for (const name of ['boardFxBadge', 'boardFxCapture', 'boardFxCheck', 'boardFxMate', 'boardFxArrowStyle']) el(name).disabled = !on;
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
    syncFxDetailControls();
  };
  outs();
  look();
  syncFxDetailControls();
  $('set-avatar').innerHTML = avatarHtml(settings.avatar);
  $('btn-set-avatar').onclick = openAvatar;
  $('set-coach').innerHTML = coachAvatarHtml(settings.coachAvatar);
  $('btn-set-coach').onclick = openCoachAvatar;
  const sf = engines.sf;
  const maia = engines.maia;
  $('env-info').innerHTML =
    (isNative
      ? `引擎：原生（Stockfish C++ / NEON 多线程，Maia ONNX Runtime）　CPU 核心：${navigator.hardwareConcurrency || '?'}<br>`
      : `跨源隔离：${self.crossOriginIsolated ? '✅（多线程可用）' : '❌（单线程）'}<br>` +
        `WebGPU：${'gpu' in navigator ? '✅' : '❌'}　CPU 核心：${navigator.hardwareConcurrency || '?'}<br>`) +
    `Stockfish：${sf ? `${sf.lite ? '轻量' : '满血'} · ${sf.multiThreaded ? sf.threads + ' 线程' : '单线程'}` : '未加载'}　` +
    `Maia：${maia ? `${maia.model}${isNative ? ' · ' + (maia.provider === 'coreml' ? 'CoreML' : 'CPU') : ''}` : '未加载'}<br>` +
    `视口：${innerWidth}×${innerHeight}　屏幕：${window.screen.width}×${window.screen.height}${document.documentElement.classList.contains('letterbox') ? '（底部已补偿）' : ''}<br>` +
    `${layoutDiag()}<br>` +
    `版本：${__APP_VERSION__}`;
  dlg.returnValue = '';
  // the rating can move while the dialog is open (a finished game's analysis completes): only an edit counts
  const openElo = settings.elo;
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const old = settings;
    const num = (n: string) => Number(el(n).value);
    const eloEdited = num('elo') !== openElo;
    settings = {
      ...old,
      model: el('model').value as Settings['model'],
      elo: eloEdited ? num('elo') : old.elo,
      autoElo: el('autoElo').checked,
      // a manually chosen rating restarts the fast early calibration
      ratedGames: eloEdited ? 0 : old.ratedGames,
      color: el('color').value as Settings['color'],
      temperature: num('temperature'),
      backend: el('backend').value as Settings['backend'],
      useHistory: el('useHistory').checked,
      thinkDelay: el('thinkDelay').checked,
      sfMovetime: Math.max(100, num('sfMovetime') || 1000),
      sfThreads: Math.max(1, num('sfThreads') || 1),
      sfHash: Math.max(16, num('sfHash') || 64),
      sfLite: el('sfLite').value === 'true',
      ecoAnalysis: el('ecoAnalysis').checked,
      lowMemory: el('lowMemory').checked,
      warmup: true,
      sound: el('sound').checked,
      soundTheme: el('soundTheme').value,
      haptics: el('haptics').checked,
      boardTheme: el('boardTheme').value,
      customLight: el('customLight').value,
      customDark: el('customDark').value,
      pieceSet: el('pieceSet').value,
      premove: el('premove').checked,
      boardFx: el('boardFx').checked,
      boardFxBadge: el('boardFxBadge').checked,
      boardFxCapture: el('boardFxCapture').checked,
      boardFxCheck: el('boardFxCheck').checked,
      boardFxMate: el('boardFxMate').checked,
      boardFxArrowStyle: el('boardFxArrowStyle').value as Settings['boardFxArrowStyle'],
      boardSizePlay: num('boardSizePlay'),
      boardSizeReview: num('boardSizeReview'),
      reviewOpponent: el('reviewOpponent').checked,
      opponentTalk: el('opponentTalk').checked,
      opponentPersonality: el('opponentPersonality').value as Settings['opponentPersonality'],
    };
    applySettings(old);
  };
  dlg.showModal();
}

function applyBoardSize() {
  const s = document.documentElement.style;
  s.setProperty('--bs-play', String(settings.boardSizePlay / 100));
  s.setProperty('--bs-review', String(settings.boardSizeReview / 100));
  if (cg) requestAnimationFrame(() => cg.redrawAll());
}

function applySettings(old: Settings) {
  saveSettings(settings);
  configureSound(settings.sound, settings.haptics, settings.soundTheme);
  applyAppearance(settings.boardTheme, settings.customLight, settings.customDark, settings.pieceSet);
  applyBoardSize();
  const sfChanged = old.sfThreads !== settings.sfThreads || old.sfHash !== settings.sfHash || old.sfLite !== settings.sfLite;
  const evalChanged = old.sfMovetime !== settings.sfMovetime || old.sfLite !== settings.sfLite || old.ecoAnalysis !== settings.ecoAnalysis;
  const humanChanged = old.elo !== settings.elo || old.model !== settings.model || old.useHistory !== settings.useHistory;
  // searches started under the old settings would write stale results into the cleared annotations
  if (sfChanged || evalChanged) {
    batchCtrl?.abort();
    liveCtrl?.abort();
  }
  if (sfChanged) engines.unloadSf();
  if (old.model !== settings.model || old.backend !== settings.backend) engines.unloadMaia();
  if (humanChanged) clearAnn('human');
  if (evalChanged) clearAnn('eval', 'threat', 'live');
  if (!settings.premove) cg.cancelPremove();
  applyFx();
  const inReview = mode === 'review' && screen === 'game';
  // the batch skips positions that still have an eval, so restarting it only fills what is missing
  if (inReview && (sfChanged || evalChanged || old.reviewOpponent !== settings.reviewOpponent)) void analyseGame();
  else if (inReview && humanChanged && liveOn) void runLive();
  update();
  renderHome();
}

// ---------- PGN ----------

const JUDGE_NAG: Partial<Record<Judgement, number>> = { brilliant: 3, great: 1, inaccuracy: 6, mistake: 2, miss: 2, blunder: 4 };

function gameHeaders(): Record<string, string> {
  const d = new Date(gameDate);
  const p = (n: number) => String(n).padStart(2, '0');
  if (imported && headers) return { ...headers, Result: result || '*' };
  if (imported) return { Event: '?', Site: '?', Date: '????.??.??', White: '?', Black: '?', Result: result || '*' };
  const elo = String(gameElo ?? settings.elo);
  const name = `Maia-3 ${gameModel}`;
  const h: Record<string, string> = {
    Event: coachOn ? 'Maia Coach Game' : 'Maia Game',
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
  truncated?: boolean;
}

function parseOne(t: string): Parsed | string {
  try {
    const p = parsePgn<Ann>(t);
    return { tree: p.tree, headers: p.headers, result: p.result, truncated: p.truncated };
  } catch (err) {
    return (err as Error).message;
  }
}

/** FEN, or every game of a (multi-game) PGN; a string on failure. */
function parseInput(text: string): Parsed[] | string {
  const t = text.trim();
  if (!t) return '内容为空';
  try {
    return [{ tree: new GameTree<Ann>(new Chess(t).fen()), headers: {}, result: '*' }];
  } catch {
    /* not a FEN */
  }
  const parts = splitPgn(t);
  const games: Parsed[] = [];
  let firstErr = '';
  for (const part of parts.slice(0, 500)) {
    const p = parseOne(part);
    if (typeof p === 'string') firstErr ||= p;
    else games.push(p);
  }
  return games.length ? games : firstErr || '没有找到着法';
}

/** Lets the user pick one game of a multi-game PGN. */
function pickGame(games: Parsed[]): Promise<Parsed | null> {
  if (games.length === 1) return Promise.resolve(games[0]);
  return new Promise((resolve) => {
    const dlg = $<HTMLDialogElement>('dlg-branch');
    $('branch-title').textContent = `PGN 里有 ${games.length} 局，选择一局`;
    const list = $('branch-list');
    list.innerHTML = games
      .map((g, i) => {
        const h = g.headers;
        const name = `${h.White ?? '?'} - ${h.Black ?? '?'}`;
        const sub = [h.Event, h.Date, g.result !== '*' ? g.result : '', `${Math.ceil(g.tree.mainline().length / 2)} 回合`].filter(Boolean).join(' · ');
        return `<button data-i="${i}"><b>${escapeHtml(name)}</b><span class="muted">${escapeHtml(sub)}</span></button>`;
      })
      .join('');
    let picked: Parsed | null = null;
    list.onclick = (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.i;
      if (i === undefined) return;
      picked = games[Number(i)];
      dlg.close();
    };
    dlg.onclose = () => {
      dlg.onclose = null;
      resolve(picked);
    };
    dlg.showModal();
  });
}

function loadImported(p: Parsed) {
  tree = p.tree;
  node = tree.root;
  gameId = newGameId();
  gameDate = Date.now();
  gameElo = undefined;
  eloAfter = undefined;
  assists = emptyAssists();
  rating = undefined;
  ratePending = false;
  abandoned = false;
  peakUserMoves = 0;
  maiaFailed = false;
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
  resetAnalysisStatus();
  resetTransient();
}

/** Starts a new game against Maia from `fen`; the user takes `color` (default: side to move). */
function playFrom(fens: string[], color?: Color) {
  const fen = fens[fens.length - 1];
  if (terminalOf(fens)) {
    setStatus('该局面对局已结束，无法继续对弈');
    return false;
  }
  return newGame(fen, color ?? turnOf(fen));
}

function openPgnImport() {
  const dlg = $<HTMLDialogElement>('dlg-pgn');
  const f = dlg.querySelector('form')!;
  dlg.returnValue = '';
  dlg.onclose = async () => {
    const v = dlg.returnValue;
    if (v !== 'ok' && v !== 'play') return;
    const games = parseInput((f.elements.namedItem('pgn') as HTMLTextAreaElement).value);
    if (typeof games === 'string') {
      setStatus('无法解析 PGN/FEN：' + games);
      return;
    }
    const p = await pickGame(games);
    if (!p) return;
    if (p.truncated) setStatus('PGN 含空着（--），空着之后的那段变化已略过');
    if (v === 'play') {
      const side = (f.elements.namedItem('playAs') as HTMLSelectElement).value;
      const end = p.tree.mainline();
      if (playFrom(end.map((n) => n.fen), side === 'w' || side === 'b' ? side : undefined)) showScreen('game');
      return;
    }
    if (!leaveGame()) return;
    gameToken++;
    maiaThinking = false;
    batchCtrl?.abort();
    loadImported(p);
    saveGame();
    setMode('review');
    openReport();
    showScreen('game');
  };
  dlg.showModal();
}

// ---------- backup ----------

function currentData(): BackupData {
  return { settings, history, mistakes: loadMistakes(), puzzles: loadProgress() };
}

async function exportBackup() {
  flushRating();
  saveGame();
  const text = JSON.stringify(makeBackup(currentData(), `${isNative ? 'ios' : 'web'} ${__APP_VERSION__}`));
  try {
    const r = await shareFile(backupFileName(), text, 'application/json');
    if (r !== 'cancelled') {
      safeSet(BACKUP_AT_KEY, String(Date.now()));
      setStatus(r === 'downloaded' ? '备份文件已下载' : '备份已导出');
      renderHome();
    }
  } catch (err) {
    setStatus('导出失败：' + (err as Error).message);
  }
}

async function importBackup() {
  let text: string | null;
  try {
    text = await pickFile('.json,application/json');
  } catch (err) {
    setStatus('读取文件失败：' + (err as Error).message);
    return;
  }
  if (!text) return;
  let parsed;
  try {
    parsed = parseBackup(text);
  } catch (err) {
    setStatus((err as Error).message);
    return;
  }
  const inc = parsed.data;
  const replace = !confirm(
    `备份包含 ${inc.history.length} 局对局、${inc.mistakes.length} 道错题、${inc.puzzles.games} 道已做谜题。\n\n` +
      '点「确定」合并到当前数据（推荐，重复的会自动去重）；点「取消」选择是否覆盖。',
  );
  if (replace && !confirm('用备份完全覆盖当前的设置、历史、错题本和谜题进度？此操作不可撤销。')) return;
  const d = replace ? inc : mergeBackup(currentData(), inc);
  const old = settings;
  settings = d.settings;
  history = d.history;
  // every store is written even if one fails, so as much as fits is kept
  const saved = [saveHistory(history), setMistakes(d.mistakes), setDeletedMistakes(d.deletedMistakes ?? []), setProgress(d.puzzles)];
  applySettings(old);
  if (saved.includes(false)) {
    // a toast vanishes in seconds; losing data on the next reload deserves a dialog
    alert('导入未完整保存：本机存储空间不足，刷新后部分数据会丢失。请清理一些历史对局后重新导入。');
    return;
  }
  setStatus(`已${replace ? '覆盖' : '合并'}导入${parsed.skipped ? `（${parsed.skipped} 条损坏的记录已跳过）` : ''}`);
}

/** All finished games (newest first) as one PGN file. */
async function exportAllPgn() {
  if (!history.length) {
    setStatus('还没有已完成的对局');
    return;
  }
  const out: string[] = [];
  for (const g of history) {
    try {
      const t = GameTree.deserialize(g.startFen, g.tree);
      const d = new Date(g.date);
      const p = (n: number) => String(n).padStart(2, '0');
      const name = `Maia-3 ${g.model ?? ''}`.trim();
      const h: Record<string, string> = g.imported && g.headers
        ? { ...g.headers }
        : {
            Event: g.coach ? 'Maia Coach Game' : 'Maia Game',
            Site: 'Maia Coach',
            Date: `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`,
            White: g.userColor === 'w' ? '我' : name,
            Black: g.userColor === 'b' ? '我' : name,
            [g.userColor === 'w' ? 'BlackElo' : 'WhiteElo']: String(g.elo ?? ''),
            TimeControl: pgnTimeControl(timeControlOf(g.tc)),
          };
      h.Result = g.result || '*';
      out.push(treeToPgn(t, h));
    } catch {
      /* skip unreadable records */
    }
  }
  try {
    await shareFile(backupFileName().replace('backup', 'games').replace('.json', '.pgn'), out.join('\n'), 'application/x-chess-pgn');
  } catch (err) {
    setStatus('导出失败：' + (err as Error).message);
  }
}

const BACKUP_AT_KEY = 'maia-coach.backupAt';
/** localStorage can throw (blocked site data, some WebView policies); the home screen must still render */
const backupAt = () => {
  try {
    return Number(localStorage.getItem(BACKUP_AT_KEY) || 0);
  } catch {
    return 0;
  }
};

function openData() {
  const dlg = $<HTMLDialogElement>('dlg-data');
  const at = backupAt();
  $('data-info').textContent =
    `本机数据：${history.length} 局对局 · ${loadMistakes().length} 道错题 · ${loadProgress().games} 道已做谜题。` +
    (at ? `上次导出备份：${new Date(at).toLocaleString()}` : '还没有导出过备份。');
  $('btn-backup-export').onclick = () => void exportBackup();
  $('btn-backup-import').onclick = () => {
    dlg.close();
    void importBackup();
  };
  $('btn-pgn-all').onclick = () => void exportAllPgn();
  dlg.showModal();
}

// ---------- training ----------

const trainerCtx: TrainerCtx = {
  show: () => showScreen('train'),
  close: () => showScreen('home'),
  elo: () => settings.elo,
  askPromotion,
};

// ---------- home ----------

let homeCg: Api;

function setHomeTab(tab: HomeTab) {
  homeTab = tab;
  document.querySelectorAll<HTMLButtonElement>('[data-home-tab]').forEach((button) => {
    const active = button.dataset.homeTab === tab;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll<HTMLElement>('[data-home-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.homePanel === tab);
  });
}

function renderHome() {
  const elo = $<HTMLInputElement>('home-elo');
  elo.value = String(settings.elo);
  $('home-elo-val').textContent = settings.autoElo ? `${settings.elo} · 自动` : String(settings.elo);
  document.querySelectorAll<HTMLButtonElement>('#home-color button').forEach((b) => b.classList.toggle('active', b.dataset.color === settings.color));
  document.querySelectorAll<HTMLButtonElement>('#home-type button').forEach((b) => b.classList.toggle('active', b.dataset.type === settings.gameType));
  $<HTMLSelectElement>('home-tc').value = settings.timeControl;
  $('home-coach-desc').textContent = settings.gameType === 'coach' ? '走出' + JUDGEMENT_INFO[settings.coachLevel].label + '时暂停讲解，可重走' : '无提示，自由对弈';
  const t = tip();
  const has = t !== tree.root;
  const canContinue = has && result === '' && !imported;
  const btn = $<HTMLButtonElement>('btn-continue');
  const play = $<HTMLButtonElement>('btn-play');
  btn.disabled = !has;
  btn.classList.toggle('primary', canContinue);
  btn.classList.toggle('big', canContinue);
  btn.classList.toggle('resume-primary', canContinue);
  play.classList.toggle('primary', !canContinue);
  play.classList.toggle('big', !canContinue);
  $('continue-title').textContent = canContinue ? '继续对局' : '上一局';
  const tc = clock ? `${tcId} · ` : '';
  $('continue-sub').textContent = has ? `${coachOn ? '教练 · ' : ''}${tc}${Math.ceil(t.ply / 2)} 回合 · ${result || '进行中'}` : '暂无';
  const s = computeStats(history).all;
  $('history-sub').textContent = history.length ? `${history.length} 局${s.games ? ` · 得分 ${s.score.toFixed(0)}%` : ''}` : '暂无';
  $('puzzle-sub').textContent = puzzleSummary();
  $('mistake-sub').textContent = notebookSummary();
  const at = backupAt();
  // remind to back up once there is something worth keeping and the last backup is old
  $('btn-data').classList.toggle('remind', history.length >= 5 && Date.now() - at > 14 * 86_400_000);
  homeCg?.set({ fen: t.fen, orientation: userColor === 'w' ? 'white' : 'black', lastMove: undefined });
  setHomeTab(homeTab);
}

let startingGame = false;

function setEngineLoading(show: boolean) {
  const page = $('engine-loading');
  page.classList.toggle('hidden', !show);
  page.setAttribute('aria-hidden', show ? 'false' : 'true');
}

/** Engine preload is intentionally invisible at startup, but starting a game waits for it. */
function startWhenReady(button: HTMLButtonElement, start: () => void) {
  if (startingGame) return;
  startingGame = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  setEngineLoading(true);
  const loadingText = '正在加载棋力引擎，请稍候…';
  setStatus(loadingText);
  const keepVisible = window.setInterval(() => setStatus(loadingText), 1800);
  void engines.ensureReady()
    .then(start)
    .catch(() => setStatus('引擎加载失败，请稍后重试'))
    .finally(() => {
      window.clearInterval(keepVisible);
      setEngineLoading(false);
      startingGame = false;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    });
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
        if (g.id !== gameId && !leaveGame()) return;
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
        openReport();
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
  document.querySelectorAll<HTMLButtonElement>('[data-home-tab]').forEach((button) => {
    button.onclick = () => setHomeTab(button.dataset.homeTab as HomeTab);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((b) => {
    b.onclick = () => {
      stopAutoplay();
      const nav = b.dataset.nav;
      if (demo) {
        stepDemo(nav === 'first' ? -99 : nav === 'prev' ? -1 : nav === 'next' ? 1 : 99);
        return;
      }
      goto(nav === 'first' ? tree.root : nav === 'prev' ? node.parent : nav === 'next' ? mainChild(node) : lastOfLine());
    };
  });
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => {
    b.onclick = () => setMode(b.dataset.tab as 'play' | 'review');
  });
  document.querySelectorAll<HTMLButtonElement>('dialog [data-close]').forEach((b) => {
    b.onclick = () => b.closest('dialog')!.close();
  });
  // iOS：长对话框滚动的惯性还没停时，第一次点按钮只会停下滚动、不触发 click（于是要点两次）。
  // 用未移动的 touchend 直接提交，preventDefault 避免随后的 click 再提交一次。
  document.querySelectorAll<HTMLButtonElement>('form[method="dialog"] button[value]').forEach((b) => {
    let x = 0;
    let y = 0;
    let t = 0;
    b.addEventListener(
      'touchstart',
      (e) => {
        const p = e.touches[0];
        x = p.clientX;
        y = p.clientY;
        t = performance.now();
      },
      { passive: true },
    );
    b.addEventListener('touchend', (e) => {
      const p = e.changedTouches[0];
      if (e.touches.length || b.disabled || !b.form || performance.now() - t > 800 || Math.hypot(p.clientX - x, p.clientY - y) > 10) return;
      e.preventDefault();
      b.form.requestSubmit(b);
    });
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
    startWhenReady($<HTMLButtonElement>('btn-play'), () => {
      if (newGame()) showScreen('game');
    });
  };
  $('btn-continue').onclick = () => {
    startWhenReady($<HTMLButtonElement>('btn-continue'), () => {
      setMode(result === '' && !imported ? 'play' : 'review');
      showScreen('game');
    });
  };
  $('btn-home-import').onclick = () => {
    setHomeTab('data');
    openPgnImport();
  };
  $('btn-history').onclick = () => {
    setHomeTab('data');
    showHistory('list');
  };
  $('btn-puzzles').onclick = () => {
    setHomeTab('train');
    unlockAudio();
    openPuzzles(trainerCtx);
  };
  $('btn-mistakes').onclick = () => {
    setHomeTab('train');
    openNotebook(trainerCtx);
  };
  $('btn-data').onclick = () => {
    setHomeTab('data');
    openData();
  };
  $('btn-menu-data').onclick = fromMenu(openData);
  bindTrainer(trainerCtx);
  $<HTMLInputElement>('home-elo').oninput = (e) => {
    $('home-elo-val').textContent = (e.target as HTMLInputElement).value;
  };
  $<HTMLInputElement>('home-elo').onchange = (e) => saveHomeSettings({ elo: Number((e.target as HTMLInputElement).value), ratedGames: 0 });
  document.querySelectorAll<HTMLButtonElement>('#home-color button').forEach((b) => {
    b.onclick = () => saveHomeSettings({ color: b.dataset.color as Settings['color'] });
  });
  document.querySelectorAll<HTMLButtonElement>('#home-type button').forEach((b) => {
    b.onclick = () => saveHomeSettings({ gameType: b.dataset.type as Settings['gameType'] });
  });
  $('btn-home-coach').onclick = openCoachSettings;
  $('btn-coach').onclick = openCoachSettings;
  $('coach-live').onclick = (e) => {
    if (onDemoClick(e)) return;
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    demo = null;
    if (act === 'reveal') {
      coachReveal = true;
      update();
    } else if (act === 'retry') coachRetry();
    else if (act === 'go') coachContinue();
  };
  $('coach-box').onclick = (e) => void onDemoClick(e);
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
  $('btn-new').onclick = () => {
    menu.close();
    startWhenReady($<HTMLButtonElement>('btn-new'), () => void newGame());
  };
  $('btn-resign').onclick = fromMenu(() => {
    if (result === '' && confirm('确定认输？')) resign();
  });
  $('btn-draw').onclick = fromMenu(() => void offerDraw());
  $('btn-play-here').onclick = () => {
    $<HTMLDialogElement>('dlg-menu').close();
    if (mode === 'play' && result === '' && !imported && tip() !== tree.root && userMovesOf().length < 3 && !confirm('从当前局面开始新对局？当前对局会被替换。')) return;
    startWhenReady($<HTMLButtonElement>('btn-play-here'), () => void playFrom(fensTo(node)));
  };
  $('btn-menu-history').onclick = fromMenu(() => showHistory('list'));
  $('btn-menu-settings').onclick = fromMenu(openSettings);
  $('btn-undo').onclick = undo;
  $('btn-hint').onclick = () => void hint();
  $('btn-undo-m').onclick = undo;
  $('btn-hint-m').onclick = () => void hint();
  $('btn-coach-m').onclick = openCoachSettings;
  for (const id of ['player-top', 'player-bottom'])
    $(id).addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.avatar.pick')) openAvatar();
    });
  $('btn-settings').onclick = openSettings;
  $('btn-engines').onclick = () => openEngines(enginesCtx);
  $('btn-result-review').onclick = () => {
    $<HTMLDialogElement>('dlg-result').close();
    node = tree.root;
    setMode('review');
    openReport();
  };
  $('btn-result-new').onclick = () => {
    $<HTMLDialogElement>('dlg-result').close();
    startWhenReady($<HTMLButtonElement>('btn-result-new'), () => void newGame());
  };
  $('moves').onclick = (e) => {
    const t = e.target as HTMLElement;
    const br = t.closest<HTMLElement>('.br')?.dataset.branch;
    if (br) {
      const p = findNode(tree, Number(br));
      if (p) openBranches(p);
      return;
    }
    const id = t.closest<HTMLElement>('.mv')?.dataset.id;
    if (id) goto(findNode(tree, Number(id)));
  };
  WIDE.addEventListener('change', () => {
    if (screen === 'game') renderMoves();
  });
  $('graph').onclick = (e) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const l = currentLine();
    closeReport();
    goto(l[Math.round(((e.clientX - rect.left) / rect.width) * (l.length - 1))]);
  };
  $('btn-report').onclick = openReport;
  $('btn-report-start').onclick = closeReport;
  $('learning-report-summary').onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-learning-analysis]')) {
      void analyseGame();
      return;
    }
    const jump = Number(t.closest<HTMLElement>('[data-learning-jump]')?.dataset.learningJump);
    if (jump) {
      closeReport();
      const target = findNode(tree, jump);
      if (target) goto(target);
      return;
    }
    const mistake = t.closest<HTMLElement>('[data-learning-mistake]')?.dataset.learningMistake;
    if (mistake) {
      closeReport();
      openMistake(trainerCtx, mistake);
      return;
    }
    const theme = t.closest<HTMLElement>('[data-learning-theme]')?.dataset.learningTheme;
    if (theme) {
      closeReport();
      openPuzzlesForTheme(trainerCtx, theme);
    }
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
    // Alt+← is the browser's back; arrows in a select / input belong to that control
    if (e.altKey || e.ctrlKey || e.metaKey || (e.target as HTMLElement).closest('input, select, textarea, [contenteditable]')) return;
    if (reportOpen) {
      if (e.key === 'Escape' || e.key === 'Enter') closeReport();
      return;
    }
    if (mode === 'review' && e.key === ' ' && !(e.target as HTMLElement).closest('button')) {
      e.preventDefault();
      toggleAutoplay();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) stopAutoplay();
    if (demo) {
      if (e.key === 'ArrowLeft') stepDemo(-1);
      else if (e.key === 'ArrowRight') stepDemo(1);
      else if (e.key === 'Home') stepDemo(-99);
      else if (e.key === 'End') stepDemo(99);
      else if (e.key === 'Escape') stopDemo();
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft') goto(node.parent);
    else if (e.key === 'ArrowRight') goto(mainChild(node));
    else if (e.key === 'Home') goto(tree.root);
    else if (e.key === 'End') goto(lastOfLine());
    else if (mode === 'review' && e.key === '[') jumpReviewIssue(-1);
    else if (mode === 'review' && e.key === ']') jumpReviewIssue(1);
    else if (mode === 'review' && e.key === '{' && splitIssueNav()) jumpReviewIssue(-1, 'opp');
    else if (mode === 'review' && e.key === '}' && splitIssueNav()) jumpReviewIssue(1, 'opp');
  });
  // 对话框里点击包着下拉框/滑块的标签文字时不要激活控件（iOS 会直接弹出选择器）
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const lab = t.closest('dialog label:not(.check)');
    if (lab && !t.closest('input, select, textarea, button')) e.preventDefault();
  });
  installTapHaptics();
  // iOS may suspend audio again after returning from the background; retry on every gesture.
  for (const event of ['pointerdown', 'touchend', 'keydown']) {
    document.addEventListener(event, () => unlockAudio(), { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    syncClock();
    renderClocks();
    if (document.hidden) saveGame();
    if (document.hidden) flushEvals();
    // native engine threads keep running while the app is in the background; don't let the
    // open-ended live search or the whole-game analysis burn battery there (aborted searches
    // aren't cached, and analyseGame skips positions already evaluated when it resumes)
    if (document.hidden) {
      pausedBatch = Boolean(batchCtrl && !batchCtrl.signal.aborted);
      batchCtrl?.abort();
      liveCtrl?.abort();
    } else if (pausedBatch && mode === 'review' && screen === 'game') {
      pausedBatch = false;
      void analyseGame();
    } else if (liveOn) void runLive();
  });
  window.addEventListener('pagehide', () => {
    saveGame();
    flushEvals();
  });
}

function coiReloaded(): boolean {
  try {
    return Boolean(sessionStorage.getItem('coi-reloaded'));
  } catch {
    // without session storage a reload can't be remembered: don't risk a reload loop
    return true;
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD || isNative) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  // 首次接管后再刷新；已有控制器时仅提示更新，避免中断对局。
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!navigator.serviceWorker.controller) return;
    if (!hadController) {
      if (self.crossOriginIsolated !== false || self.top !== self || screen !== 'home' || coiReloaded()) return;
      try {
        sessionStorage.setItem('coi-reloaded', '1');
      } catch {
        return;
      }
      location.reload();
      return;
    }
    const dlg = $<HTMLDialogElement>('dlg-update');
    if (!dlg.open) dlg.showModal();
  });
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    })
    .catch((err) => console.warn('Service Worker 注册失败', err));
}

/** 布局诊断：各容器的 top/bottom，用于排查实机上的底部空白 */
function layoutDiag(): string {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;height:100dvh;width:0;padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(probe);
  const dvh = probe.offsetHeight;
  const safeB = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  const rect = (s: string) => {
    const b = document.querySelector(s)?.getBoundingClientRect();
    return b ? `${s} ${Math.round(b.top)}–${Math.round(b.bottom)}` : `${s} ?`;
  };
  const vv = window.visualViewport;
  return (
    `dvh+safeB：${dvh}　safeB：${safeB}　vv：${vv ? `${Math.round(vv.height)}@${Math.round(vv.offsetTop)}` : '?'}　html：${document.documentElement.clientHeight}<br>` +
    ['#app', '#game', '.board-col', '.side', '.toolbar'].map(rect).join('　')
  );
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

/** Tick whenever a dragged piece enters one of its legal (or premove) destination squares. */
function installDragHaptics() {
  if (!isNative) return;
  let lastKey: Key | undefined;
  const onMove = (e: TouchEvent | MouseEvent) => {
    const drag = cg.state.draggable.current;
    if (!drag?.started) {
      lastKey = undefined;
      return;
    }
    const p = 'touches' in e ? e.touches[0] : e;
    if (!p) return;
    const key = cg.getKeyAtDomPos([p.clientX, p.clientY]);
    if (key === lastKey) return;
    lastKey = key;
    if (!key || key === drag.orig) return;
    const legal = cg.state.movable.dests?.get(drag.orig)?.includes(key) || cg.state.premovable.dests?.includes(key);
    if (legal) dragHaptics.tick();
  };
  const onStart = () => {
    lastKey = undefined;
    dragHaptics.start();
  };
  const onEnd = () => {
    lastKey = undefined;
    dragHaptics.end();
  };
  $('board').addEventListener('touchstart', onStart, { capture: true, passive: true });
  $('board').addEventListener('mousedown', onStart, { capture: true, passive: true });
  document.addEventListener('touchmove', onMove, { capture: true, passive: true });
  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  for (const ev of ['touchend', 'touchcancel', 'mouseup']) document.addEventListener(ev, onEnd, { capture: true, passive: true });
}

/** iOS-style interactive back gesture: start at the left edge, follow the finger, and commit on release. */
function installIOSBackGesture() {
  if (!isIOS) return;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let current: HTMLElement | null = null;
  let tracking = false;
  let horizontal = false;

  const clear = (animate: boolean) => {
    if (!current) return;
    const el = current;
    el.classList.toggle('edge-swipe-return', animate);
    el.classList.remove('edge-swipe');
    el.style.removeProperty('transform');
    if (animate) window.setTimeout(() => el.classList.remove('edge-swipe-return'), 220);
    current = null;
    tracking = false;
    horizontal = false;
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || e.touches[0].clientX > 28) return;
      current = document.querySelector<HTMLElement>('.screen.active');
      if (!current || current.id === 'home') {
        current = null;
        return;
      }
      startX = lastX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      horizontal = false;
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking || !current || e.touches.length !== 1) return;
      const p = e.touches[0];
      const dx = p.clientX - startX;
      const dy = p.clientY - startY;
      if (!horizontal && (Math.abs(dy) > 24 || (dx < 8 && Math.abs(dy) > Math.abs(dx) * 1.2))) return clear(true);
      if (dx < 8) return;
      horizontal = true;
      lastX = p.clientX;
      e.preventDefault();
      current.classList.add('edge-swipe');
      current.style.transform = `translateX(${dx}px)`;
    },
    { capture: true, passive: false },
  );
  const end = () => {
    if (!tracking || !current) return;
    const commit = horizontal && lastX - startX >= Math.max(80, innerWidth * 0.22);
    if (!commit) return clear(true);
    const open = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter((d) => d.id !== 'dlg-update').pop();
    if (open) {
      clear(false);
      open.close();
      return;
    }
    const el = current;
    el.classList.remove('edge-swipe');
    el.classList.add('edge-swipe-commit');
    el.style.transform = 'translateX(100%)';
    current = null;
    tracking = false;
    horizontal = false;
    window.setTimeout(() => {
      el.classList.remove('edge-swipe-commit');
      el.style.removeProperty('transform');
      if (location.hash) history_.back();
      else showScreen('home');
    }, 180);
  };
  document.addEventListener('touchend', end, { capture: true, passive: true });
  document.addEventListener('touchcancel', () => clear(true), { capture: true, passive: true });
}

function init() {
  document.documentElement.classList.add(isNative ? 'native' : 'web');
  fitStandalone();
  configureSound(settings.sound, settings.haptics, settings.soundTheme);
  applyAppearance(settings.boardTheme, settings.customLight, settings.customDark, settings.pieceSet);
  applyBoardSize();
  cg = Chessground($('board'), {
    animation: { duration: 180 },
    ranksPosition: 'left',
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: (o, d, meta) => void onUserMove(o, d, meta) } },
    premovable: { enabled: false, showDests: true, events: { set: () => renderPlayInfo(), unset: () => renderPlayInfo() } },
    drawable: { enabled: true, brushes: { ...BRUSHES } as unknown as DrawBrushes },
  });
  homeCg = Chessground($('home-board'), { viewOnly: true, coordinates: false, animation: { enabled: false } });
  fx = new BoardFx($('board').parentElement!, () => cg.state.orientation);
  dodge = new DodgeFx(cg, $('board'));
  applyFx();
  $('btn-autoplay').onclick = toggleAutoplay;
  $<HTMLSelectElement>('autoplay-speed').onchange = (e) => {
    settings = { ...settings, autoplayMs: Number((e.target as HTMLSelectElement).value) };
    saveSettings(settings);
  };
  renderAutoplay();
  void loadBook().then(() => {
    renderMoves();
    renderSummary();
    renderGraph();
    renderCoach();
  });
  // chessground caches the board rect and only refreshes it on scroll/resize; layout shifts without a
  // size change (e.g. the screen slide-in transition) leave it stale and taps land on the wrong square
  const freshBounds = () => cg.state.dom.bounds.clear();
  for (const ev of ['touchstart', 'mousedown']) $('board').addEventListener(ev, freshBounds, { capture: true, passive: true });
  installDragHaptics();
  installIOSBackGesture();
  bind();
  const saved = readJson(GAME_KEY);
  let ok = false;
  try {
    const g = isLegacy(saved) ? saved : sanitizeGame(saved);
    ok = Boolean(g) && loadGame(g!);
  } catch {
    ok = false;
  }
  if (!ok) userColor = settings.color === 'b' ? 'b' : 'w';
  setMode(result === '' && !imported ? 'play' : 'review');
  renderHome();
  setInterval(tickClock, 100);
  // 系统返回键/手势回到主页
  window.addEventListener('popstate', () => {
    const want = location.hash === '#game' ? 'game' : location.hash === '#train' ? 'train' : 'home';
    if (want !== screen) showScreen(want, false);
  });
  if (location.hash === '#game') showScreen('game', false);
  else if (location.hash === '#train') history_.replaceState(null, '', location.pathname + location.search);
  onStorageFull(() => {
    alert('本机存储空间已满，部分数据可能没能保存。请到「数据与备份」导出备份，然后清理一些历史对局。');
  });
  // a rating left pending by closing the app mid-analysis is settled now (performance unknown)
  if (ratePending) flushRating();
  setStatus(isNative ? '就绪（原生引擎）' : self.crossOriginIsolated ? '就绪（多线程）' : '就绪（单线程模式）');

  // mirrors registerServiceWorker: only the first install reloads for COOP/COEP
  const willReload =
    import.meta.env.PROD && !isNative && 'serviceWorker' in navigator && !navigator.serviceWorker.controller && self.crossOriginIsolated === false && self.top === self && screen === 'home' && !coiReloaded();
  const idle = (cb: () => void) => ('requestIdleCallback' in self ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 1500));
  if (!willReload) {
    idle(async () => {
      // download first so warmup reads from the local cache instead of fetching the same files twice
      if (settings.autoOffline && import.meta.env.PROD) await autoOffline(enginesCtx).catch(() => false);
       void engines.warmup(true);
    });
  }
  // Start immediately when no offline package download is needed. With auto-download enabled,
  // the idle task warms the engines after the files are cached so the model is fetched only once.
  if (!settings.autoOffline || !import.meta.env.PROD) void engines.warmup(true).catch(() => {});
  registerServiceWorker();
}

init();
