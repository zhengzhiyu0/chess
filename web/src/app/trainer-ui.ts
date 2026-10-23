// Training screen shared by puzzles and the mistake notebook: solve a position move by move.
import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import { sanOf, toMove, turnOf, type Color } from '../game/rules';
import { play, soundForSan, unlockAudio } from '../audio/sound';
import { $, escapeHtml } from './dom';
import { THEME_LABEL, acceptsMove, loadIndex, loadProgress, markPuzzleSeen, nextPuzzle, recordPuzzle, type Puzzle } from '../training/puzzles';
import { MASTER_STREAK, dueMistakes, gradeMistake, loadMistakes, mistakeStats, removeMistake, type Mistake } from '../training/mistakes';
import { JUDGEMENT_INFO } from '../coach/coach';
import { confirmedMotifs } from '../coach/explain';
import { SETTLED, THEME_GROUPS, curriculumFor, recommendThemes, trainingLevel } from '../training/recommend';

interface Task {
  /** position the player solves from (after the opponent's setup move, if any) */
  fen: string;
  /** opponent move shown first (puzzles) */
  setup?: { fen: string; uci: string };
  /** player / opponent moves alternating, starting with the player */
  solution: string[];
  /** longer line to demonstrate with the answer (defaults to `solution`) */
  demo?: string[];
  title: string;
  sub: string;
  /** called once with the first-attempt outcome */
  grade(correct: boolean): string;
  /** the position is on the board for the player to solve (after the setup move) */
  shown?(): void;
  next(): void;
}

export interface TrainerCtx {
  /** leave the training screen */
  close(): void;
  show(): void;
  /** the player's game rating */
  elo(): number;
  /** promotion piece picker (q / r / b / n); without it pawns always become queens */
  askPromotion?(color: Color): Promise<string>;
}

let cg: Api | null = null;
let task: Task | null = null;
let pos = '';
let step = 0;
let graded = false;
let finished = false;
let theme: string | null = null;
let queue: Mistake[] = [];
let ctx: TrainerCtx;

function dests(c: Chess): Map<Key, Key[]> {
  const d = new Map<Key, Key[]>();
  for (const m of c.moves({ verbose: true })) {
    const a = d.get(m.from as Key) ?? [];
    a.push(m.to as Key);
    d.set(m.from as Key, a);
  }
  return d;
}

function board(): Api {
  cg ??= Chessground($('train-board'), {
    animation: { duration: 200 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, showDests: true, events: { after: (o, d) => void onMove(o, d) } },
    drawable: { enabled: true },
  });
  return cg;
}

function render(last?: string, shapes: { orig: Key; dest?: Key; brush: string }[] = []) {
  const c = new Chess(pos);
  const turn = c.turn() === 'w' ? 'white' : 'black';
  const mine = task ? turnOf(task.fen) : 'w';
  const canMove = Boolean(task) && !finished && c.turn() === mine;
  board().set({
    fen: pos,
    orientation: mine === 'w' ? 'white' : 'black',
    turnColor: turn,
    check: c.inCheck(),
    lastMove: last ? [last.slice(0, 2) as Key, last.slice(2, 4) as Key] : undefined,
    movable: { color: canMove ? turn : undefined, dests: canMove ? dests(c) : new Map() },
  });
  board().setAutoShapes(shapes);
}

function info(html: string, cls = '') {
  const box = $('train-info');
  box.className = `train-info ${cls}`;
  box.innerHTML = html;
}

function apply(uci: string): string {
  const c = new Chess(pos);
  const m = c.move(toMove(uci));
  pos = c.fen();
  play(soundForSan(m.san));
  return m.san;
}

function start(t: Task) {
  try {
    begin(t);
  } catch (err) {
    // a corrupted task must not block the queue: skip to the next one
    console.warn('训练题数据有误，已跳过', err);
    if (task !== t) return;
    task = null;
    pos = new Chess().fen();
    t.shown?.();
    t.next();
  }
}

