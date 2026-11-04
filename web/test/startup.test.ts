import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ bootstrap: vi.fn(), loadCheckpoint: vi.fn(), writeBatch: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('maia-native', () => ({ AppStoreNative: native }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  native.bootstrap.mockResolvedValue({ values: {} });
  native.loadCheckpoint.mockResolvedValue(undefined);
});

describe('native first-launch storage', () => {
  it.each([undefined, null, {}, { game: null }])('starts normally without a checkpoint: %j', async response => {
    native.loadCheckpoint.mockResolvedValue(response);
    const { initializeAppStorage } = await import('../src/app/startup');
    await expect(initializeAppStorage(true)).resolves.toBeUndefined();
    expect(native.bootstrap).toHaveBeenCalledOnce();
    expect(native.writeBatch).not.toHaveBeenCalled();
  });

  it('restores an existing checkpoint in memory without writing it back through the bridge', async () => {
    native.loadCheckpoint.mockResolvedValue({ game: {
      id: 'restore', date: 123, startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      tree: {}, userColor: 'w', result: '', mode: 'review', cursor: [], flipped: true, peak: 5,
    } });
    const { initializeAppStorage } = await import('../src/app/startup');
    await initializeAppStorage(true);
    const { readJson } = await import('../src/storage');
    expect(readJson('maia-coach.game')).toMatchObject({ id: 'restore', mode: 'review', cursor: [], flipped: true, peak: 5 });
    expect(native.writeBatch).not.toHaveBeenCalled();
  });

  it('reports the real bootstrap reason and permits retry without replacing stored data', async () => {
    native.bootstrap.mockRejectedValueOnce({ message: 'AppStoreNative is not implemented on ios' });
    const { initializeAppStorage, startupFailureMessage } = await import('../src/app/startup');
    const error = await initializeAppStorage(true).catch(error => error);
    expect(startupFailureMessage(error)).toContain('本地数据库初始化失败');
    expect(startupFailureMessage(error)).toContain('AppStoreNative is not implemented on ios');
    expect(startupFailureMessage(error)).not.toContain('释放设备空间');
    expect(native.loadCheckpoint).not.toHaveBeenCalled();
    await expect(initializeAppStorage(true)).resolves.toBeUndefined();
  });

  it('distinguishes a checkpoint read failure from database open failure and retries', async () => {
    native.loadCheckpoint.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const { initializeAppStorage, startupFailureMessage } = await import('../src/app/startup');
    const error = await initializeAppStorage(true).catch(error => error);
    expect(startupFailureMessage(error)).toContain('数据库已打开，但读取对局快照失败');
    expect(startupFailureMessage(error)).toContain('SQLITE_BUSY');
    await expect(initializeAppStorage(true)).resolves.toBeUndefined();
  });

  it('does not mislabel an unrelated application error as a database error', async () => {
    const { startupFailureMessage } = await import('../src/app/startup');
    expect(startupFailureMessage(new Error('render failed'))).toContain('应用启动失败');
    expect(startupFailureMessage(new Error('render failed'))).not.toContain('数据库');
  });
});
