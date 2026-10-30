import { Chess, type Square } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key, MoveMetadata } from '@lichess-org/chessground/types';
import type { DrawBrushes, DrawShape } from '@lichess-org/chessground/draw';
import '@lichess-org/chessground/assets/chessground.base.css';
import './style.css';

import { type MaiaResult } from './maia/maia';
import { sampleMove } from './maia/sample';
import { recordSamplingDecision } from './maia/sampling-capture';
import { mountMaiaComparison } from './app/maia-comparison';
import { mountSamplingControls } from './app/sampling-ui';
import type { Stockfish, SfLine } from './engine/stockfish';
import { flushEvals, getEval, putEval } from './engine/eval-cache';
import { classify, evalText, JUDGEMENTS, JUDGEMENT_INFO, moveAccuracy, SEVERITY, whiteWinPct, winPct, type Judgement } from './coach/coach';
import { bookReady, inBook, loadBook } from './coach/book';
import { PIECE_NAME, confirmedMotifs, explainMove, hangingSquares as hangingOf, isSacrifice, plainEval, type MoveInsight, type Sides } from './coach/explain';
import { ELO_MAX, ELO_MIN, MAIA_LEVELS, isIOS, loadSettings, saveSettings, type Settings } from './settings';
import { assistCount, computeRating, emptyAssists, type Assists, type RatingInfo } from './game/rating';
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
import { computeStats, loadHistory, newGameId, ratingHistory, sanitizeGame, saveHistory, upsert, type StoredGame } from './game/history';
import { dragHaptics, installTapHaptics } from './audio/haptics';
import { SOUND_THEMES, configureSound, play, previewTheme, soundForSan, unlockAudio, type EndKind } from './audio/sound';
import { $, escapeHtml, setStatus } from './app/dom';
import { BOARD_THEMES, PIECE_SETS, applyAppearance, boardColors, pieceUrl } from './app/appearance';
import { Engines } from './app/engines';
import { autoOffline, openEngines, type EnginesCtx } from './app/engines-ui';
import { AVATAR_PRESETS, avatarFromFile, avatarHtml, coachAvatarHtml } from './app/avatar';
import { findNode, movesHtml } from './app/moves-ui';
import { HANGING_BADGE, HANGING_GLOW, judgeBoardSvg, judgeColor, judgeIcon } from './app/judge-icon';
import { coachArrow } from './app/coach-arrow';
import { BoardFx, moveFxOf, type MoveFx } from './app/fx';
import { DodgeFx } from './app/dodge';
import { openHistory } from './app/history-ui';
import { CoachDialogue, type CoachEvent } from './coach-dialogue/dialogue';
import { coachEvents } from './coach-dialogue/events';
import type { SfResult } from './engine/stockfish';
import { installRuntimeLogCapture, runtimeLogText } from './runtime-logs';

installRuntimeLogCapture();

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
let gamePlayerElo: number | undefined = settings.playerElo;
let gameDeviation = settings.ratingDeviation;
let gameStreak = settings.ratingStreak;
let gameTemperature = settings.temperature;
let eloAfter: number | undefined;
let gameModel: Settings['model'] = settings.model;
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
function pickCoachAvatar(selection: number): number {
  // Other portraits remain available as project assets, but Lia is the only active coach.
  void selection;
  return 0;
}

let gameCoachAvatar = pickCoachAvatar(settings.coachAvatar);
let opponentLine = '';
let coachDialogue = new CoachDialogue();
let dialogueCtrl: AbortController | null = null;
let dialogueAnalysis = new WeakMap<Node, SfResult>();
let gameLoading = false;
let gameLoadingFailed = false;
/** Invalidates a pending entry when leaving, changing modes, or starting another game. */
let gameEntry = 0;
let shownResult = '';
let history: StoredGame[] = loadHistory();
/** help used in the current game */
let assists: Assists = emptyAssists();
/** how the rating change of the current (finished) game was computed */
let rating: RatingInfo | undefined;
let abandoned = false;
/** The live game stays in its persistent slot while a historical game is open. */
let suspendedGame: {
  game: StoredGame & { peak: number };
  tree: GameTree<Ann>;
  node: Node;
  dialogue: CoachDialogue;
  line: string;
  flipped: boolean;
} | null = null;

function applyTheme(theme: Settings['theme']) {
  const isLight = theme === 'light';
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = isLight ? '#f5f6f7' : '#262421';
  document.querySelectorAll<HTMLButtonElement>('.theme-toggle').forEach((button) => {
    button.innerHTML = isLight
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2m0 14v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M3 12h2m14 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" /></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.7A8.5 8.5 0 0 1 9.3 3.5 8.5 8.5 0 1 0 20.5 14.7Z" /></svg>';
    const label = isLight ? '切换深色模式' : '切换浅色模式';
    button.title = label;
    button.ariaLabel = label;
  });
}

function toggleTheme() {
  settings = { ...settings, theme: settings.theme === 'light' ? 'dark' : 'light' };
  saveSettings(settings);
  applyTheme(settings.theme);
}

const engines = new Engines(
  () => !imported && gameElo !== undefined ? { ...settings, model: gameModel } : settings,
  // Live engine aids need both engines resident; pure play can stay in low-memory mode.
  () => engineAidsOn() && (screen === 'home' || mode === 'play'),
  () => liveCtrl?.abort(),
);
const getMaia = () => engines.getMaia();
const getSf = () => engines.getSf();
const samplingControls = mountSamplingControls($('sampling-controls'));
const maiaComparison = mountMaiaComparison($('maia-comparison'), {
  context: () => {
    if (screen !== 'game' || mode !== 'review' || reviewTour || pendingReviewGame === gameId || autoplayOn() || document.hidden) return null;
    return {
      identity: `${gameId}|${!imported && gameElo !== undefined ? gameModel : settings.model}|${settings.backend}`,
      fen: node.fen,
      fens: maiaFens(node),
      playerElo: gamePlayerElo ?? settings.playerElo,
      best: node.a.live?.[0]?.pv[0] ?? node.a.eval?.best ?? undefined,
      waiting: gameLoading ? '引擎准备中…' : singleEngine() && ((batchCtrl && !batchCtrl.signal.aborted) || (liveCtrl && !liveCtrl.signal.aborted))
        ? '省内存模式：等待 Stockfish 完成本局面分析后再比较。' : undefined,
    };
  },
  evaluate: async (fen, fens, ratings) => {
    const maia = await getMaia();
    return maia.evaluateMany(ratings.map(rating => ({ chess: new Chess(fen), fens, selfElo: rating, oppoElo: rating })));
  },
});
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
  return {
    id: gameId,
    date: gameDate,
    startFen: tree.root.fen,
    tree: tree.serialize(),
    userColor,
    result,
    reason,
    coachAvatar: gameCoachAvatar,
    elo: imported ? undefined : gameElo,
    playerElo: imported ? undefined : gamePlayerElo,
    ratingDeviation: gameDeviation,
    ratingStreak: gameStreak,
    temperature: gameTemperature,
    eloAfter,
    model: imported ? undefined : gameModel,
    tc: tcId,
    clock: clock && !result ? clock.snapshot(performance.now()) : undefined,
    headers,
    imported: imported || undefined,
    assists: assistCount(assists) ? assists : undefined,
    rating,
    abandoned: abandoned || undefined,
  };
}

function saveGame() {
  const g = stored();
  peakUserMoves = Math.max(peakUserMoves, userMovesOf().length);
  if (!suspendedGame) safeSet(GAME_KEY, JSON.stringify({ ...g, peak: peakUserMoves }));
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
  liveLines = [];
  hintedAt = null;
  opponentLine = '';
  coachDialogue = new CoachDialogue();
  dialogueCtrl?.abort();
  resetAids();
  clearReviewTour();
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
            assists: raw.coach ? { ...emptyAssists(), aids: true } : undefined,
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
    gameCoachAvatar = typeof g.coachAvatar === 'number' ? pickCoachAvatar(g.coachAvatar) : pickCoachAvatar(settings.coachAvatar);
    gameElo = g.elo ?? (imported ? undefined : settings.elo);
    gamePlayerElo = g.playerElo ?? (imported ? undefined : g.elo ?? settings.playerElo);
    gameDeviation = g.ratingDeviation ?? settings.ratingDeviation;
    gameStreak = g.ratingStreak ?? settings.ratingStreak;
    gameTemperature = g.temperature ?? settings.temperature;
    eloAfter = g.eloAfter;
    gameModel = g.model === '5m' || g.model === '79m' ? g.model : g.model === '23m' ? g.model : settings.model;
    assists = g.assists ? { ...g.assists } : emptyAssists();
    rating = g.rating;
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
  if (gameLoading) return false;
  if (mode === 'review') return reviewTour?.phase === 'answer' && node === currentReviewMoment()?.parent && pendingReviewGame !== gameId;
  return node === tip() && result === '' && !maiaThinking && turnOf(node.fen) === userColor;
}

function canPremove(): boolean {
  return !gameLoading && mode === 'play' && settings.premove && node === tip() && result === '' && turnOf(node.fen) !== userColor;
}

/** Arrow brushes for review: green = engine best, blue = what players at your rating usually play, amber = what the previous (bad) move should have been. */
const BRUSHES = {
  best: { key: 'kb', color: '#5fa83f', opacity: 0.85, lineWidth: 7 },
  human: { key: 'kh', color: '#3b82d6', opacity: 0.8, lineWidth: 5 },
  /** after a bad move: what should have been played in the previous position */
  should: { key: 'ks', color: '#d9a43a', opacity: 0.75, lineWidth: 6 },
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
  if (pendingReviewGame === gameId || reviewTour) {
    const current = currentReviewMoment();
    const best = current?.parent?.a.eval?.best;
    return reviewTour?.phase === 'answer' && node === current?.parent && best
      ? [{ uci: best, kind: 'best', text: `最佳 ${sanOf(node.fen, best)}` }]
      : [];
  }
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
  if (h && h.uci !== best) out.push({ uci: h.uci, kind: 'human', text: `${humanElo(node)} 分常走 ${sanOf(node.fen, h.uci)}（${(h.p * 100).toFixed(0)}%）` });
  return out;
}