function begin(t: Task) {
  task = t;
  step = 0;
  graded = false;
  finished = false;
  $('train-title').textContent = t.title;
  $('train-sub').innerHTML = t.sub;
  $<HTMLButtonElement>('btn-train-next').classList.add('hidden');
  $<HTMLButtonElement>('btn-train-replay').classList.add('hidden');
  demo = null;
  demoToken++;
  $<HTMLButtonElement>('btn-train-hint').disabled = false;
  $<HTMLButtonElement>('btn-train-solution').disabled = false;
  const you = turnOf(t.fen) === 'w' ? '白棋' : '黑棋';
  if (t.setup) {
    pos = t.setup.fen;
    render();
    info(`你执${you}，等对手走…`);
    setTimeout(() => {
      if (task !== t) return;
      let san: string;
      try {
        san = apply(t.setup!.uci);
      } catch (err) {
        console.warn('训练题数据有误，已跳过', err);
        task = null;
        t.shown?.();
        t.next();
        return;
      }
      render(t.setup!.uci);
      info(`对手走了 <b>${escapeHtml(san)}</b>，轮到你：找出最好的一步`);
      t.shown?.();
    }, 600);
  } else {
    pos = t.fen;
    render();
    info(`你执${you}：找出最好的一步`);
    t.shown?.();
  }
}

function grade(correct: boolean): string {
  if (graded || !task) return '';
  graded = true;
  return task.grade(correct);
}

function finish(text: string, cls: string) {
  finished = true;
  $<HTMLButtonElement>('btn-train-next').classList.remove('hidden');
  $<HTMLButtonElement>('btn-train-hint').disabled = true;
  $<HTMLButtonElement>('btn-train-solution').disabled = true;
  info(text, cls);
  render(undefined);
}

async function onMove(orig: Key, dest: Key) {
  if (!task || finished) return;
  const t = task;
  const before = pos;
  unlockAudio();
  let uci = orig + dest;
  const p = new Chess(pos).get(orig as never);
  if (p?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) {
    const piece = ctx.askPromotion ? await ctx.askPromotion(p.color) : 'q';
    // the task may have been left / switched / solved while the picker was open
    if (task !== t || finished || pos !== before) return;
    uci += /^[qrbn]$/.test(piece) ? piece : 'q';
  }
  const want = t.solution[step];
  if (!acceptsMove(pos, uci, want)) {
    play('illegal');
    const msg = grade(false);
    render();
    info(`<b>${escapeHtml(sanOf(pos, uci))}</b> 不对。${msg} 可以再试一次，或者看答案。`, 'bad');
    return;
  }
  apply(uci);
  step++;
  const done = step >= t.solution.length || new Chess(pos).isGameOver();
  if (done) {
    const msg = grade(true);
    finish(`正确！${msg}`, 'good');
    render(uci);
    return;
  }
  render(uci);
  info('对，继续…', 'good');
  const reply = t.solution[step];
  setTimeout(() => {
    if (task !== t || finished) return;
    apply(reply);
    step++;
    render(reply);
    info('对手应了，继续找最好的一步');
  }, 450);
}

/** true only while the player is to move (not during the opponent's setup move or reply delay) */
function myTurn(): boolean {
  return Boolean(task) && !finished && new Chess(pos).turn() === turnOf(task!.fen);
}

function hint() {
  if (!task || !myTurn()) return;
  const want = task.solution[step];
  render(undefined, [{ orig: want.slice(0, 2) as Key, brush: 'green' }]);
  info('提示：动这个子。（用了提示，这题按做错计）', 'warn');
  grade(false);
}

function showSolution() {
  if (!task || !myTurn()) return;
  const msg = grade(false);
  const line = (task.demo && step === 0 ? task.demo : task.solution.slice(step)).slice(0, 10);
  demo = { fen: pos, line, steps: demoSteps(pos, line), msg };
  finish('', 'warn');
  $<HTMLButtonElement>('btn-train-replay').classList.remove('hidden');
  playDemo();
}

// ---------- answer demonstration ----------

interface DemoStep {
  san: string;
  mine: boolean;
  /** why the move works (player moves only) */
  why: string;
}

let demo: { fen: string; line: string[]; steps: DemoStep[]; msg: string } | null = null;
let demoToken = 0;
const DEMO_MS = 1300;

