import { $, escapeHtml } from './dom';
import { computeStats, mainlineLength, outcomeOf, type Outcome, type StoredGame, type Tally } from '../game/history';
import { END_REASON_TEXT } from '../game/rules';
import { TIME_CONTROLS } from '../game/clock';
import { assistCount } from '../game/rating';

export interface HistoryCtx {
  games(): StoredGame[];
  open(g: StoredGame): void;
  remove(id: string): void;
  clear(): void;
}

const OUTCOME_TEXT: Record<Outcome, string> = { win: '胜', draw: '和', loss: '负' };

function fmtDate(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function opponent(g: StoredGame) {
  if (g.imported) {
    const h = g.headers ?? {};
    return escapeHtml(`${h.White ?? '?'} - ${h.Black ?? '?'}`);
  }
  return `Maia ${g.elo ?? '?'}`;
}

function listHtml(games: StoredGame[]) {
  if (!games.length) return '<p class="muted">还没有已完成的对局。下完一局后会自动保存在这里。</p>';
  return games
    .map((g) => {
      const o = outcomeOf(g);
      const tc = TIME_CONTROLS.find((t) => t.id === g.tc && t.tc)?.id;
      const playerBefore = g.playerElo ?? g.elo;
      const meta = [
        g.userColor === 'w' ? '执白' : '执黑',
        `${Math.ceil(mainlineLength(g.tree) / 2)} 回合`,
        g.reason ? END_REASON_TEXT[g.reason] : '',
        tc ?? '',
        g.coach ? '教练' : assistCount(g.assists) > 0 ? '辅助练习' : '',
        g.eloAfter !== undefined && playerBefore !== undefined ? `等级分 ${g.eloAfter - playerBefore >= 0 ? '+' : ''}${g.eloAfter - playerBefore}` : '',
      ].filter(Boolean);
      return (
        `<div class="hg" data-id="${escapeHtml(g.id)}">` +
        `<span class="hg-res ${o ?? ''}">${o ? OUTCOME_TEXT[o] : '·'}</span>` +
        `<span class="hg-main"><b>${opponent(g)}</b><small>${fmtDate(g.date)} · ${meta.join(' · ')}</small></span>` +
        `<button type="button" class="hg-del" data-del="${escapeHtml(g.id)}" aria-label="删除">✕</button></div>`
      );
    })
    .join('');
}

function tallyRow(name: string, t: Tally) {
  if (!t.games) return `<tr><th>${name}</th><td colspan="5" class="muted">—</td></tr>`;
  return `<tr><th>${name}</th><td>${t.games}</td><td class="win">${t.win}</td><td>${t.draw}</td><td class="loss">${t.loss}</td><td><b>${t.score.toFixed(0)}%</b></td></tr>`;
}

function statsHtml(games: StoredGame[]) {
  const s = computeStats(games);
  if (!s.all.games) return '<p class="muted">完成几局对局后，这里会显示你的胜率统计。</p>';
  const bar = (t: Tally) =>
    `<div class="wdl"><i class="win" style="flex:${t.win}"></i><i class="draw" style="flex:${t.draw}"></i><i class="loss" style="flex:${t.loss}"></i></div>`;
  const recent = s.recent.map((o) => `<span class="hg-res ${o}">${OUTCOME_TEXT[o]}</span>`).join('');
  const streak = s.streak && s.streak.n > 1 ? `当前 ${s.streak.n} 连${OUTCOME_TEXT[s.streak.kind]}` : '';
  return (
    `<div class="stat-big"><b>${s.all.score.toFixed(0)}%</b><span>得分率 · ${s.all.games} 局</span></div>` +
    bar(s.all) +
    '<table class="stat-table"><tr><th></th><th>局</th><th>胜</th><th>和</th><th>负</th><th>得分</th></tr>' +
    tallyRow('全部', s.all) +
    tallyRow('执白', s.white) +
    tallyRow('执黑', s.black) +
    s.byElo.map((b) => tallyRow(`对 ${b.elo}–${b.elo + 199}`, b.t)).join('') +
    '</table>' +
    `<div class="stat-recent"><span class="muted">最近</span>${recent}<span class="muted">${streak}</span></div>`
  );
}

export function openHistory(ctx: HistoryCtx, tab: 'list' | 'stats' = 'list') {
  const dlg = $<HTMLDialogElement>('dlg-history');
  const body = $('history-body');
  let cur = tab;
  const render = () => {
    const games = ctx.games();
    document.querySelectorAll<HTMLButtonElement>('#history-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.htab === cur));
    body.innerHTML = cur === 'list' ? listHtml(games) : statsHtml(games);
    $<HTMLButtonElement>('btn-history-clear').classList.toggle('hidden', cur !== 'list' || !games.length);
  };
  document.querySelectorAll<HTMLButtonElement>('#history-tabs button').forEach((b) => {
    b.onclick = () => {
      cur = b.dataset.htab as 'list' | 'stats';
      render();
    };
  });
  body.onclick = (e) => {
    const t = e.target as HTMLElement;
    const del = t.closest<HTMLElement>('[data-del]')?.dataset.del;
    if (del) {
      if (confirm('删除这局记录？')) {
        ctx.remove(del);
        render();
      }
      return;
    }
    const id = t.closest<HTMLElement>('.hg')?.dataset.id;
    const g = id && ctx.games().find((x) => x.id === id);
    if (g) {
      dlg.close();
      ctx.open(g);
    }
  };
  $('btn-history-clear').onclick = () => {
    if (confirm('清空全部对局记录？')) {
      ctx.clear();
      render();
    }
  };
  render();
  dlg.showModal();
}
