import { bootstrapStorage, cacheStored, isObj } from '../storage';
import { sanitizeGame } from '../game/history';

class StartupStorageError extends Error {
  constructor(readonly stage: 'database' | 'checkpoint', cause: unknown) {
    super(cause instanceof Error ? cause.message
      : isObj(cause) && typeof cause.message === 'string' ? cause.message : String(cause), { cause });
  }
}

/** A missing checkpoint is the normal first-launch state, including older bridge responses. */
export async function initializeAppStorage(native: boolean): Promise<void> {
  try { await bootstrapStorage(); }
  catch (error) { throw new StartupStorageError('database', error); }
  if (!native) return;
  try {
    const { AppStoreNative } = await import('maia-native');
    const response = await AppStoreNative.loadCheckpoint();
    const raw = isObj(response) ? response.game : undefined;
    const game = sanitizeGame(raw);
    if (!game) return;
    const peak = isObj(raw) ? raw.peak : undefined;
    cacheStored('maia-coach.game', JSON.stringify({
      ...game, peak: typeof peak === 'number' && Number.isFinite(peak) ? peak : 0,
    }));
  } catch (error) { throw new StartupStorageError('checkpoint', error); }
}

/** Preserve the failing stage and original reason instead of guessing at device capacity. */
export function startupFailureMessage(error: unknown): string {
  const stage = error instanceof StartupStorageError ? error.stage : undefined;
  const title = stage === 'database' ? '本地数据库初始化失败。'
    : stage === 'checkpoint' ? '本地数据库已打开，但读取对局快照失败。'
    : '应用启动失败。';
  const detail = error instanceof Error ? error.message
    : isObj(error) && typeof error.message === 'string' ? error.message : String(error);
  return `${title}请重试；如果仍失败，请复制以下错误信息反馈。\n\n${detail}`;
}
