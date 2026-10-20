import { $, setStatus } from './dom';
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
} from '../offline';
import type { Settings } from '../settings';

export interface EnginesCtx {
  settings(): Settings;
  patchSettings(patch: Partial<Settings>): void;
  warmup(): Promise<void>;
}

const downloads = new Map<PackageId, AbortController>();

async function renderPackages(ctx: EnginesCtx) {
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
      const using = p.id === `maia-${ctx.settings().model}` ? '（当前）' : '';
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
        } else void startDownload(ctx, p);
        await renderPackages(ctx);
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

async function startDownload(ctx: EnginesCtx, p: Package) {
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
    if ($<HTMLDialogElement>('dlg-engines').open) await renderPackages(ctx);
  }
}

async function downloadRecommended(ctx: EnginesCtx) {
  const pkgs = await listPackages();
  const want: PackageId[] = ['core', 'stockfish', `maia-${ctx.settings().model}`];
  // sequential: parallel downloads would only compete for bandwidth
  for (const id of want) {
    const p = pkgs.find((x) => x.id === id);
    if (p && !isComplete(p)) await startDownload(ctx, p);
  }
  if (ctx.settings().warmup) void ctx.warmup();
}

export function openEngines(ctx: EnginesCtx) {
  const dlg = $<HTMLDialogElement>('dlg-engines');
  const chk = $<HTMLInputElement>('chk-warm');
  chk.checked = ctx.settings().warmup;
  chk.onchange = () => ctx.patchSettings({ warmup: chk.checked });
  $('btn-dl-rec').onclick = () => void downloadRecommended(ctx);
  $('btn-warm').onclick = () => void ctx.warmup();
  void loadPrecache().then((ok) => (ok ? pruneStale() : 0));
  void renderPackages(ctx);
  dlg.showModal();
}
