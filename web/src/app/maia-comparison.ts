import { Chess } from 'chess.js';
import type { MaiaResult } from '../maia/maia';
import { toMove } from '../game/rules';

export interface ComparisonContext {
  /** Includes the game/model/backend identity; different engines must not share answers. */
  identity: string;
  fen: string;
  fens: string[];
  playerElo: number;
  best?: string;
  waiting?: string;
}

interface Options {
  context(): ComparisonContext | null;
  evaluate(fen: string, fens: string[], ratings: number[]): Promise<MaiaResult[]>;
}

const RATINGS = [600, 800, 1000, 1200, 1400, 1500, 1600, 1800, 2000, 2200, 2400, 2600];

/** On-demand, equal-rating comparisons using the existing Maia instance, never two model loads. */
export function mountMaiaComparison(host: HTMLElement, options: Options): { update(): void } {
  host.classList.add('maia-comparison');
  host.innerHTML = `<details><summary>比较不同水平的棋手</summary>
    <p class="muted">选择两个 Maia 等级，比较当前局面的原始人类着法预测；不经过对弈随机性调整，也不会改变对手难度。</p>
    <div class="comparison-selects"><label>水平一 <select aria-label="比较水平一"></select></label><label>水平二 <select aria-label="比较水平二"></select></label></div>
    <div class="comparison-result" aria-live="polite"></div>
    <small class="muted">每列双方都使用该列的等级输入。预期得分 = 胜率 + ½ 和棋率，不是纯获胜概率；Maia 等级未与 FIDE / Lichess 实战等级分校准。</small>
  </details>`;
  const details = host.querySelector('details')!;
  const selects = [...host.querySelectorAll('select')];
  const result = host.querySelector<HTMLElement>('.comparison-result')!;
  for (const select of selects) {
    for (const rating of RATINGS) select.add(new Option(String(rating), String(rating)));
  }
  let initialized = false;
  let desired = '';
  let running = false;
  let shown = '';
  let failure = '';
  const cache = new Map<string, MaiaResult[]>();

  function label(fen: string, uci: string): string {
    try { return new Chess(fen).move(toMove(uci)).san; } catch { return uci; }
  }

  function render(context: ComparisonContext, answers: MaiaResult[]) {
    result.replaceChildren();
    const caption = document.createElement('p');
    caption.className = 'comparison-best';
    caption.textContent = `当前${context.fen.split(' ')[1] === 'w' ? '白' : '黑'}方行棋 · Stockfish 最佳：${context.best ? label(context.fen, context.best) : '分析中…'}`;
    result.append(caption);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const text of ['候选走法', ...selects.map(s => `Maia ${s.value}`)]) {
      const th = document.createElement('th');
      th.textContent = text;
      head.append(th);
    }
    const body = table.createTBody();
    const candidates = new Set(answers.flatMap(a => a.moves.slice(0, 3).map(m => m.uci)));
    if (context.best) candidates.add(context.best);
    for (const uci of candidates) {
      const row = body.insertRow();
      row.insertCell().textContent = `${label(context.fen, uci)}${uci === context.best ? ' ★' : ''}`;
      for (const answer of answers) {
        const move = answer.moves.find(m => m.uci === uci);
        row.insertCell().textContent = move ? `${(move.p * 100).toFixed(1)}%` : '—';
      }
    }
    const scoreRow = body.insertRow();
    scoreRow.insertCell().textContent = '行棋方预期得分';
    for (const answer of answers) scoreRow.insertCell().textContent = `${((answer.wdl[0] + answer.wdl[1] / 2) * 100).toFixed(1)}%`;
    result.append(table);
    const note = document.createElement('small');
    note.className = 'muted';
    note.textContent = '列出双方预测前三名及引擎最佳；未列出其他合法走法，因此本表概率不一定合计 100%。';
    result.append(note);
  }

  function update() {
    const context = options.context();
    host.hidden = !context;
    if (!context || !details.open) { desired = ''; return; }
    if (!initialized) {
      const base = RATINGS.reduce((a, b) => Math.abs(b - context.playerElo) < Math.abs(a - context.playerElo) ? b : a);
      selects[0].value = String(base === 2600 ? 2000 : base);
      selects[1].value = String(Math.min(2600, base + 600));
      initialized = true;
    }
    const ratings = selects.map(s => Number(s.value));
    const key = JSON.stringify([context.identity, context.fen, context.fens, ratings]);
    desired = key;
    if (new Chess(context.fen).isGameOver()) {
      result.textContent = '当前局面已结束，没有下一着可比较。';
      shown = '';
      return;
    }
    const cached = cache.get(key);
    if (cached) { render(context, cached); shown = key; return; }
    if (shown !== key) {
      result.textContent = failure === key ? 'Maia 比较失败。' : '正在计算两种水平的人类着法预测…';
      shown = key;
    }
    if (failure === key) {
      if (!result.querySelector('button')) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重试比较';
        retry.onclick = () => { failure = ''; shown = ''; update(); };
        result.append(retry);
      }
      return;
    }
    if (context.waiting) { result.textContent = context.waiting; shown = ''; return; }
    if (running) return;
    running = true;
    const uniqueRatings = [...new Set(ratings)];
    void options.evaluate(context.fen, context.fens, uniqueRatings).then(results => {
      const answers = ratings.map(rating => results[uniqueRatings.indexOf(rating)]);
      cache.set(key, answers);
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
    }).catch(err => {
      console.warn('Maia 双等级比较失败', err);
      failure = key;
    }).finally(() => {
      running = false;
      if (desired) update();
    });
  }
  details.addEventListener('toggle', update);
  for (const select of selects) select.addEventListener('change', update);
  return { update };
}