/** SAN plus a short explanation of each player move, using the coach's tactic detection. */
function demoSteps(fen: string, line: string[]): DemoStep[] {
  const c = new Chess(fen);
  const mover = c.turn();
  const fens: string[] = [];
  const sans: string[] = [];
  for (const u of line) {
    fens.push(c.fen());
    try {
      sans.push(c.move(toMove(u)).san);
    } catch {
      break;
    }
  }
  const mates = c.isCheckmate();
  return sans.map((san, i) => {
    const mine = new Chess(fens[i]).turn() === mover;
    let why = '';
    if (mine) {
      const ms = confirmedMotifs(fens[i], line.slice(i, sans.length), '对方的', mates).filter((m) => m.kind !== 'check');
      why = ms[0]?.text ?? '';
      if (!why && /\+$/.test(san)) why = '将军，对方必须应将';
      if (!why && i === 0 && mates) why = '为后面的将杀做准备';
    }
    return { san, mine, why };
  });
}

function demoHtml(cur: number): string {
  if (!demo) return '';
  const items = demo.steps
    .map((s, i) => {
      const cls = i === cur ? 'cur' : i < cur ? 'done' : '';
      const who = s.mine ? '你' : '对手';
      return `<li class="${cls}"><b>${who}：${escapeHtml(s.san)}</b>${s.why ? `<small>${s.why}</small>` : ''}</li>`;
    })
    .join('');
  return `<b>答案演示</b>${demo.msg ? ` <span class="muted">${demo.msg}</span>` : ''}<ol class="demo-steps">${items}</ol>`;
}

function playDemo() {
  if (!demo || !task) return;
  const t = task;
  const token = ++demoToken;
  const d = demo;
  const alive = () => task === t && token === demoToken;
  $<HTMLButtonElement>('btn-train-replay').disabled = true;
  pos = d.fen;
  const arrow = (i: number) => {
    const u = d.line[i];
    return u ? [{ orig: u.slice(0, 2) as Key, dest: u.slice(2, 4) as Key, brush: i % 2 ? 'red' : 'green' }] : [];
  };
  render(undefined, arrow(0));
  info(demoHtml(-1), 'warn');
  let i = 0;
  const tick = () => {
    if (!alive()) return;
    if (i >= d.steps.length) {
      info(demoHtml(d.steps.length), 'warn');
      $<HTMLButtonElement>('btn-train-replay').disabled = false;
      return;
    }
    const u = d.line[i];
    apply(u);
    info(demoHtml(i), 'warn');
    i++;
    render(u, arrow(i));
    setTimeout(tick, DEMO_MS);
  };
  setTimeout(tick, 700);
}

// ---------- puzzles ----------

function puzzleTask(pz: Puzzle): Task {
  const c = new Chess(pz.fen);
  c.move(toMove(pz.moves[0]));
  const themes = pz.themes.filter((t) => THEME_LABEL[t]).map((t) => THEME_LABEL[t]);
  return {
    fen: c.fen(),
    setup: { fen: pz.fen, uci: pz.moves[0] },
    solution: pz.moves.slice(1),
    title: theme ? `谜题 · ${THEME_LABEL[theme]}` : '谜题 · 综合',
    sub: `谜题 ${pz.rating} 分 · 我的谜题等级分 <b>${loadProgress().rating}</b>${themes.length && theme ? ` · ${themes.slice(0, 3).join('、')}` : ''}`,
    grade: (ok) => {
      const d = recordPuzzle(pz, ok);
      $('train-sub').innerHTML = `谜题 ${pz.rating} 分 · ${themes.slice(0, 3).join('、') || '综合'} · 我的谜题等级分 <b>${loadProgress().rating}</b>（${d >= 0 ? '+' : ''}${d}）`;
      return ok ? `谜题等级分 +${d}。` : `谜题等级分 ${d}。`;
    },
    // seen once the opponent's move is played: leaving without answering doesn't bring it back next time
    shown: () => markPuzzleSeen(pz),
    next: () => void nextPz(),
  };
}

async function nextPz() {
  info('加载谜题…');
  try {
    const pz = await nextPuzzle(theme);
    if ($('train').dataset.view !== 'board') return;
    if (!pz) {
      info('这个题型的谜题都做过了，返回换个题型试试。');
      return;
    }
    start(puzzleTask(pz));
  } catch (err) {
    info(`谜题库加载失败：${escapeHtml((err as Error).message)}`, 'bad');
  }
}

function themeStat(t: string): string {
  const [s, f] = loadProgress().byTheme[t] ?? [0, 0];
  return s + f ? `${Math.round((s / (s + f)) * 100)}% · ${s + f} 题` : '未练';
}

