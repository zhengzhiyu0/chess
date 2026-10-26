import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/haptics', () => ({ configureHaptics: vi.fn(), haptic: vi.fn() }));

class FakeSource extends EventTarget {
  buffer: unknown;
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext extends EventTarget {
  static initialState = 'running';
  static latest: FakeAudioContext;
  state = FakeAudioContext.initialState;
  destination = {};
  sampleRate = 16;
  currentTime = 0;
  sources: FakeSource[] = [];
  resume = vi.fn(async () => { this.state = 'running'; });
  decodeAudioData = vi.fn(async () => ({}));
  constructor() {
    super();
    FakeAudioContext.latest = this;
  }
  createDynamicsCompressor() {
    return { threshold: { value: 0 }, ratio: { value: 0 }, connect: vi.fn() };
  }
  createBuffer() { return { getChannelData: () => new Float32Array(16) }; }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}

let documentMock: EventTarget & { hidden: boolean; baseURI: string };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const played = () => FakeAudioContext.latest.sources.filter((source) => source.start.mock.calls.some((args) => args.length > 0));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  documentMock = Object.assign(new EventTarget(), { hidden: false, baseURI: 'http://localhost/' });
  vi.stubGlobal('document', documentMock);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
  FakeAudioContext.initialState = 'running';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('音效生命周期', () => {
  for (const theme of ['board', 'wood', 'felt', 'glass', 'sfx', 'piano', 'nes', 'futuristic']) {
    it(`${theme} 使用成品 MP3，落子与吃子各自播放`, async () => {
      const { configureSound, play } = await import('../src/audio/sound');
      configureSound(true, false, theme);
      play('move');
      vi.advanceTimersByTime(70);
      play('capture');
      await flush();
      expect(fetch).toHaveBeenCalledWith(`http://localhost/sounds/${theme}/Move.mp3`);
      expect(fetch).toHaveBeenCalledWith(`http://localhost/sounds/${theme}/Capture.mp3`);
      expect(played()).toHaveLength(2);
    });
  }

  it('选中录音失败时回退到 Lichess 成品音效', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/glass/')
      ? new Response(null, { status: 404 }) : new Response(new Uint8Array([1]))));
    const { configureSound, play } = await import('../src/audio/sound');
    configureSound(true, false, 'glass');
    play('move');
    await flush();
    expect(fetch).toHaveBeenCalledWith('http://localhost/sounds/sfx/Move.mp3');
    expect(played()).toHaveLength(1);
  });

  it('无效走子使用现成警告录音', async () => {
    const { play } = await import('../src/audio/sound');
    play('illegal');
    await flush();
    expect(fetch).toHaveBeenCalledWith('http://localhost/sounds/sfx/LowTime.mp3');
    expect(played()).toHaveLength(1);
  });

  it('首次手势解锁后播放刚发生的事件', async () => {
    FakeAudioContext.initialState = 'suspended';
    const { play, unlockAudio } = await import('../src/audio/sound');
    play('start');
    unlockAudio();
    await flush();
    expect(played()).toHaveLength(1);
  });

  it('不在下一次手势补播过期的首次事件', async () => {
    FakeAudioContext.initialState = 'suspended';
    const { play, unlockAudio } = await import('../src/audio/sound');
    play('start');
    vi.advanceTimersByTime(1000);
    unlockAudio();
    await flush();
    expect(played()).toHaveLength(0);
  });

  it('音频中断后不补播过期事件', async () => {
    const { play, unlockAudio } = await import('../src/audio/sound');
    unlockAudio();
    const ctx = FakeAudioContext.latest;
    ctx.state = 'suspended';
    ctx.dispatchEvent(new Event('statechange'));
    let resume!: () => void;
    ctx.resume.mockImplementationOnce(() => new Promise<void>((resolve) => { resume = () => { ctx.state = 'running'; resolve(); }; }));
    play('end', 'win');
    vi.advanceTimersByTime(1000);
    resume();
    await flush();
    expect(played()).toHaveLength(0);
    play('start');
    await flush();
    expect(played()).toHaveLength(1);
  });

  it('前台音频被 iOS 中断后，下一次落子自动恢复播放', async () => {
    const { play, unlockAudio } = await import('../src/audio/sound');
    unlockAudio();
    const ctx = FakeAudioContext.latest;
    ctx.state = 'interrupted';
    ctx.dispatchEvent(new Event('statechange'));
    play('move');
    await flush();
    expect(ctx.resume).toHaveBeenCalledOnce();
    expect(played()).toHaveLength(1);
  });

  it('恢复尚未完成时保留刚发生的落子，不被延迟的状态通知清除', async () => {
    const { play, unlockAudio } = await import('../src/audio/sound');
    unlockAudio();
    const ctx = FakeAudioContext.latest;
    ctx.state = 'suspended';
    let resume!: () => void;
    const pending = new Promise<void>((resolve) => { resume = () => { ctx.state = 'running'; resolve(); }; });
    ctx.resume.mockImplementation(() => pending);
    unlockAudio();
    play('move');
    ctx.dispatchEvent(new Event('statechange'));
    resume();
    ctx.dispatchEvent(new Event('statechange'));
    await flush();
    expect(played()).toHaveLength(1);
  });

  it('iOS 挂起未完成的 resume 后，下次手势仍可重试', async () => {
    FakeAudioContext.initialState = 'suspended';
    const { play, unlockAudio } = await import('../src/audio/sound');
    play('start');
    const ctx = FakeAudioContext.latest;
    ctx.resume.mockImplementationOnce(() => new Promise<void>(() => {}));
    unlockAudio();
    unlockAudio();
    await flush();
    expect(played()).toHaveLength(1);
  });

  it('回到前台自动恢复音频，丢弃后台前的待播事件', async () => {
    const { play, unlockAudio } = await import('../src/audio/sound');
    unlockAudio();
    const ctx = FakeAudioContext.latest;
    documentMock.hidden = true;
    ctx.state = 'suspended';
    documentMock.dispatchEvent(new Event('visibilitychange'));
    documentMock.hidden = false;
    documentMock.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(ctx.state).toBe('running');
    expect(played()).toHaveLength(0);
    play('move');
    await flush();
    expect(played()).toHaveLength(1);
  });

  it('已关闭的音频上下文会在下次手势重建', async () => {
    const { play, unlockAudio } = await import('../src/audio/sound');
    unlockAudio();
    const old = FakeAudioContext.latest;
    old.state = 'closed';
    old.dispatchEvent(new Event('statechange'));
    unlockAudio();
    play('move');
    await flush();
    expect(FakeAudioContext.latest).not.toBe(old);
    expect(played()).toHaveLength(1);
  });

  it('落子声不等待无关的结束音效加载', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/Victory.mp3')
      ? new Promise<Response>(() => {}) : Promise.resolve(new Response(new Uint8Array([1])))));
    const { play } = await import('../src/audio/sound');
    play('move');
    await flush();
    expect(played()).toHaveLength(1);
  });

  it('过滤 70 毫秒内的重复落子音效，到达边界后正常播放', async () => {
    const { play } = await import('../src/audio/sound');
    play('move');
    vi.advanceTimersByTime(30);
    play('capture');
    await flush();
    expect(played()).toHaveLength(1);
    vi.advanceTimersByTime(40);
    play('capture');
    await flush();
    expect(played()).toHaveLength(2);
  });

  it('进入后台停止已排程音效，并忽略后台事件', async () => {
    const { play } = await import('../src/audio/sound');
    play('start');
    await flush();
    const source = played()[0];
    expect(source).toBeDefined();
    documentMock.hidden = true;
    documentMock.dispatchEvent(new Event('visibilitychange'));
    expect(source.stop).toHaveBeenCalledOnce();
    play('end');
    documentMock.hidden = false;
    await flush();
    expect(played()).toHaveLength(1);
  });

  it('切后台后不补播仍在解码的音效', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    vi.stubGlobal('fetch', vi.fn(() => pending));
    const { play } = await import('../src/audio/sound');
    play('start');
    documentMock.hidden = true;
    documentMock.dispatchEvent(new Event('visibilitychange'));
    documentMock.hidden = false;
    resolve(new Response(new Uint8Array([1])));
    await flush();
    expect(played()).toHaveLength(0);
  });

  it('关闭音效后不播放尚未解码完成的事件', async () => {
    const { configureSound, play } = await import('../src/audio/sound');
    play('start');
    configureSound(false, false);
    await flush();
    expect(played()).toHaveLength(0);
  });
});
