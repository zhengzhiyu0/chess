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
import { isNative } from '../native';

export interface EnginesCtx {
  settings(): Settings;
  patchSettings(patch: Partial<Settings>): void;
  warmup(): Promise<void>;
}

const downloads = new Map<PackageId, AbortController>();

async function renderPackages(ctx: EnginesCtx) {
  const list = $('pkg-list');
  if (isNative) {
    list.innerHTML =
      '<p class="muted">App 已预装全部原生引擎，无需下载：</p>' +
      '<ul class="muted"><li>Stockfish 19 满血版（完整 NNUE，C++ 原生多线程 + NEON）</li><li>Stockfish 19 轻量版（小网络，原生）</li><li>Maia-3 5M / 23M / 79M（ONNX Runtime 原生，CoreML 加速）</li></ul>' +
      '<p class="muted">在「设置 → Stockfish 版本」中切换满血/轻量。</p>';
    return;
  }
  if (!(await loadPrecache()) || !('caches' in self)) {
    list.innerHTML = '<p class="muted">引擎管理仅在生产构建（npm run build + preview / 部署）下可用。</p>';
    $<HTMLButtonElement>('btn-dl-rec').disabled = true;
    return;
  }
  const pkgs = await listPackages(ctx.settings().sfLite);
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

async function startDownload(ctx: EnginesCtx, p: Package, onProgress?: (loaded: number) => void): Promise<boolean> {
  if (downloads.has(p.id)) return false;
  const ctrl = new AbortController();
  downloads.set(p.id, ctrl);
  void requestPersistence();
  try {
    await downloadPackage(p, ctrl.signal, (l, t) => {
      onProgress?.(l);
      const row = pkgRow(p.id);
      if (!row) return;
      row.querySelector<HTMLElement>('.progress')?.classList.remove('hidden');
      const bar = row.querySelector<HTMLElement>('.progress > div');
      if (bar) bar.style.width = `${t ? (l / t) * 100 : 0}%`;
      const st = row.querySelector('.pkg-state');
      if (st) st.textContent = `下载中 ${fmtMB(l)} / ${fmtMB(t)}`;
    });
    setStatus(`${p.label} 已下载`);
    return true;
  } catch (err) {
    if (!ctrl.signal.aborted) setStatus(`${p.label} 下载失败：${(err as Error).message}`);
    return false;
  } finally {
    downloads.delete(p.id);
    if ($<HTMLDialogElement>('dlg-engines').open) await renderPackages(ctx);
  }
}

async function downloadRecommended(ctx: EnginesCtx) {
  const pkgs = await listPackages(ctx.settings().sfLite);
  const want: PackageId[] = ['core', 'stockfish', `maia-${ctx.settings().model}`];
  // sequential: parallel downloads would only compete for bandwidth
  for (const id of want) {
    const p = pkgs.find((x) => x.id === id);
    if (p && !isComplete(p)) await startDownload(ctx, p);
  }
  if (ctx.settings().warmup) void ctx.warmup();
}

/**
 * Startup: silently fetch everything needed to run fully offline (app shell, Stockfish, current Maia model),
 * like installing a native app. Shows a small progress bar; tap it to open the engine manager.
 * Returns true if anything was downloaded.
 */
export async function autoOffline(ctx: EnginesCtx): Promise<boolean> {
  if (isNative || !('caches' in self) || !(await loadPrecache())) return false;
  await pruneStale();
  const pkgs = await listPackages(ctx.settings().sfLite);
  const want: PackageId[] = ['core', 'stockfish', `maia-${ctx.settings().model}`];
  const todo = pkgs.filter((p) => want.includes(p.id) && !isComplete(p));
  if (!todo.length) return false;
  const total = todo.reduce((a, p) => a + p.size, 0);
  const bar = $('offline-bar');
  const text = bar.querySelector('span')!;
  const fill = bar.querySelector<HTMLElement>('.progress > div')!;
  bar.onclick = () => openEngines(ctx);
  bar.classList.remove('hidden');
  let done = 0;
  let ok = true;
  for (const p of todo) {
    const show = (l: number) => {
      const now = done + l;
      text.textContent = `正在下载离线包 ${fmtMB(now)} / ${fmtMB(total)}`;
      fill.style.width = `${total ? (now / total) * 100 : 0}%`;
    };
    show(0);
    ok = (await startDownload(ctx, p, show)) && ok;
    done += p.size;
  }
  bar.classList.add('hidden');
  setStatus(ok ? '离线包已就绪，可断网使用' : '部分离线包下载失败，可在「引擎管理」中重试');
  return true;
}

export function openEngines(ctx: EnginesCtx) {
  const dlg = $<HTMLDialogElement>('dlg-engines');
  const chk = $<HTMLInputElement>('chk-warm');
  chk.checked = ctx.settings().warmup;
  chk.onchange = () => ctx.patchSettings({ warmup: chk.checked });
  const auto = $<HTMLInputElement>('chk-auto-offline');
  auto.checked = ctx.settings().autoOffline;
  auto.onchange = () => ctx.patchSettings({ autoOffline: auto.checked });
  $('btn-dl-rec').onclick = () => void downloadRecommended(ctx);
  $('btn-warm').onclick = () => void ctx.warmup();
  void loadPrecache().then((ok) => (ok ? pruneStale() : 0));
  void renderPackages(ctx);
  dlg.showModal();
}