function arrows(): DrawShape[] {
  const shapes: DrawShape[] = [...hintShapes, ...aidShapes()];
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
  fx.shakeEnabled = settings.boardFxShake;
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
type ReviewTour = {
  line: Node[];
  moments: Node[];
  index: number;
  phase: 'playing' | 'waiting' | 'answer' | 'trailing' | 'done';
  feedback: string;
};
let pendingReviewGame: string | null = null;
let reviewTour: ReviewTour | null = null;

const REVIEW_STEP_MS = 350;
let autoEpoch = 0;

function cancelAutoplayTimer() {
  clearTimeout(autoTimer);
  autoTimer = 0;
  autoEpoch++;
}

function clearReviewTour() {
  cancelAutoplayTimer();
  pendingReviewGame = null;
  reviewTour = null;
  if (demo?.key === 'tour-best') demo = null;
}

/** All analyzed mistakes in game order: every one is a stop-and-answer checkpoint. */
function tourMoments(): Node[] {
  return learningIssues().sort((a, b) => a.ply - b.ply);
}

function startGuidedReview() {
  stopAutoplay();
  clearReviewTour();
  demo = null;
  pendingReviewGame = gameId;
  closeReport(true);
  if (analysisStatus === 'complete') beginReviewTour();
  else {
    update();
    if ((!batchCtrl || batchCtrl.signal.aborted) && !gameLoading) void analyseGame();
  }
}

function beginReviewTour() {
  if (gameLoading || document.hidden || pendingReviewGame !== gameId || mode !== 'review' || screen !== 'game' || analysisStatus !== 'complete') return;
  pendingReviewGame = null;
  const line = gameLine();
  const moments = tourMoments().filter((n) => line.includes(n));
  reviewTour = { line, moments, index: 0, phase: 'playing', feedback: '' };
  demo = null;
  liveCtrl?.abort();
  liveLines = [];
  autoStepping = true;
  goto(line[0], true);
  autoStepping = false;
  scheduleReviewStep();
}

function scheduleReviewStep(delay = REVIEW_STEP_MS) {
  cancelAutoplayTimer();
  if (gameLoading || mode !== 'review' || screen !== 'game' || document.hidden) return renderAutoplay();
  const epoch = autoEpoch;
  const tour = reviewTour;
  const id = gameId;
  autoTimer = window.setTimeout(() => {
    if (epoch !== autoEpoch || tour !== reviewTour || id !== gameId) return;
    autoplayStep();
  }, delay);
  renderAutoplay();
}

function currentReviewMoment(): Node | undefined {
  return reviewTour?.moments[reviewTour.index];
}

function waitForReviewMove() {
  const tour = reviewTour;
  const current = currentReviewMoment();
  if (!tour || !current) return;
  tour.phase = 'waiting';
  const ins = insightOf(current);
  tour.feedback = ins?.problem[0] || '这步棋漏掉了对手的直接威胁。';
  demo = null;
  update();
}

function showReviewBetter() {
  const tour = reviewTour;
  if (!tour || tour.phase === 'done' || tour.phase === 'trailing') return;
  if (tour.phase === 'answer') return advanceReviewMoment();
  const current = currentReviewMoment();
  const best = current?.parent?.a.eval?.best;
  if (!current) return;
  if (!best || best === current.uci) return advanceReviewMoment();
  cancelAutoplayTimer();
  tour.phase = 'answer';
  tour.feedback = '';
  demo = null;
  autoStepping = true;
  goto(current.parent!, true);
  autoStepping = false;
  update();
}

function finishReviewTour() {
  if (!reviewTour) return;
  cancelAutoplayTimer();
  reviewTour.phase = 'done';
  reviewTour.feedback = '';
  demo = null;
  update();
  autoplayEnd();
}

function showTourMoment(index: number) {
  const tour = reviewTour;
  const target = tour?.moments[index];
  if (!tour || !target) return;
  cancelAutoplayTimer();
  tour.index = index;
  tour.phase = 'playing';
  tour.feedback = '';
  demo = null;
  autoStepping = true;
  goto(target.parent ?? target, true);
  autoStepping = false;
  scheduleReviewStep();
}

/** Always leave a tried answer via its recorded move, never via the answer's variation. */
function advanceReviewMoment(schedule = true) {
  const tour = reviewTour;
  const current = currentReviewMoment();
  if (!tour || !current || tour.phase === 'done' || tour.phase === 'trailing') return;
  cancelAutoplayTimer();
  tour.index++;
  tour.phase = tour.index < tour.moments.length ? 'playing' : 'trailing';
  tour.feedback = '';
  demo = null;
  autoStepping = true;
  goto(current, true);
  autoStepping = false;
  if (schedule) scheduleReviewStep();
}

function handleReviewMove(from: Node, uci: string): boolean {
  const tour = reviewTour;
  const current = currentReviewMoment();
  if (!tour || tour.phase !== 'answer' || !current || from !== current.parent) return false;
  const best = current.parent?.a.eval?.best;
  if (!best || uci !== best) {
    play('illegal');
    tour.feedback = '这不是推荐走法，再试一次。';
    update();
    return true;
  }
  const answer = tree.add(from, uci, true);
  if (!answer) return true;
  node = answer;
  tour.feedback = `很好，${answer.san} 是更好的选择。`;
  play(soundForSan(answer.san));
  update();
  scheduleReviewStep();
  return true;
}

function renderReviewProgress() {
  const box = $('review-progress');
  const track = $('review-progress-track');
  const tour = reviewTour;
  if (mode !== 'review' || !tour) {
    box.classList.add('hidden');
    track.innerHTML = '';
    return;
  }
  const total = Math.max(1, tour.line.length - 1);
  const current = Math.min(100, (realOf(node).ply / total) * 100);
  track.innerHTML = `<span class="review-progress-fill" style="width:${current}%"></span>` + tour.moments.map((n, i) => {
    const left = Math.min(100, (n.ply / total) * 100);
    const state = i < tour.index || (i === tour.index && tour.phase === 'answer') ? ' done' : i === tour.index ? ' current' : '';
    return `<i class="review-marker${state}" style="left:${left}%" title="关键节点 ${i + 1}"></i>`;
  }).join('');
  box.classList.remove('hidden');
}

function renderReviewMoment() {
  const box = $('review-moment');
  const visible = mode === 'review' && Boolean(pendingReviewGame === gameId || reviewTour);
  $('game').classList.toggle('guided-review', visible);
  box.classList.toggle('hidden', !visible);
  $('tab-review').classList.toggle('guided-review', visible);
  if (!visible) {
    box.innerHTML = '';
    return;
  }
  const report = '<button data-tour="report" class="tour-report">回到总复盘</button>';
  if (pendingReviewGame === gameId) {
    const failed = analysisStatus === 'failed' || analysisStatus === 'interrupted';
    box.innerHTML = `<b>${failed ? '分析尚未完成' : '正在分析这局棋…'}</b><p>${failed ? escapeHtml(analysisError || '完成分析后再开始互动复盘。') : '准备关键节点…'}</p>${failed ? '<button data-tour="retry" class="primary">重试分析</button>' : ''}${report}`;
    return;
  }
  const tour = reviewTour!;
  const n = currentReviewMoment();
  const answer = tour.phase === 'answer';
  const done = tour.phase === 'done';
  const trailing = tour.phase === 'trailing';
  const actions = `<div class="moment-actions"><button data-tour="prev" class="tour-prev"${tour.index > 0 && tour.moments.length ? '' : ' disabled'}>返回上一个</button><button data-tour="view" class="tour-view primary"${!n || done || trailing ? ' disabled' : ''}>${answer ? '继续' : '查看'}</button><button data-tour="next" class="tour-next"${done ? ' disabled' : ''}>继续下一个</button></div>${report}`;
  if (done || trailing || !n) {
    box.innerHTML = `<b>${done ? '互动复盘完成' : trailing ? '回看关键点后续' : '快速回看棋局'}</b><p>${done ? '本轮回顾已完成。' : trailing ? '沿实战棋谱播放至下一次将军或棋局末尾。' : '本局没有需要停下的关键节点，正在快速播放完整棋谱。'}</p>${actions}`;
    return;
  }
  const r = reviewOf(n)!;
  const ins = insightOf(n);
  const p = n.parent!;
  const waiting = tour.phase === 'waiting';
  const num = `${moveNumberOf(p.fen)}${turnOf(p.fen) === 'w' ? '.' : '…'}`;
  const tag = SEVERITY[r.judgement] ? learningTag(n) : null;
  const problem = ins?.problem[0] || (tag ? `${tag.label}。${checkForTag(tag.id)}` : '这步棋还有更好的选择。');
  const best = p.a.eval?.best;
  const bestSan = best ? escapeHtml(sanOf(p.fen, best)) : '';
  const heading = answer ? `更好的选择：${bestSan}` : `${num} ${escapeHtml(n.san)} · ${JUDGEMENT_INFO[r.judgement].label}`;
  const explanation = answer
    ? `${tour.feedback ? `${escapeHtml(tour.feedback)}<br>` : ''}推荐走 ${bestSan}。${ins?.better[0] || ''}<br>请在棋盘上尝试推荐着法，或点继续回看实战。`
    : waiting ? `${problem}<br>先想一想，再点查看揭示推荐走法。` : '正在快速播放棋局…';
  box.innerHTML = `${waiting ? '' : `<small>${answer ? '请走推荐着法' : '播放中 · 每步 350 毫秒'}</small>`}<h3>${heading}</h3><p>${explanation}</p>${actions}`;
}

function autoplayOn() {
  return autoTimer !== 0 || autoStepping;
}

function stopAutoplay() {
  cancelAutoplayTimer();
  // A cancelled pending analysis must not start a tour later in the background.
  pendingReviewGame = null;
  renderAutoplay();
  if (liveOn && !gameLoading && !document.hidden) void runLive();
}

function autoplayEnd() {
  renderAutoplay();
  if (liveOn) void runLive();
}

function autoplayStep() {
  autoTimer = 0;
  const tour = reviewTour;
  if (gameLoading || mode !== 'review' || screen !== 'game' || document.hidden) return autoplayEnd();
  if (tour) {
    if (tour.phase === 'waiting') return update();
    if (tour.phase === 'answer') advanceReviewMoment(false);
    if (tour.phase === 'done') return autoplayEnd();
    const target = currentReviewMoment();
    if (target === node) return waitForReviewMove();
    const position = tour.line.indexOf(node);
    const next = position >= 0 ? tour.line[position + 1] : undefined;
    if (!next) return finishReviewTour();
    autoStepping = true;
    goto(next, true);
    autoStepping = false;
    play(soundForSan(next.san));
    if (tour.phase === 'trailing' && chessOf(next).inCheck()) return finishReviewTour();
    if (next === tour.line[tour.line.length - 1] && !currentReviewMoment()) return finishReviewTour();
    if (next === target) return waitForReviewMove();
    scheduleReviewStep();
    return;
  }
  if (demo) {
    if (demo.idx >= demo.pv.length) return autoplayEnd();
    stepDemo(1);
  } else {
    const next = mainChild(node);
    if (!next) return autoplayEnd();
    autoStepping = true;
    goto(next, true);
    autoStepping = false;
    play(soundForSan(next.san));
  }
  scheduleReviewStep();
}

function toggleAutoplay() {
  if (autoplayOn()) return stopAutoplay();
  if (gameLoading || pendingReviewGame === gameId || document.hidden) return;
  unlockAudio();
  if (reviewTour) {
    if (reviewTour.phase === 'done') return startGuidedReview();
    if (reviewTour.phase === 'waiting' || reviewTour.phase === 'answer') return;
    scheduleReviewStep();
    liveCtrl?.abort();
    return;
  }
  if (demo ? demo.idx >= demo.pv.length : !mainChild(node)) {
    if (demo) stepDemo(-99);
    else goto(tree.root, true);
  }
  scheduleReviewStep();
  liveCtrl?.abort();
}

function renderAutoplay() {
  const btn = $<HTMLButtonElement>('btn-autoplay');
  btn.disabled = gameLoading || pendingReviewGame === gameId || Boolean(reviewTour && !autoplayOn() && (reviewTour.phase === 'waiting' || reviewTour.phase === 'answer'));
  const on = autoplayOn();
  $('game').classList.toggle('review-autoplay', mode === 'review' && on);
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-label', on ? '暂停' : '自动播放');
  btn.innerHTML = on
    ? '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
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
  if (gameLoading) return;
  unlockAudio();
  const from = node;
  const c = chessOf(from);
  const piece = c.get(orig as Square);
  let uci = orig + dest;
  if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) uci += meta?.premove ? 'q' : await askPromotion(c.turn());
  if (mode === 'review' && reviewTour && handleReviewMove(from, uci)) return;
  if (mode === 'play') {
    if (!playMove(uci)) {
      play('illegal');
      renderBoard();
      return;
    }
    if (!result) void maiaTurn();
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
  dialogueCtrl?.abort();
  opponentLine = '';
}

/** Analyze only when a coach reaction could be played; never block the player's move. */
async function opponentSpeak(n: Node) {
  dialogueCtrl?.abort();
  if (!settings.opponentTalk || imported || mode !== 'play' || screen !== 'game' || !n.parent || !n.uci) return;
  const ctrl = new AbortController();
  dialogueCtrl = ctrl;
  const id = gameId;
  const stale = () => ctrl.signal.aborted || gameId !== id || tip() !== n || node !== n || screen !== 'game' || mode !== 'play' || document.hidden || !settings.opponentTalk;
  const emit = (events: CoachEvent[]) => {
    if (stale()) return;
    const clip = coachDialogue.pick(events, n.ply, performance.now(), gameCoachAvatar);
    if (!clip) return;
    opponentLine = clip.text;
    renderOpponentDialogue();
  };
  let fallback: CoachEvent[] = [];
  try {
    await loadBook();
    if (stale()) return;
    const parent = n.parent;
    let previousMove;
    if (parent.parent && parent.uci) previousMove = new Chess(parent.parent.fen).move(toMove(parent.uci));
    const input = { fen: parent.fen, uci: n.uci, player: userColor, ply: n.ply, inBook: inBook(n.fen), wasInBook: inBook(parent.fen), previousMove };
    const immediate = coachEvents(input);
    fallback = immediate.events;
    if (immediate.events.some(event => event.priority >= 100) || !coachDialogue.ready(n.ply, performance.now(), gameCoachAvatar)) {
      emit(immediate.events);
      return;
    }
    // Avoid swapping out Maia merely to speak in exclusive low-memory browser games.
    const canAnalyse = thermalState < 2 && (isNative || !settings.lowMemory || settings.sfLite || engineAidsOn());
    let before: SfResult | undefined, after: SfResult | undefined;
    if (canAnalyse && !result && new Chess(parent.fen).moves().length > 1) {
      const sf = await getSf();
      if (stale()) return;
      const analyse = async (position: Node, multipv: number): Promise<SfResult> => {
        const official = position.a.eval;
        if (official?.lines.length && (multipv === 1 || official.lines.length >= multipv)) return { bestmove: official.best, lines: official.lines };
        const cached = dialogueAnalysis.get(position);
        if (cached && (multipv === 1 || cached.lines.length >= multipv)) return cached;
        const value = await sf.analyse(tree.root.fen, { moves: movesTo(position), movetime: 180, depth: 12, multipv, signal: ctrl.signal });
        if (!stale()) dialogueAnalysis.set(position, value);
        return value;
      };
      before = await analyse(parent, 2);
      if (stale()) return;
      after = await analyse(n, 1);
      if (stale()) return;
    }
    const reaction = coachEvents({ ...input, before, after });
    if (reaction.playerWin !== undefined && coachDialogue.observe(reaction.playerWin, reaction.accuratePlayerMove, gameCoachAvatar)) {
      reaction.events.push({ category: 'comeback', actor: 'player', priority: 87 });
    }
    emit(reaction.events);
  } catch (err) {
    if (!stale()) {
      console.warn('角色事件分析未完成', err);
      emit(fallback);
    }
  }
}

function humanElo(n: Node): number {
  return turnOf(n.fen) === userColor ? gamePlayerElo ?? settings.playerElo : gameElo ?? settings.elo;
}

async function maiaEval(n: Node): Promise<MaiaResult> {
  if (n.a.human) return n.a.human;
  const m = await getMaia();
  const res = await m.evaluate(chessOf(n), maiaFens(n), humanElo(n), turnOf(n.fen) === userColor ? gameElo ?? settings.elo : gamePlayerElo ?? settings.playerElo);
  n.a.human = res;
  return res;
}

/** Plays `uci` at the end of the game (either side). */
function playMove(uci: string): boolean {
  if (result || gameLoading) return false;
  const parent = tip();
  const mover = turnOf(parent.fen);
  dialogueCtrl?.abort();
  const now = performance.now();
  if (clock && clock.time(mover, now) <= 0) {
    flag(mover);
    return false;
  }
  const next = tree.add(parent, uci);
  if (!next) return false;
  resetAids();
  if (mover === userColor) recordAssistance();
  tree.makeMainline(next);
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
  void opponentSpeak(next);
  update();
  void prepareAids();
  return true;
}

function endGame(res: string, why: EndReason) {
  result = res;
  reason = why;
  gameToken++;
  maiaThinking = false;
  clock?.stop(performance.now());
  cg.cancelPremove();
  resetAids();
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

/** Eligible ratings require a formal game from the standard start. */
function ratingEnabled(): boolean {
  return !imported && gameElo !== undefined && gamePlayerElo !== undefined && tree.root.fen === START_FEN;
}

function rateable(): boolean {
  if (!ratingEnabled()) return false;
  return Math.max(peakUserMoves, userMovesOf().length) >= 1 || reason === 'resign';
}

/** Settle once at game end; review analysis can never change a rating. */
function startRating() {
  if (rating || eloAfter !== undefined || !rateable() || assistCount(assists)) return;
  // A backup restore or a manually changed starting estimate must not be overwritten by an older game.
  if (settings.playerElo !== gamePlayerElo || settings.ratingDeviation !== gameDeviation || settings.ratingStreak !== gameStreak) return;
  const score = result === '1/2-1/2' ? 0.5 : (result === '1-0') === (userColor === 'w') ? 1 : 0;
  rating = computeRating({ result: score, playerElo: gamePlayerElo!, opponentElo: gameElo!, deviation: gameDeviation, streak: gameStreak, abandoned });
  eloAfter = rating.playerAfter;
  settings = {
    ...settings,
    playerElo: eloAfter,
    ratingDeviation: rating.rdAfter,
    ratingStreak: rating.streak,
    ratedGames: settings.ratedGames + 1,
  };
  saveSettings(settings);
  renderRatingResult();
  if (screen === 'home') renderHome();
}

/**
 * Replacing an unfinished game (new game or another position): after a few moves it
 * counts as a resignation so a bad position can't be escaped for free. Returns false if cancelled.
 */
function leaveGame(): boolean {
  restoreSuspendedGame();
  if (result || imported || (tip() === tree.root && !peakUserMoves)) return true;
  const moved = Math.max(peakUserMoves, userMovesOf().length);
  if (moved < 3 || !rateable()) return true;
  if (!confirm(assistCount(assists) ? '当前练习还没下完。离开会按认输记录，但不影响棋力或对手难度，确定吗？' : '当前对局还没下完。离开会按认输记录并计算棋力分，确定吗？')) return false;
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
  if (gameLoading || screen !== 'game' || mode !== 'play' || result !== '' || turnOf(t.fen) === userColor) return;
  if (attempt === 0) maiaFailed = false;
  const token = ++gameToken;
  maiaThinking = true;
  update();
  let retry = false;
  try {
    const t0 = performance.now();
    const res = await maiaEval(t);
    if (token !== gameToken || mode !== 'play' || screen !== 'game') return;
    const pick = sampleMove(res.moves, gameTemperature, 1);
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
      if (settings.samplingCapture) {
        const captured = recordSamplingDecision({
          committed: true, gameId, model: gameModel,
          selfElo: humanElo(t), oppoElo: gamePlayerElo ?? settings.playerElo,
          fen: t.fen, temperature: gameTemperature, topP: 1,
          moves: res.moves, chosen: pick.uci, ms: res.ms, wdl: res.wdl,
        });
        if (!captured.ok) setStatus(`落子已完成；${captured.error}`);
      }
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
      else void prepareAids();
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
  gamePlayerElo = settings.playerElo;
  gameDeviation = settings.ratingDeviation;
  gameStreak = settings.ratingStreak;
  gameTemperature = settings.temperature;
  eloAfter = undefined;
  gameModel = settings.model;
  result = '';
  reason = undefined;
  imported = false;
  headers = undefined;
  assists = emptyAssists();
  rating = undefined;
  abandoned = false;
  peakUserMoves = 0;
  maiaFailed = false;
  resetAnalysisStatus();
  tcId = settings.timeControl;
  const tc = timeControlOf(tcId);
  clock = tc ? new ChessClock(tc) : null;
  if (clock) tree.root.clock = [...clock.remaining];
  if (assistanceOn()) assists.aids = true;
  gameCoachAvatar = pickCoachAvatar(settings.coachAvatar);
  resetTransient();
  cg.cancelPremove();
  play('start');
  saveGame();
  setMode('play');
  return true;
}

let hintedAt: Node | null = null;
let assistWarned = '';

/** Confirm once before a rated game becomes an assisted practice session. */
function assistOk(what: string): boolean {
  const willRate = ratingEnabled();
  if (!willRate || assistCount(assists) || assistWarned === gameId) return true;
  if (!confirm(`使用${what}后，本局转为辅助练习，不再改变棋力分。继续吗？`)) return false;
  assistWarned = gameId;
  return true;
}

function undo() {
  const t = tip();
  if (gameLoading || t === tree.root || mode !== 'play') return;
  if (result) {
    setStatus('对局已结束，不能悔棋');
    return;
  }
  if (!assistOk('悔棋')) return;
  clearOpponentLine();
  gameToken++;
  maiaThinking = false;
  let target: Node = t;
  do target = target.parent!;
  while (target.parent && turnOf(target.fen) !== userColor);
  resetAids();
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
  void prepareAids();
}

async function hint() {
  const t = tip();
  if (gameLoading || screen !== 'game' || result !== '' || mode !== 'play') return;
  // A hint is for the user's move, never Maia's reply.
  if (turnOf(t.fen) !== userColor || maiaThinking) return;
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
    renderPlayInfo();
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
      text += `\n${humanElo(t)} 分棋手最常走：` + h.moves.slice(0, 3).map((x) => `${sanOf(t.fen, x.uci)} ${(x.p * 100).toFixed(0)}%`).join('，');
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
  if (!clock || result || gameLoading || maiaFailed || screen !== 'game' || mode !== 'play' || document.hidden) return null;
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
  if (ms === null) return { text: '', active: false, low: false };
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

async function evalNode(s: Stockfish, n: Node, signal: AbortSignal, effort: 'scan' | 'full' = 'full', force = false) {
  if (n.a.eval && !force) return;
  // the FEN includes the move counters, so a repetition (scored as a draw) rarely shares a key
  const scan = effort === 'scan';
  const key = `${evalSig()}${scan ? '|scan' : ''}|${n.fen}`;
  const hit = getEval(key);
  if (hit) {
    n.a.eval = posEvalFrom(n, hit.line ? [hit.line] : [], hit.best);
    return;
  }
  const r = await s.analyse(tree.root.fen, {
    moves: movesTo(n),
    movetime: scan ? 180 : settings.sfMovetime,
    depth: scan ? 12 : depthCap('eval'),
    signal,
  });
  if (signal.aborted) return;
  // no bestmove on a live position means the engine died mid-search; don't cache a fake "½"
  if (!r.bestmove && !chessOf(n).isGameOver()) return;
  n.a.eval = posEvalFrom(n, r.lines, r.bestmove);
  // a search shortened by overheating isn't representative
  if (thermalState < 2) putEval(key, { line: r.lines[0] ?? null, best: r.bestmove });
}

/** Review mode quickly scans the game, deepens its three main issues, then starts live analysis. */
function startReview() {
  if (gameLoading || mode !== 'review' || screen !== 'game' || document.hidden) return;
  liveOn = true;
  if (analysisStatus === 'complete') {
    beginReviewTour();
    return;
  }
  if (!batchCtrl || batchCtrl.signal.aborted) void analyseGame();
}

async function analyseGame() {
  if (gameLoading || mode !== 'review' || screen !== 'game' || document.hidden) return;
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
      await evalNode(s, nodes[i], ctrl.signal, 'scan');
      if (ctrl.signal.aborted) return;
      analysisDone = nodes.filter((x) => Boolean(x.a.eval)).length;
      setFill(((i + 1) / n) * 100);
      if (nodes[i] === node || i % 4 === 0) update();
    }
    // aborted during the last position: the game (and `result`) may already be another one
    if (ctrl.signal.aborted) return;
    const focus = learningIssues().slice(0, 3);
    const deepen = [...new Set(focus.flatMap((x) => [x.parent, x]).filter((x): x is Node => Boolean(x)))];
    analysisTotal = n + deepen.length;
    renderReportHint();
    for (const [i, position] of deepen.entries()) {
      if (ctrl.signal.aborted) return;
      if (!s.alive) throw new Error('Stockfish 中途退出');
      await evalNode(s, position, ctrl.signal, 'full', true);
      if (ctrl.signal.aborted) return;
      analysisDone = n + i + 1;
      setFill((analysisDone / analysisTotal) * 100);
      update();
    }
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
    if (analysisStatus === 'complete') beginReviewTour();
  }
}

/**
 * Maia's "what players at your level play here" for the shown position and the move that led to
 * it, computed when a position is viewed rather than for the whole game up front.
 */
async function reviewHuman() {
  if (gameLoading || mode !== 'review' || screen !== 'game' || document.hidden || autoplayOn()) return;
  // a single resident engine: loading Maia now would evict Stockfish mid-search
  const busy = (batchCtrl && !batchCtrl.signal.aborted) || (liveCtrl && !liveCtrl.signal.aborted);
  if (singleEngine() && busy) return;
  const n = node;
  const want = [n.parent && showMove(n) ? n.parent : null, showSide(n) && !chessOf(n).isGameOver() ? n : null];
  const todo = want.filter((x): x is Node => Boolean(x) && !x!.a.human);
  if (!todo.length) return;
  // Answers belong to this game's locked ratings and model, even if next-game settings change.
  const sig = () => `${gameId}|${gameElo}|${gamePlayerElo}|${gameModel}`;
  const asked = sig();
  try {
    const m = await getMaia();
    const res = await m.evaluateMany(todo.map((x) => ({ chess: chessOf(x), fens: maiaFens(x), selfElo: humanElo(x), oppoElo: turnOf(x.fen) === userColor ? gameElo ?? settings.elo : gamePlayerElo ?? settings.playerElo })));
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
  if (gameLoading || screen !== 'game' || document.hidden || reviewTour || pendingReviewGame === gameId) return;
  // with a single resident engine, Maia must wait until the live search is done
  const early = !singleEngine();
  if (early) void reviewHuman();
  await liveSearch();
  if (!early) void reviewHuman();
  maiaComparison.update();
}

async function liveSearch() {
  liveCtrl?.abort();
  liveLines = [];
  renderLines();
  if (gameLoading || screen !== 'game' || !liveOn || mode !== 'review' || (batchCtrl && !batchCtrl.signal.aborted)) return;
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
  const theme = themesForTag(s.tag, settings.playerElo).find((t) => THEME_LABEL[t]);
  const trend = s.recent > s.previous ? `近 30 天出现 ${s.recent} 次，比之前 30 天更多` : `近 30 天出现 ${s.recent} 次`;
  return { label: s.label, tag: s.tag, theme, reason: trend };
}

function renderLearningSummary() {
  const box = $('learning-report-summary');
  if (mode === 'review' && gameLine().length && analysisStatus !== 'complete') {
    const retry = analysisStatus === 'interrupted' || analysisStatus === 'failed';
    const detail = analysisStatus === 'running' ? '先快速检查整局，再深入分析最值得学习的几个问题。' : analysisStatus === 'idle' ? '正在准备复盘分析。' : analysisError || '分析没有覆盖整局，暂不生成最终结论。';
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
          const themes = themesForTag(tag.id, settings.playerElo).filter((t) => THEME_LABEL[t]);
          const saved = loadMistakes().find((m) => m.gameId === gameId && m.id === `${gameId}:${n.ply}`);
          const theme = themes[0];
          // Locally generated insights contain HTML for highlighted SAN moves, as in the coach panel.
          const explanation = insight?.problem.length ? insight.problem.join('；') : escapeHtml(`这步棋被归类为“${tag.label}”。${checkForTag(tag.id)}`);
          return (
            `<div class="learning-issue"><div class="learning-issue-head"><b>${i + 1}. ${escapeHtml(n.san)} · ${escapeHtml(JUDGEMENT_INFO[r.judgement].label)}</b>` +
            `<span>${escapeHtml(tag.label)}</span></div><p>${explanation}</p>` +
            `<p>行棋方胜率 ${r.before.toFixed(0)}% → ${r.after.toFixed(0)}%</p>` +
            (best && best !== n.uci ? `<p><b>更好的着法：${escapeHtml(sanOf(n.parent!.fen, best))}</b>${insight?.better.length ? ` · ${insight.better.join('；')}` : ' · Stockfish 在当前分析深度下更倾向这步棋'}</p>` : '') +
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
    ? `<p><b>${escapeHtml(good.n.san)}</b> · ${goodPraise || '这步棋符合 Stockfish 当前分析的优秀选择。'}</p>`
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
      closeReport(true);
      goto(target);
    };
  });
}

let reportOpen = false;
let returnToReport = false;

function renderBackTarget() {
  const label = returnToReport ? '返回复盘结果' : '返回主页';
  $('btn-back').title = label;
  $('btn-back').setAttribute('aria-label', label);
}

function backToReport(): boolean {
  if (screen !== 'game' || mode !== 'review' || !returnToReport) return false;
  openReport();
  return true;
}

function openReport() {
  stopAutoplay();
  clearReviewTour();
  renderReviewMoment();
  renderReviewProgress();
  renderAutoplay();
  reportOpen = true;
  returnToReport = false;
  renderBackTarget();
  $('report').classList.remove('hidden');
  renderReportHint();
}

function closeReport(returnOnBack = false) {
  reportOpen = false;
  returnToReport = returnOnBack;
  renderBackTarget();
  $('report').classList.add('hidden');
}

function renderReportHint() {
  const analysing = Boolean(batchCtrl && !batchCtrl.signal.aborted);
  const empty = $('summary').dataset.empty === 'true';
  const hint = $('report-hint');
  if (analysing || analysisStatus === 'running') {
    hint.textContent = analysisTotal
      ? `快速检查整局并深入分析重点问题… ${analysisDone}/${analysisTotal}`
      : '正在准备复盘…';
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
  if (mode !== 'review') {
    box.innerHTML = '';
    return;
  }
  if (pendingReviewGame === gameId || reviewTour) {
    box.innerHTML = '';
    return;
  }
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
        `<div class="human">${humanElo(p)} 分棋手在此常走：` +
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
let demo: { fen: string; pv: string[]; idx: number; key: string; anchor: Node; mode: string } | null = null;

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
  demo = { fen, pv: ok, idx: 0, key, anchor: node, mode };
  stepDemo(1);
}

/** Leaving the demonstration's position, mode or screen cancels it. */
function validateDemo() {
  if (demo && (demo.anchor !== node || demo.mode !== mode || screen !== 'game')) demo = null;
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

function resetAids() {
  prepCtrl?.abort();
  prepCtrl = null;
  prep = null;
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

/** Optional analysis never blocks a move or pauses the clock. */
async function prepareAids() {
  const t = tip();
  if (gameLoading || !engineAidsOn() || screen !== 'game' || mode !== 'play' || result || prep?.node === t) return;
  resetAids();
  const ctrl = new AbortController();
  prepCtrl = ctrl;
  const p = (async () => {
    try {
      const s = await getSf();
      if (ctrl.signal.aborted) return;
      await evalNode(s, t, ctrl.signal);
      if (ctrl.signal.aborted || tip() !== t || mode !== 'play' || screen !== 'game') return;
      update();
      if (settings.aidThreats && turnOf(t.fen) === userColor) {
        await computeThreat(s, t, ctrl.signal);
        if (!ctrl.signal.aborted && tip() === t) update();
      }
    } catch (err) {
      if (!ctrl.signal.aborted) setStatus('辅助分析暂不可用：' + (err as Error).message);
    }
  })();
  prep = { node: t, p };
}

function setGameLoading(loading: boolean, failed = false) {
  gameLoading = loading;
  gameLoadingFailed = loading && failed;
  const notice = $('engine-loading');
  notice.classList.toggle('hidden', !gameLoadingFailed);
  notice.classList.toggle('failed', gameLoadingFailed);
  $('engine-loading-title').textContent = '引擎暂时未能就绪';
  $('engine-loading-note').textContent = '请重试，或返回首页稍后再来';
  $('btn-engine-retry').classList.toggle('hidden', !gameLoadingFailed);
  $('game').setAttribute('aria-busy', String(loading && !failed));
  renderPlayInfo();
  syncClock();
}

/** All entry points reuse the startup load; never start a clock or a move before it finishes. */
function resumeGame() {
  const entry = ++gameEntry;
  if (screen !== 'game') return;
  const review = mode === 'review';
  if (!engines.readyForGame(review, engineAidsOn())) {
    setGameLoading(true);
    update();
    void engines.prepareGame(review, engineAidsOn(), () => entry === gameEntry).then(() => {
      if (entry !== gameEntry) return;
      setGameLoading(false);
      update();
      runGame();
    }).catch((err) => {
      if (entry !== gameEntry) return;
      console.warn('对局引擎加载失败', err);
      setGameLoading(true, true);
    });
    return;
  }
  setGameLoading(false);
  runGame();
}

function runGame() {
  if (gameLoading || screen !== 'game' || document.hidden) return;
  if (mode === 'review') return startReview();
  recordAssistance();
  void maiaTurn();
  void prepareAids();
}

/** User pieces that are attacked and either undefended or attacked by something cheaper. */
let hangingMemo: { fen: string; color: Color; out: Square[] } | null = null;
function hangingSquares(n: Node): Square[] {
  if (hangingMemo?.fen !== n.fen || hangingMemo.color !== userColor) hangingMemo = { fen: n.fen, color: userColor, out: hangingOf(n.fen, userColor) };
  return hangingMemo.out;
}

function engineAidsOn(s = settings): boolean {
  return s.aidWinPct || s.aidEval || s.aidThreats || s.aidBest;
}

function assistanceOn(s = settings): boolean {
  return engineAidsOn(s) || s.aidHanging;
}

function recordAssistance() {
  if (result || imported || mode !== 'play' || !assistanceOn()) return;
  if (assists.aids && (!settings.aidBest || assists.best)) return;
  assists.aids = true;
  if (settings.aidBest) assists.best = true;
  saveGame();
}

function aidShapes(): DrawShape[] {
  const t = tip();
  if (mode !== 'play' || node !== t || result || turnOf(t.fen) !== userColor) return [];
  const orientation = (userColor === 'w') !== flipped ? 'white' : 'black';
  const hint = (uci: string, kind: 'threat' | 'best') =>
    coachArrow(uci, chessOf(t).get(uci.slice(0, 2) as Square)?.type === 'n', orientation, kind);
  const out: DrawShape[] = [];
  if (settings.aidThreats && t.a.threat) out.push(hint(t.a.threat.uci, 'threat'));
  if (settings.aidBest && t.a.eval?.best) out.push(hint(t.a.eval.best, 'best'));
  if (settings.aidHanging) {
    for (const sq of hangingSquares(t))
      out.push({ orig: sq as Key, customSvg: { html: HANGING_GLOW }, below: true }, { orig: sq as Key, customSvg: { html: HANGING_BADGE } });
  }
  return out;
}

function renderAids() {
  const box = $('play-aids');
  if (mode !== 'play' || node !== tip() || result) {
    box.innerHTML = '';
    return;
  }
  const e = node.a.eval;
  const pct = e ? (userColor === 'w' ? e.white : 100 - e.white) : null;
  box.innerHTML = settings.aidWinPct
    ? `<small title="按引擎评估换算的获胜机会，不是实战预测">我的获胜机会 ${pct === null ? '分析中…' : `${pct.toFixed(0)}%`}</small>`
    : '';
}

function openAidSettings() {
  const dlg = $<HTMLDialogElement>('dlg-aids');
  const f = dlg.querySelector('form')!;
  const keys = ['aidWinPct', 'aidEval', 'aidThreats', 'aidHanging', 'aidBest'] as const;
  const el = (n: string) => f.elements.namedItem(n) as HTMLInputElement;
  for (const k of keys) el(k).checked = settings[k];
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const next = { ...settings };
    for (const k of keys) next[k] = el(k).checked;
    settings = next;
    saveSettings(settings);
    resetAids();
    if (screen === 'game') {
      recordAssistance();
      void prepareAids();
      update();
    }
    renderHome();
  };
  dlg.showModal();
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
  let score = 0;
  const types = ['p', 'n', 'b', 'r', 'q'];
  const taken: Record<string, number> = {};
  for (const t of types) {
    taken[t] = Math.max(0, full[t] - count[opp][t]);
    score += PIECE_VALUE[t] * (count[color][t] - count[opp][t]);
  }
  // Preserve capture order so the right edge is always the latest captured
  // piece, while still accounting for missing pieces in imported positions.
  const captured: string[] = [];
  for (const move of tree.pathTo(n).slice(1)) {
    if (!move.parent || turnOf(move.parent.fen) !== color) continue;
    try {
      const capturedType = chessOf(move.parent).move(toMove(move.uci)).captured;
      if (capturedType) captured.push(capturedType);
    } catch {
      /* Ignore a stale annotation; material totals below remain authoritative. */
    }
  }
  const used: Record<string, number> = {};
  const ordered = captured.filter((t) => {
    used[t] = used[t] ?? 0;
    if (used[t] >= taken[t]) return false;
    used[t]++;
    return true;
  });
  for (const t of types) for (let i = used[t] ?? 0; i < taken[t]; i++) ordered.push(t);
  const pieceClass = opp === 'b' ? 'black' : 'white';
  const html = ordered
    .map(
      (t) =>
        `<img class="cap-piece ${pieceClass}" src="${pieceUrl(settings.pieceSet, opp, t)}" alt="" aria-hidden="true" draggable="false">`,
    )
    .join('');
  return { html, diff: score };
}

/** 我：设置里的头像；Maia：教练形象；导入的对局：默认剪影 */
function sideAvatar(c: Color, cls = ''): string {
  if (imported) return avatarHtml('', cls.replace('pick', ''));
  return c === userColor ? avatarHtml(settings.avatar, cls) : coachAvatarHtml(gameCoachAvatar, cls);
}

function renderPlayers() {
  const oppColor: Color = userColor === 'w' ? 'b' : 'w';
  const card = (who: 'me' | 'maia') => {
    const color = who === 'me' ? userColor : oppColor;
    const m = material(node, color);
    const thinking = who === 'maia' && maiaThinking ? '<span class="dots"><i></i><i></i><i></i></span>' : '';
    const v = clockView(color);
    const clockHtml = clock || node.clock
      ? `<div class="clock${v.active ? ' active' : ''}${v.low ? ' low' : ''} timed" data-clock="${color}">${v.text}</div>`
      : '';
    const maiaScore = who === 'maia' && gameElo !== undefined ? `Maia ${gameElo}` : '';
    return `<div class="player-name">${maiaScore}</div><div class="player-line"><div class="caps ${color === 'w' ? 'by-w' : 'by-b'}"><div class="caps-track">${m.html}</div>${m.diff > 0 ? `<span class="adv">+${m.diff}</span>` : ''}${thinking}</div>${clockHtml}</div>`;
  };
  $('player-top').innerHTML = card(flipped ? 'me' : 'maia');
  $('player-bottom').innerHTML = card(flipped ? 'maia' : 'me');
  // Keep the most recently captured piece at the visible end of its row.
  requestAnimationFrame(() => {
    for (const id of ['player-top', 'player-bottom']) {
      const track = document.querySelector<HTMLElement>(`#${id} .caps-track`);
      if (track) track.scrollLeft = track.scrollWidth;
    }
  });
}

function renderEvalBar() {
  const e = demo?.key === 'tour-best' ? node.parent?.a.eval
    : liveOn && liveLines[0] ? posEvalFrom(node, liveLines, liveLines[0].pv[0]) : node.a.eval;
  const bar = $('evalbar');
  bar.classList.toggle('hidden', mode !== 'review' && !settings.aidEval);
  const white = e?.white ?? 50;
  $('game').classList.toggle('has-eval', mode === 'review' || settings.aidEval);
  const fill = $('evalbar-fill');
  fill.style.width = mode === 'review' ? '100%' : `${white}%`;
  fill.style.setProperty('--white-share', `${white}%`);
  $('evalbar-text').textContent = e?.text ?? '…';
  bar.setAttribute('aria-label', e ? `白方视角评估 ${e.text}` : '正在分析局面');
  bar.setAttribute('aria-valuenow', String(Math.round(white)));
}

function renderPlayInfo() {
  const box = $('play-info');
  if (gameLoading) box.textContent = gameLoadingFailed ? '引擎暂不可用，可重试或返回首页' : '正在准备引擎，棋盘已就绪…';
  else if (result) box.textContent = `对局结束：${resultText()}`;
  else if (maiaThinking) box.textContent = 'Maia 思考中…';
  else if (node !== tip()) box.textContent = '正在查看历史局面';
  else box.textContent = turnOf(node.fen) === userColor ? (cg.state.premovable.current ? '轮到你走（已预走）' : '轮到你走') : '等待 Maia';
}

function renderOpponentDialogue() {
  const box = $('opponent-dialogue');
  const visible = Boolean(opponentLine) && settings.opponentTalk && !imported && mode === 'play' && node === tip();
  box.classList.toggle('show', visible);
  if (!visible) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `${coachAvatarHtml(gameCoachAvatar)}<span class="opponent-line"><span class="opponent-cn">${escapeHtml(opponentLine)}</span></span>`;
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
  renderAutoplay();
  renderReportHint();
  renderReviewMoment();
  renderReviewProgress();
  renderCoach();
  renderVarActions();
  renderLegend();
  renderAids();
  renderLines();
  maiaComparison.update();
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
  if (result && !imported) {
    box.textContent = assistCount(assists) ? '辅助练习：本局不计分' : ratingEnabled() && eloAfter !== undefined ? '本局评级已更新，可在资料中查看走势' : '本局不计分';
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
    clearOpponentLine();
    gameEntry++;
    setGameLoading(false);
    stopAutoplay();
    clearReviewTour();
    gameToken++;
    maiaThinking = false;
    resetAids();
    setLive(false);
    restoreSuspendedGame();
    syncClock();
    saveGame();
    renderHome();
  } else {
    resumeGame();
    requestAnimationFrame(() => {
      if (screen !== 'game') return;
      cg.redrawAll();
      update();
    });
  }
}

const history_ = window.history;

function goto(n: Node | null | undefined, auto = false) {
  if (!auto) {
    stopAutoplay();
    clearReviewTour();
  }
  if (!n || n === node) {
    update();
    return;
  }
  clearOpponentLine();
  node = n;
  hintShapes = [];
  update();
  if (!analyseMissing() && liveOn) void runLive();
}

/** Starts the whole-game analysis when the shown game line (e.g. a PGN variation) has unanalysed positions. */
function analyseMissing(): boolean {
  if (gameLoading || mode !== 'review' || screen !== 'game' || (batchCtrl && !batchCtrl.signal.aborted)) return false;
  if (!gameLine().some((x) => !x.a.eval)) return false;
  void analyseGame();
  return true;
}

function lastOfLine(): Node {
  const l = currentLine();
  return l[l.length - 1];
}

function setMode(m: 'play' | 'review') {
  if (m === 'review' && !result && !imported && ratingEnabled() && !assistCount(assists)) {
    if (!assistOk('局中分析')) return;
    assists.aids = true;
    saveGame();
  }
  const prev = mode;
  mode = m;
  if (m !== 'play') clearOpponentLine();
  stopAutoplay();
  clearReviewTour();
  if (m === 'play' && !tree.isMainline(node)) node = tip();
  if (m === 'play') closeReport();
  else if (prev !== 'review') openReport();
  $('game').dataset.mode = m;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === m));
  $('tab-play').classList.toggle('hidden', m !== 'play');
  $('tab-review').classList.toggle('hidden', m !== 'review');
  cg.cancelPremove();
  resetAids();
  if (m === 'play') {
    setLive(false);
    batchCtrl?.abort();
  } else {
    // a Maia move arriving now would yank the review back to the tip and change the tree under the analysis
    gameToken++;
    maiaThinking = false;
  }
  resumeGame();
  update();
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

// ---------- settings dialog ----------

function openSettings() {
  const dlg = $<HTMLDialogElement>('dlg-settings');
  samplingControls.refresh();
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
    (f.elements.namedItem('tempOut') as HTMLOutputElement).value = el('temperature').value;
    (f.elements.namedItem('bsPlayOut') as HTMLOutputElement).value = `${el('boardSizePlay').value}%`;
    (f.elements.namedItem('bsReviewOut') as HTMLOutputElement).value = `${el('boardSizeReview').value}%`;
  };
  const syncFxDetailControls = () => {
    const on = el('boardFx').checked;
    for (const name of ['boardFxBadge', 'boardFxCapture', 'boardFxCheck', 'boardFxMate', 'boardFxShake']) el(name).disabled = !on;
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
  $('set-coach').innerHTML = `${coachAvatarHtml(0)}<span class="coach-fixed-label">莉亚 · 精准克制</span>`;
  $('btn-export-launch-logs').onclick = async () => {
    const button = $<HTMLButtonElement>('btn-export-launch-logs');
    button.disabled = true;
    try {
      const nativeLogs = isNative ? (await (await import('maia-native')).SoundNative.getLogs()).logs : '';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const result = await shareFile(`maia-coach-launch-logs-${stamp}.txt`, runtimeLogText(nativeLogs), 'text/plain');
      if (result !== 'cancelled') setStatus('已准备本次启动日志');
    } catch (err) {
      console.error('导出启动日志失败', err);
      setStatus('导出日志失败');
    } finally {
      button.disabled = false;
    }
  };
  const sf = engines.sf;
  const maia = engines.maia;
  $('env-info').innerHTML =
    (isNative
      ? `引擎：原生（Stockfish C++ / NEON 多线程，Maia CoreML）　CPU 核心：${navigator.hardwareConcurrency || '?'}<br>`
      : `跨源隔离：${self.crossOriginIsolated ? '✅（多线程可用）' : '❌（单线程）'}<br>` +
        `WebGPU：${'gpu' in navigator ? '✅' : '❌'}　CPU 核心：${navigator.hardwareConcurrency || '?'}<br>`) +
    `Stockfish：${sf ? `${sf.lite ? '轻量' : '满血'} · ${sf.multiThreaded ? sf.threads + ' 线程' : '单线程'}` : '未加载'}　` +
    `Maia：${maia ? `${maia.model}${isNative ? ' · ' + (maia.provider === 'coreml' ? 'CoreML' : 'CPU') : ''}` : '未加载'}<br>` +
    `视口：${innerWidth}×${innerHeight}　屏幕：${window.screen.width}×${window.screen.height}${document.documentElement.classList.contains('letterbox') ? '（底部已补偿）' : ''}<br>` +
    `${layoutDiag()}<br>` +
    `版本：${__APP_VERSION__}`;
  dlg.returnValue = '';
  const openPlayerElo = settings.playerElo;
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const old = settings;
    const num = (n: string) => Number(el(n).value);
    const playerEdited = num('playerElo') !== openPlayerElo;
    settings = {
      ...old,
      model: el('model').value as Settings['model'],
      playerElo: playerEdited ? Math.max(ELO_MIN, Math.min(ELO_MAX, Math.round(num('playerElo')))) : old.playerElo,
      ratingDeviation: playerEdited ? 350 : old.ratingDeviation,
      ratingStreak: playerEdited ? 0 : old.ratingStreak,
      color: el('color').value as Settings['color'],
      temperature: num('temperature'),
      samplingCapture: el('samplingCapture').checked,
      backend: el('backend').value as Settings['backend'],
      useHistory: false,
      thinkDelay: el('thinkDelay').checked,
      sfMovetime: Math.max(100, num('sfMovetime') || 1000),
      sfThreads: Math.max(1, num('sfThreads') || 1),
      sfHash: Math.max(16, num('sfHash') || 64),
      sfLite: el('sfLite').value === 'true',
      ecoAnalysis: el('ecoAnalysis').checked,
      lowMemory: el('lowMemory').checked,
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
      boardFxShake: el('boardFxShake').checked,
      boardSizePlay: num('boardSizePlay'),
      boardSizeReview: num('boardSizeReview'),
      reviewOpponent: el('reviewOpponent').checked,
      opponentTalk: el('opponentTalk').checked,
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
  if (!settings.opponentTalk) clearOpponentLine();
  applyTheme(settings.theme);
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
    dialogueCtrl?.abort();
    resetAids();
    dialogueAnalysis = new WeakMap();
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
  if (sfChanged || evalChanged || old.model !== settings.model || old.backend !== settings.backend || old.lowMemory !== settings.lowMemory) {
    if (screen === 'game') resumeGame();
    else if (screen === 'home') void engines.warmup();
  }
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
    Event: 'Maia Game',
    Site: 'Maia Coach',
    Date: `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`,
    White: userColor === 'w' ? '我' : name,
    Black: userColor === 'b' ? '我' : name,
    Result: result || '*',
  };
  h[userColor === 'w' ? 'BlackElo' : 'WhiteElo'] = elo;
  h[userColor === 'w' ? 'WhiteElo' : 'BlackElo'] = String(gamePlayerElo ?? settings.playerElo);
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
  gamePlayerElo = undefined;
  eloAfter = undefined;
  assists = emptyAssists();
  rating = undefined;
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
            Event: 'Maia Game',
            Site: 'Maia Coach',
            Date: `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`,
            White: g.userColor === 'w' ? '我' : name,
            Black: g.userColor === 'b' ? '我' : name,
            [g.userColor === 'w' ? 'BlackElo' : 'WhiteElo']: String(g.elo ?? ''),
            [g.userColor === 'w' ? 'WhiteElo' : 'BlackElo']: String(g.playerElo ?? g.elo ?? ''),
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
  elo: () => settings.playerElo,
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

function renderProfileRating() {
  const points = ratingHistory(history);
  const current = settings.playerElo;
  const box = $('profile-rating');
  const values = points.map((p) => p.rating);
  const min = Math.min(current, ...values);
  const max = Math.max(current, ...values);
  const range = Math.max(1, max - min);
  const width = 320;
  const height = 92;
  const padX = 8;
  const padY = 12;
  const plotted = points.map((p, i) => {
    const x = points.length === 1 ? width / 2 : padX + (i / (points.length - 1)) * (width - padX * 2);
    const y = height - padY - ((p.rating - min) / range) * (height - padY * 2);
    return { x, y, rating: p.rating };
  });
  const line = plotted.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const chart = points.length
    ? `<svg class="rating-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="我的分数历史走势"><polyline points="${line}" /><g>${plotted.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3" /><text x="${p.x}" y="${Math.max(10, p.y - 7)}" text-anchor="middle">${p.rating}</text>`).join('')}</g></svg>`
    : '<p class="muted">完成计分对局后，这里会显示历史走势。</p>';
  box.innerHTML = `<div class="profile-rating-head"><span><b>我的分数</b><small>${points.length ? `已记录 ${points.length} 局计分对局` : '尚无计分对局'}</small></span><strong>${current}</strong></div>${chart}`;
}

function renderHome() {
  const elo = $<HTMLInputElement>('home-elo');
  elo.value = String(Math.max(0, MAIA_LEVELS.findIndex(level => level === settings.elo)));
  const levelLabel = `Maia ${settings.elo}`;
  elo.setAttribute('aria-valuetext', levelLabel);
  $('home-elo-val').textContent = String(settings.elo);
  document.querySelectorAll<HTMLButtonElement>('#home-color button').forEach((b) => b.classList.toggle('active', b.dataset.color === settings.color));
  $<HTMLSelectElement>('home-tc').value = settings.timeControl;
  const t = tip();
  const has = t !== tree.root;
  const canContinue = has && result === '' && !imported;
  const btn = $<HTMLButtonElement>('btn-continue');
  const play = $<HTMLButtonElement>('btn-play');
  btn.disabled = !has;
  btn.classList.toggle('primary', canContinue);
  play.classList.toggle('primary', !canContinue);
  $('continue-title').textContent = canContinue ? '继续对局' : '上一局';
  const tc = clock ? `${tcId} · ` : '';
  $('continue-sub').textContent = has ? `${tc}${Math.ceil(t.ply / 2)} 回合 · ${result || '进行中'}` : '暂无';
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
        if (!suspendedGame && !result && !imported && g.id !== gameId) {
          clock?.stop(performance.now());
          saveGame();
          suspendedGame = {
            game: { ...stored(), peak: peakUserMoves }, tree, node,
            dialogue: coachDialogue, line: opponentLine, flipped,
          };
        }
        gameToken++;
        maiaThinking = false;
        batchCtrl?.abort();
        resetAids();
        setLive(false);
        if (!loadGame(g)) {
          restoreSuspendedGame();
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

function restoreSuspendedGame() {
  const saved = suspendedGame;
  if (!saved) return;
  gameToken++;
  gameEntry++;
  maiaThinking = false;
  batchCtrl?.abort();
  pausedBatch = false;
  setLive(false);
  if (!loadGame(saved.game)) return;
  tree = saved.tree;
  node = saved.node;
  coachDialogue = saved.dialogue;
  opponentLine = saved.line;
  flipped = saved.flipped;
  suspendedGame = null;
  setMode('play');
  saveGame();
}

// ---------- init ----------

function bind() {
  document.querySelectorAll<HTMLButtonElement>('.theme-toggle').forEach((button) => {
    button.onclick = toggleTheme;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-home-tab]').forEach((button) => {
    button.onclick = () => setHomeTab(button.dataset.homeTab as HomeTab);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((b) => {
    b.onclick = () => {
      stopAutoplay();
      const nav = b.dataset.nav;
      if (reviewTour || pendingReviewGame === gameId) clearReviewTour();
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
    if (newGame()) showScreen('game');
  };
  $('btn-continue').onclick = () => {
    setMode(result === '' && !imported ? 'play' : 'review');
    showScreen('game');
  };
  $('btn-home-import').onclick = () => {
    setHomeTab('data');
    openPgnImport();
  };
  $('btn-history').onclick = () => {
    setHomeTab('data');
    showHistory('list');
  };
  $('btn-engine-retry').onclick = resumeGame;
  $('btn-engine-home').onclick = () => showScreen('home');
  $('btn-puzzles').onclick = () => {
    setHomeTab('train');
    unlockAudio();
    openPuzzles(trainerCtx);
  };
  $('btn-mistakes').onclick = () => {
    setHomeTab('train');
    openNotebook(trainerCtx);
  };
  $('btn-profile-rating').onclick = () => {
    renderProfileRating();
    $<HTMLDialogElement>('dlg-profile-rating').showModal();
  };
  $('btn-data').onclick = () => {
    setHomeTab('data');
    openData();
  };
  $('btn-menu-data').onclick = fromMenu(openData);
  bindTrainer(trainerCtx);
  const eloSlider = $<HTMLInputElement>('home-elo');
  eloSlider.max = String(MAIA_LEVELS.length - 1);
  eloSlider.oninput = () => {
    const level = MAIA_LEVELS[Number(eloSlider.value)];
    if (level !== undefined) saveHomeSettings({ elo: level });
  };
  const ticks = $('home-elo-ticks');
  ticks.replaceChildren(...MAIA_LEVELS.map(() => document.createElement('span')));
  document.querySelectorAll<HTMLButtonElement>('#home-color button').forEach((b) => {
    b.onclick = () => saveHomeSettings({ color: b.dataset.color as Settings['color'] });
  });
  $('btn-aids').onclick = openAidSettings;
  $('coach-box').onclick = (e) => void onDemoClick(e);
  $('var-actions').onclick = (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-va]')?.dataset.va;
    if (act) varAction(act);
  };
  $('btn-back').onclick = () => {
    if (!backToReport()) showScreen('home');
  };
  $('btn-flip').onclick = () => {
    flipped = !flipped;
    update();
  };
  $('btn-menu').onclick = () => {
    const live = mode === 'play' && result === '' && !imported && tip() !== tree.root;
    $<HTMLButtonElement>('btn-resign').disabled = !live;
    $<HTMLButtonElement>('btn-draw').disabled = !live;
    menu.showModal();
  };
  $('btn-new').onclick = () => {
    menu.close();
    newGame();
  };
  $('btn-resign').onclick = fromMenu(() => {
    if (result === '' && confirm('确定认输？')) resign();
  });
  $('btn-draw').onclick = fromMenu(() => void offerDraw());
  $('btn-play-here').onclick = () => {
    $<HTMLDialogElement>('dlg-menu').close();
    if (mode === 'play' && result === '' && !imported && tip() !== tree.root && userMovesOf().length < 3 && !confirm('从当前局面开始新对局？当前对局会被替换。')) return;
    playFrom(fensTo(node));
  };
  $('btn-menu-history').onclick = fromMenu(() => showHistory('list'));
  $('btn-menu-settings').onclick = fromMenu(openSettings);
  $('btn-undo').onclick = undo;
  $('btn-hint').onclick = () => void hint();
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
    startGuidedReview();
  };
  $('btn-result-new').onclick = () => {
    $<HTMLDialogElement>('dlg-result').close();
    newGame();
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
    closeReport(true);
    goto(l[Math.round(((e.clientX - rect.left) / rect.width) * (l.length - 1))]);
  };
  $('btn-report').onclick = openReport;
  $('btn-report-start').onclick = startGuidedReview;
  $('btn-report-free').onclick = () => {
    closeReport(true);
    goto(node);
    $('maia-comparison').querySelector('details')!.open = true;
    maiaComparison.update();
  };
  $('review-moment').onclick = (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tour]');
    const action = button?.dataset.tour;
    if (!action || button?.disabled) return;
    stopAutoplay();
    if (action === 'retry') {
      pendingReviewGame = gameId;
      if (!gameLoading) void analyseGame();
    } else if (action === 'report') openReport();
    else if (reviewTour) {
      if (action === 'view') showReviewBetter();
      else if (action === 'prev') showTourMoment(reviewTour.index - 1);
      else if (action === 'next' && reviewTour.phase !== 'done') {
        if (currentReviewMoment()) advanceReviewMoment();
        else scheduleReviewStep();
      }
    }
  };
  $('learning-report-summary').onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-learning-analysis]')) {
      void analyseGame();
      return;
    }
    const jump = Number(t.closest<HTMLElement>('[data-learning-jump]')?.dataset.learningJump);
    if (jump) {
      const target = findNode(tree, jump);
      if (target) {
        closeReport(true);
        goto(target);
      }
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
      if (e.key === 'Escape' || e.key === 'Enter') closeReport(true);
      return;
    }
    if (mode === 'review' && e.key === ' ' && !(e.target as HTMLElement).closest('button')) {
      e.preventDefault();
      toggleAutoplay();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) stopAutoplay();
    if (reviewTour && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) {
      clearReviewTour();
      if (e.key === 'Escape') {
        update();
        e.preventDefault();
        return;
      }
    }
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
    if (document.hidden) { dialogueCtrl?.abort(); saveGame(); }
    if (document.hidden) flushEvals();
    // native engine threads keep running while the app is in the background; don't let the
    // open-ended live search or the whole-game analysis burn battery there (aborted searches
    // aren't cached, and analyseGame skips positions already evaluated when it resumes)
    if (document.hidden) {
      stopAutoplay();
      resetAids();
      pausedBatch = Boolean(batchCtrl && !batchCtrl.signal.aborted);
      batchCtrl?.abort();
      liveCtrl?.abort();
    } else if (pausedBatch && mode === 'review' && screen === 'game') {
      pausedBatch = false;
      void analyseGame();
    } else if (liveOn) void runLive();
    if (!document.hidden && mode === 'play' && screen === 'game') void prepareAids();
    if (!document.hidden && !gameLoading && screen === 'game') {
      if (mode === 'play' && !maiaThinking && !maiaFailed) void maiaTurn();
      else if (mode === 'review' && analysisStatus === 'idle') startReview();
    }
  });
  window.addEventListener('pagehide', () => {
    cancelAutoplayTimer();
    pendingReviewGame = null;
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
  let preview: HTMLElement | null = null;
  let reportPreview = false;
  let previewInert = false;
  let tracking = false;
  let horizontal = false;
  let settling = false;

  const preparePreview = () => {
    reportPreview = screen === 'game' && mode === 'review' && returnToReport;
    if (reportPreview) {
      // Preview the report without changing the review state until the gesture commits.
      preview = document.createElement('div');
      preview.className = 'screen';
      const header = current!.querySelector('.appbar');
      if (header) preview.append(header.cloneNode(true));
      const report = $('report').cloneNode(true) as HTMLElement;
      report.classList.remove('hidden');
      preview.append(report);
      preview.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      preview.setAttribute('aria-hidden', 'true');
      $('app').append(preview);
    } else {
      preview = $('home');
    }
    previewInert = preview.inert;
    preview.inert = true;
    preview.classList.add('edge-swipe-preview');
    preview.style.transform = 'translateX(-12%)';
    preview.style.opacity = '0.65';
    current!.classList.add('edge-swipe');
  };

  const clear = (commit: boolean, animate = true) => {
    if (!current) return;
    const el = current;
    const underlay = preview;
    const toReport = reportPreview;
    tracking = false;
    horizontal = false;
    settling = true;
    el.classList.remove('edge-swipe');
    const duration = animate && underlay && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 260 : 0;
    if (duration) {
      el.classList.add('edge-swipe-settling');
      underlay!.classList.add('edge-swipe-settling');
    }
    el.style.transform = commit ? 'translateX(100%)' : 'translateX(0)';
    el.style.opacity = commit ? '0' : '1';
    if (underlay) {
      underlay.style.transform = commit ? 'translateX(0)' : 'translateX(-12%)';
      underlay.style.opacity = commit ? '1' : '0.65';
    }
    const finish = () => {
      el.classList.add('edge-swipe-cleanup');
      underlay?.classList.add('edge-swipe-cleanup');
      // Keep both layers in place until the destination is active; no empty frame between pages.
      if (commit && el.classList.contains('active')) {
        if (toReport) backToReport();
        else showScreen('home');
      }
      for (const layer of [el, underlay]) {
        if (!layer) continue;
        layer.classList.remove('edge-swipe', 'edge-swipe-settling', 'edge-swipe-preview');
        layer.style.removeProperty('transform');
        layer.style.removeProperty('opacity');
      }
      if (underlay) {
        underlay.inert = previewInert;
        if (toReport) underlay.remove();
      }
      current = preview = null;
      reportPreview = false;
      requestAnimationFrame(() => {
        el.classList.remove('edge-swipe-cleanup');
        underlay?.classList.remove('edge-swipe-cleanup');
        settling = false;
      });
    };
    if (duration) window.setTimeout(finish, duration);
    else finish();
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      if (settling || tracking || e.touches.length !== 1 || e.touches[0].clientX > 28) return;
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
      if (!tracking || !current) return;
      if (e.touches.length !== 1) return clear(false);
      const p = e.touches[0];
      const dx = p.clientX - startX;
      const dy = p.clientY - startY;
      if (!horizontal && (Math.abs(dy) > 24 || (dx < 8 && Math.abs(dy) > Math.abs(dx) * 1.2))) return clear(false, false);
      if (!horizontal && dx < 8) return;
      if (!horizontal) preparePreview();
      horizontal = true;
      lastX = p.clientX;
      e.preventDefault();
      const progress = Math.max(0, Math.min(1, dx / current.clientWidth));
      current.style.transform = `translateX(${progress * 100}%)`;
      current.style.opacity = String(1 - progress * 0.2);
      preview!.style.transform = `translateX(${-12 * (1 - progress)}%)`;
      preview!.style.opacity = String(0.65 + progress * 0.35);
    },
    { capture: true, passive: false },
  );
  const end = () => {
    if (!tracking || !current) return;
    const commit = horizontal && lastX - startX >= Math.max(80, innerWidth * 0.22);
    if (!commit) return clear(false);
    const open = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter((d) => d.id !== 'dlg-update').pop();
    if (open) {
      clear(false, false);
      open.close();
      return;
    }
    clear(true);
  };
  document.addEventListener('touchend', end, { capture: true, passive: true });
  document.addEventListener('touchcancel', () => clear(false), { capture: true, passive: true });
}

function init() {
  document.documentElement.classList.add(isNative ? 'native' : 'web');
  applyTheme(settings.theme);
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
    if (want !== 'game' && backToReport()) {
      history_.pushState(null, '', '#game');
      return;
    }
    if (want !== screen) showScreen(want, false);
  });
  if (location.hash === '#game') showScreen('game', false);
  else if (location.hash === '#train') history_.replaceState(null, '', location.pathname + location.search);
  onStorageFull(() => {
    alert('本机存储空间已满，部分数据可能没能保存。请到「数据与备份」导出备份，然后清理一些历史对局。');
  });
  setStatus(isNative ? '就绪（原生引擎）' : self.crossOriginIsolated ? '就绪（多线程）' : '就绪（单线程模式）');

  // Prioritise the selected engines over the much larger optional offline package.
  // A direct #game entry has already started the engines needed by that game.
  const ready = screen === 'home' ? engines.warmup() : Promise.resolve();
  void ready.then(() => {
    if (settings.autoOffline && import.meta.env.PROD) void autoOffline(enginesCtx).catch(() => false);
  });
  registerServiceWorker();
}

init();

// Unlock only the selected recording player, directly within a user gesture.
for (const name of ['pointerdown', 'keydown']) document.addEventListener(name, () => {
}, { passive: true });
