// Training screen shared by puzzles and the mistake notebook: solve a position move by move.
import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import { pvToSan, sanOf, toMove, turnOf } from '../game/rules';
import { play, soundForSan, unlockAudio } from '../audio/sound';
import { $, escapeHtml } from './dom';
import { THEME_LABEL, acceptsMove, loadIndex, loadProgress, nextPuzzle, recordPuzzle, type Puzzle } from '../training/puzzles';
import { MASTER_STREAK, dueMistakes, gradeMistake, loadMistakes, mistakeStats, removeMistake, type Mistake } from '../training/mistakes';
import { JUDGEMENT_INFO } from '../coach/coach';

interface Task {
  /** position the player solves from (after the opponent's setup move, if any) */
  fen: string;
  /** opponent move shown first (puzzles) */
  setup?: { fen: string; uci: string };
  /** player / opponent moves alternating, starting with the player */
  solution: string[];
  title: string;
  sub: string;
  /** called once with the first-attempt outcome */
  grade(correct: boolean): string;
  next(): void;
}

export interface TrainerCtx {
  /** leave the training screen */
  close(): void;
  show(): void;
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
    movable: { free: false, showDests: true, events: { after: (o, d) => onMove(o, d) } },
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
  task = t;
  step = 0;
  graded = false;
  finished = false;
  $('train-title').textContent = t.title;
  $('train-sub').innerHTML = t.sub;
  $<HTMLButtonElement>('btn-train-next').classList.add('hidden');
  $<HTMLButtonElement>('btn-train-hint').disabled = false;
  $<HTMLButtonElement>('btn-train-solution').disabled = false;
  const you = turnOf(t.fen) === 'w' ? '白棋' : '黑棋';
  if (t.setup) {
    pos = t.setup.fen;
    render();
    info(`你执${you}，等对手走…`);
    setTimeout(() => {
      if (task !== t) return;
      const san = apply(t.setup!.uci);
      render(t.setup!.uci);
      info(`对手走了 <b>${escapeHtml(san)}</b>，轮到你：找出最好的一步`);
    }, 600);
  } else {
    pos = t.fen;
    render();
    info(`你执${you}：找出最好的一步`);
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

function onMove(orig: Key, dest: Key) {
  if (!task || finished) return;
  unlockAudio();
  const want = task.solution[step];
  let uci = orig + dest;
  const c = new Chess(pos);
  const p = c.get(orig as never);
  if (p?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) uci += want?.slice(0, 4) === uci ? want[4] : 'q';
  if (!acceptsMove(pos, uci, want)) {
    play('illegal');
    const msg = grade(false);
    render();
    info(`<b>${escapeHtml(sanOf(pos, uci))}</b> 不对。${msg} 可以再试一次，或者看答案。`, 'bad');
    return;
  }
  apply(uci);
  step++;
  const done = step >= task.solution.length || new Chess(pos).isGameOver();
  if (done) {
    const msg = grade(true);
    finish(`正确！${msg}`, 'good');
    render(uci);
    return;
  }
  render(uci);
  info('对，继续…', 'good');
  const reply = task.solution[step];
  setTimeout(() => {
    if (!task || finished) return;
    apply(reply);
    step++;
    render(reply);
    info('对手应了，继续找最好的一步');
  }, 450);
}

function hint() {
  if (!task || finished) return;
  const want = task.solution[step];
  render(undefined, [{ orig: want.slice(0, 2) as Key, brush: 'green' }]);
  info('提示：动这个子。（用了提示，这题按做错计）', 'warn');
  grade(false);
}

function showSolution() {
  if (!task || finished) return;
  const msg = grade(false);
  const line = pvToSan(pos, task.solution.slice(step), 10);
  const best = task.solution[step];
  finish(`答案：${escapeHtml(line)}。${msg}`, 'warn');
  render(undefined, [{ orig: best.slice(0, 2) as Key, dest: best.slice(2, 4) as Key, brush: 'green' }]);
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
    title: '谜题训练',
    sub: `谜题 ${pz.rating} 分 · 我的谜题等级分 <b>${loadProgress().rating}</b>${themes.length && theme ? ` · ${themes.slice(0, 3).join('、')}` : ''}`,
    grade: (ok) => {
      const d = recordPuzzle(pz, ok);
      $('train-sub').innerHTML = `谜题 ${pz.rating} 分 · ${themes.slice(0, 3).join('、') || '综合'} · 我的谜题等级分 <b>${loadProgress().rating}</b>（${d >= 0 ? '+' : ''}${d}）`;
      return ok ? `谜题等级分 +${d}。` : `谜题等级分 ${d}。`;
    },
    next: () => void nextPz(),
  };
}

async function nextPz() {
  info('加载谜题…');
  try {
    const pz = await nextPuzzle(theme);
    if (!pz) {
      info('这个主题的谜题都做过了，换个主题试试。');
      return;
    }
    start(puzzleTask(pz));
  } catch (err) {
    info(`谜题库加载失败：${escapeHtml((err as Error).message)}`, 'bad');
  }
}

async function renderThemes() {
  const sel = $<HTMLSelectElement>('train-theme');
  if (sel.options.length > 1) return;
  try {
    const idx = await loadIndex();
    const opts = Object.entries(THEME_LABEL)
      .filter(([k]) => (idx.themes[k] ?? 0) >= 50)
      .map(([k, v]) => `<option value="${k}">${v}（${idx.themes[k]}）</option>`);
    sel.insertAdjacentHTML('beforeend', opts.join(''));
  } catch {
    /* shown when the first puzzle fails to load */
  }
}

export function openPuzzles(c: TrainerCtx) {
  ctx = c;
  $('train').dataset.kind = 'puzzle';
  ctx.show();
  void renderThemes();
  void nextPz();
}

// ---------- mistakes ----------

function mistakeTask(m: Mistake): Task {
  const info_ = JUDGEMENT_INFO[m.judgement];
  const d = new Date(m.date);
  return {
    fen: m.fen,
    solution: [m.best],
    title: '错题重练',
    sub: `${d.getMonth() + 1}月${d.getDate()}日的对局 · 当时走了 <b style="color:${info_.color}">${escapeHtml(m.playedSan)}</b>（${info_.label}：${escapeHtml(m.tagLabel)}）· 剩 ${queue.length} 题`,
    grade: (ok) => {
      gradeMistake(m.id, ok);
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
    task = null;
    ctx.close();
  };
  $('btn-train-hint').onclick = hint;
  $('btn-train-solution').onclick = showSolution;
  $('btn-train-next').onclick = () => task?.next();
  $<HTMLSelectElement>('train-theme').onchange = (e) => {
    theme = (e.target as HTMLSelectElement).value || null;
    void nextPz();
  };
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