function catalogHtml(available: Record<string, number>): string {
  const p = loadProgress();
  const level = trainingLevel(p, ctx.elo());
  const recs = recommendThemes({ progress: p, elo: ctx.elo(), mistakes: mistakeStats(loadMistakes()), available });
  const basis =
    p.games >= SETTLED
      ? `按你的谜题等级分 <b>${p.rating}</b>`
      : `谜题还没做够 ${SETTLED} 题，先按对局等级分 <b>${level}</b>（${curriculumFor(level).name}）`;
  const recHtml = recs.length
    ? recs
        .map(
          (r, i) =>
            `<button type="button" class="pz-rec" data-theme="${r.theme}"><span class="pz-rank">${i + 1}</span>` +
            `<span class="pz-main"><b>${escapeHtml(r.label)}</b><small>${r.reasons.map(escapeHtml).join('；')}</small></span>` +
            `<span class="pz-stat">${themeStat(r.theme)}</span></button>`,
        )
        .join('')
    : '<p class="muted">各题型表现都差不多，继续综合练习就好。</p>';
  const groups = THEME_GROUPS.map((g) => {
    const items = g.themes
      .filter((t) => (available[t] ?? 0) >= 50)
      .map(
        (t) =>
          `<button type="button" class="pz-cat" data-theme="${t}"><b>${THEME_LABEL[t]}</b><small>${themeStat(t)} · 共 ${available[t]}</small></button>`,
      )
      .join('');
    return items ? `<h4>${g.title}</h4><div class="pz-grid">${items}</div>` : '';
  }).join('');
  return (
    `<button type="button" class="primary big" data-theme="">综合练习<small>不限题型 · 难度跟随等级分</small></button>` +
    `<h4>建议优先练</h4><p class="muted pz-basis">${basis}，结合各题型正确率和错题本里的错误类型。</p>` +
    `<div class="pz-recs">${recHtml}</div>` +
    groups
  );
}

async function showCatalog() {
  task = null;
  $('train').dataset.view = 'catalog';
  $('train-title').textContent = '谜题训练';
  const box = $('train-catalog');
  box.scrollTop = 0;
  try {
    box.innerHTML = catalogHtml((await loadIndex()).themes);
  } catch (err) {
    box.innerHTML = `<p class="train-info bad">谜题库加载失败：${escapeHtml((err as Error).message)}</p>`;
  }
}

function startTheme(t: string | null) {
  theme = t;
  $('train').dataset.view = 'board';
  requestAnimationFrame(() => cg?.redrawAll());
  void nextPz();
}

export function openPuzzles(c: TrainerCtx) {
  ctx = c;
  $('train').dataset.kind = 'puzzle';
  ctx.show();
  void showCatalog();
}

// ---------- mistakes ----------

function mistakeTask(m: Mistake): Task {
  const info_ = JUDGEMENT_INFO[m.judgement];
  const d = new Date(m.date);
  return {
    fen: m.fen,
    solution: [m.best],
    demo: m.line[0] === m.best ? m.line.slice(0, 6) : [m.best],
    title: '错题重练',
    sub: `${d.getMonth() + 1}月${d.getDate()}日的对局 · 当时走了 <b style="color:${info_.color}">${escapeHtml(m.playedSan)}</b>（${info_.label}：${escapeHtml(m.tagLabel)}）· 剩 ${queue.length} 题`,
    grade: (ok) => {
      if (!gradeMistake(m.id, ok)) return '还没到复习时间，这次练习不计入掌握进度。';
      const left = loadMistakes().find((x) => x.id === m.id);
      if (!ok) return '这题稍后会再出现。';
      return left?.mastered ? '已连续答对，移出重练队列。' : `再答对 ${MASTER_STREAK - (left?.streak ?? 0)} 次就算掌握。`;
    },
    next: nextMistake,
  };
}

function nextMistake() {
  const m = queue.shift();
  if (!m) {
    task = null;
    finish('今天的错题都练完了。下完新的对局并复盘后，错着会自动收进错题本。', 'good');
    $<HTMLButtonElement>('btn-train-next').classList.add('hidden');
    return;
  }
  start(mistakeTask(m));
}

function startMistakes(list: Mistake[]) {
  queue = list;
  $('train').dataset.kind = 'mistake';
  $('train').dataset.view = 'board';
  ctx.show();
  nextMistake();
}

