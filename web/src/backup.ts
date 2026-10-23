// Backup / restore of everything the app stores locally, as one versioned JSON file.
// The same file works in both directions between the PWA and the iOS app.
import { sanitizeSettings, type Settings } from './settings';
import { sanitizeGame, type StoredGame } from './game/history';
import { mergeMistakes, sanitizeMistake, type Mistake } from './training/mistakes';
import { mergeProgress, sanitizeProgress, type PuzzleProgress } from './training/puzzles';
import { isObj } from './storage';
import { isNative } from './native';

export const BACKUP_FORMAT = 'maia-coach-backup';
export const BACKUP_VERSION = 1;

export interface BackupData {
  settings: Settings;
  history: StoredGame[];
  mistakes: Mistake[];
  puzzles: PuzzleProgress;
}

export interface Backup extends BackupData {
  format: typeof BACKUP_FORMAT;
  version: number;
  exported: string;
  app: string;
}

export function makeBackup(d: BackupData, app: string): Backup {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported: new Date().toISOString(), app, ...d };
}

/** Parses and validates a backup file; malformed entries are dropped, not fatal. */
export function parseBackup(text: string): { data: BackupData; skipped: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('不是有效的备份文件（JSON 解析失败）');
  }
  if (!isObj(raw) || raw.format !== BACKUP_FORMAT) throw new Error('不是 Maia Coach 的备份文件');
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION) throw new Error('备份来自更新版本的应用，请先更新');
  let skipped = 0;
  const list = <T>(v: unknown, f: (x: unknown) => T | null): T[] => {
    if (!Array.isArray(v)) return [];
    const out: T[] = [];
    for (const x of v) {
      const y = f(x);
      if (y) out.push(y);
      else skipped++;
    }
    return out;
  };
  return {
    data: {
      settings: sanitizeSettings(raw.settings),
      history: list(raw.history, sanitizeGame),
      mistakes: list(raw.mistakes, sanitizeMistake),
      puzzles: sanitizeProgress(raw.puzzles),
    },
    skipped,
  };
}

/**
 * Merge (default): games and mistakes are united by id; the rating and settings come from the
 * side that has played more rated games, so restoring an old backup never resets progress.
 */
export function mergeBackup(cur: BackupData, inc: BackupData): BackupData {
  const games = new Map(cur.history.map((g) => [g.id, g]));
  for (const g of inc.history) if (!games.has(g.id)) games.set(g.id, g);
  const history = [...games.values()].sort((a, b) => b.date - a.date).slice(0, 300);
  const settings = inc.settings.ratedGames > cur.settings.ratedGames ? { ...cur.settings, elo: inc.settings.elo, ratedGames: inc.settings.ratedGames, autoElo: inc.settings.autoElo } : cur.settings;
  return { settings, history, mistakes: mergeMistakes(cur.mistakes, inc.mistakes), puzzles: mergeProgress(cur.puzzles, inc.puzzles) };
}

export function backupFileName(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `maia-coach-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/**
 * Saves `text` as a file the user can keep: the iOS share sheet in the app (Files / AirDrop /
 * chat apps), the Web Share sheet on phones that support files, otherwise a download.
 */
export async function shareFile(name: string, text: string, mime: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (isNative) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    try {
      await Share.share({ title: name, files: [uri], dialogTitle: '保存备份' });
      return 'shared';
    } catch (err) {
      if (/cancel/i.test((err as Error).message ?? '')) return 'cancelled';
      throw err;
    }
  }
  const file = new File([text], name, { type: mime });
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (coarse && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (err) {
      if ((err as Error).name === 'AbortError') return 'cancelled';
      // fall through to a download
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

/** Opens the system file picker (Files app on iOS) and returns the chosen file's text. */
export function pickFile(accept: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      if (f.size > 50 * 1048576) return reject(new Error('文件太大'));
      f.text().then(resolve, reject);
    };
    input.oncancel = () => {
      input.remove();
      resolve(null);
    };
    input.click();
  });
}
