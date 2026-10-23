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

  it('音频中断后不积压事件到恢复时播放', async () => {
    const { play, unlockAudio } = await import('../src/audio/sound');
    unlockAudio();
    const ctx = FakeAudioContext.latest;
    ctx.state = 'suspended';
    ctx.dispatchEvent(new Event('statechange'));
    play('end', 'win');
    unlockAudio();
    await flush();
    expect(played()).toHaveLength(0);
    play('start');
    await flush();
    expect(played()).toHaveLength(1);
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