function notebookHtml(): string {
  const all = loadMistakes();
  if (!all.length) return '<p class="muted">还没有错题。下完对局进入复盘，分析完成后你的错误和漏着会自动收进来。</p>';
  const due = dueMistakes().length;
  const stats = mistakeStats(all);
  const trend = (s: (typeof stats)[number]) =>
    s.recent > s.previous ? '<span class="loss">↑</span>' : s.recent < s.previous ? '<span class="win">↓</span>' : '';
  const rows = stats
    .slice(0, 8)
    .map((s) => `<tr><th>${escapeHtml(s.label)}</th><td>${s.total}</td><td>${s.recent}${trend(s)}</td><td>${s.mastered}</td></tr>`)
    .join('');
  const items = all
    .slice(0, 100)
    .map((m) => {
      const j = JUDGEMENT_INFO[m.judgement];
      const tag = m.mastered ? '已掌握' : m.streak ? `答对 ${m.streak}/${MASTER_STREAK}` : '待练';
      return (
        `<div class="hg" data-mid="${escapeHtml(m.id)}"><span class="hg-res" style="background:${j.color}">${j.symbol}</span>` +
        `<span class="hg-main"><b>${escapeHtml(m.playedSan)} · ${escapeHtml(m.tagLabel)}</b><small>${new Date(m.date).toLocaleDateString()} · ${tag}</small></span>` +
        `<button type="button" class="hg-del" data-mdel="${escapeHtml(m.id)}" aria-label="删除">✕</button></div>`
      );
    })
    .join('');
  return (
    `<button type="button" class="primary big" id="btn-mistake-train"${due ? '' : ' disabled'}>${due ? `开始重练（${due} 题到期）` : '今天没有到期的错题'}</button>` +
    `<h4>最常犯的错误</h4><table class="stat-table"><tr><th></th><th>总数</th><th>近 30 天</th><th>已掌握</th></tr>${rows}</table>` +
    `<p class="muted">↑ 表示近 30 天比之前 30 天更多。点下面任意一题可以单独练。</p>` +
    `<div class="mistake-list">${items}</div>`
  );
}

export function openNotebook(c: TrainerCtx) {
  ctx = c;
  const dlg = $<HTMLDialogElement>('dlg-mistakes');
  const body = $('mistakes-body');
  const draw = () => (body.innerHTML = notebookHtml());
  body.onclick = (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#btn-mistake-train')) {
      dlg.close();
      startMistakes(dueMistakes());
      return;
    }
    const del = t.closest<HTMLElement>('[data-mdel]')?.dataset.mdel;
    if (del) {
      removeMistake(del);
      draw();
      return;
    }
    const id = t.closest<HTMLElement>('[data-mid]')?.dataset.mid;
    const m = id && loadMistakes().find((x) => x.id === id);
    if (m) {
      dlg.close();
      startMistakes([m]);
    }
  };
  draw();
  dlg.showModal();
}

export function bindTrainer(c: TrainerCtx) {
  ctx = c;
  $('btn-train-back').onclick = () => {
    // puzzles: board → category page → home
    if ($('train').dataset.kind === 'puzzle' && $('train').dataset.view === 'board') {
      void showCatalog();
      return;
    }
    task = null;
    ctx.close();
  };
  $('train-catalog').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-theme]');
    if (!b) return;
    unlockAudio();
    startTheme(b.dataset.theme || null);
  };
  // chessground caches the board rect; if it was measured mid slide-in, clicks land on the wrong square
  $('train').addEventListener('transitionend', (e) => {
    if (e.target === e.currentTarget) cg?.redrawAll();
  });
  $('btn-train-hint').onclick = hint;
  $('btn-train-solution').onclick = showSolution;
  $('btn-train-replay').onclick = playDemo;
  $('btn-train-next').onclick = () => task?.next();
}

export function trainerRedraw() {
  cg?.redrawAll();
}

export function puzzleSummary(): string {
  const p = loadProgress();
  return p.games ? `${p.rating} 分 · ${p.games} 题` : '50000 道离线谜题';
}

export function notebookSummary(): string {
  const n = loadMistakes().length;
  if (!n) return '暂无';
  const due = dueMistakes().length;
  return due ? `${due} 题待练` : `${n} 题`;
}
