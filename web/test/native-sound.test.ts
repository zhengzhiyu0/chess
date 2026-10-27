import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ play: vi.fn(), stop: vi.fn(), prepareSpeech: vi.fn(), speak: vi.fn(), stopSpeech: vi.fn() }));
vi.mock('../src/native', () => ({ isNative: true }));
vi.mock('../src/audio/haptics', () => ({ configureHaptics: vi.fn(), haptic: vi.fn() }));
vi.mock('maia-native', () => ({ SoundNative: native }));

let doc: EventTarget & { hidden: boolean };
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  native.play.mockResolvedValue(undefined);
  native.stop.mockResolvedValue(undefined);
  native.prepareSpeech.mockResolvedValue(undefined);
  native.speak.mockResolvedValue(undefined);
  native.stopSpeech.mockResolvedValue(undefined);
  doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Native sound must not fetch through WKWebView'); }));
  vi.stubGlobal('AudioContext', vi.fn(() => { throw new Error('Native sound must not depend on AudioContext'); }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('iOS 原生 MP3 播放', () => {
  it('按教练性别预热并播放对应 KittenTTS 音色', async () => {
    const { prepareEnglishVoice, speakEnglish, stopEnglishVoice } = await import('../src/audio/voice');
    prepareEnglishVoice(true, 'female');
    speakEnglish('Nice move.', true, 'female');
    prepareEnglishVoice(true, 'male');
    speakEnglish('Well played.', true, 'male');
    expect(native.prepareSpeech).toHaveBeenNthCalledWith(1, { voice: 'bella' });
    expect(native.prepareSpeech).toHaveBeenNthCalledWith(2, { voice: 'jasper' });
    expect(native.speak).toHaveBeenNthCalledWith(1, { text: 'Nice move.', voice: 'bella' });
    expect(native.speak).toHaveBeenNthCalledWith(2, { text: 'Well played.', voice: 'jasper' });
    stopEnglishVoice();
    expect(native.stopSpeech).toHaveBeenCalledOnce();
  });

  it('首次落子无需 WebView 音频解锁，所有音效主题都走原生播放器', async () => {
    const { SOUND_THEMES, configureSound, play, unlockAudio } = await import('../src/audio/sound');
    for (const theme of Object.keys(SOUND_THEMES)) {
      configureSound(true, false, theme);
      unlockAudio();
      play('move');
      expect(native.play).toHaveBeenLastCalledWith({ clips: [{ theme, file: 'Move', delay: 0 }] });
      vi.advanceTimersByTime(70);
    }
    expect(AudioContext).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('普通落子、吃子、将军与胜负和使用正确录音', async () => {
    const { play } = await import('../src/audio/sound');
    const events = [
      ['move', undefined, 'Move'], ['capture', undefined, 'Capture'], ['check', undefined, 'Check'],
      ['castle', undefined, 'Move'], ['promote', undefined, 'Move'], ['illegal', undefined, 'LowTime'],
      ['start', undefined, 'GenericNotify'], ['lowtime', undefined, 'LowTime'],
    ] as const;
    for (const [kind, end, file] of events) {
      play(kind, end);
      expect(native.play).toHaveBeenLastCalledWith({ clips: [{ theme: 'board', file, delay: 0 }] });
      vi.advanceTimersByTime(70);
    }
    expect(native.play).toHaveBeenCalledTimes(events.length);
  });

  it('does not play victory, defeat, or draw sounds', async () => {
    const { play } = await import('../src/audio/sound');
    play('end', 'win');
    play('end', 'loss');
    play('end', 'draw');
    expect(native.play).not.toHaveBeenCalled();
  });

  it('关闭音效后仍可试听，试听使用同一原生批次排程', async () => {
    const { configureSound, play, previewTheme } = await import('../src/audio/sound');
    configureSound(false, false);
    play('move');
    expect(native.play).not.toHaveBeenCalled();
    previewTheme('piano');
    expect(native.play).toHaveBeenCalledWith({ clips: [
      { theme: 'piano', file: 'Move', delay: 0 },
      { theme: 'piano', file: 'Capture', delay: 0.45 },
    ] });
  });

  it('切后台停止已排程音效，回到前台只播放新事件', async () => {
    const { play, previewTheme } = await import('../src/audio/sound');
    play('start');
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(native.stop).toHaveBeenCalledOnce();
    play('end', 'win');
    previewTheme('sfx');
    expect(native.play).toHaveBeenCalledOnce();
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(native.play).toHaveBeenCalledOnce();
    play('move');
    expect(native.play).toHaveBeenCalledTimes(2);
  });

  it('关闭音效和更换主题立即停止原生声音', async () => {
    const { configureSound, play } = await import('../src/audio/sound');
    play('start');
    configureSound(true, false, 'nes');
    expect(native.stop).toHaveBeenCalledOnce();
    configureSound(false, false, 'nes');
    expect(native.stop).toHaveBeenCalledTimes(2);
  });

  it('原生播放失败后记录错误，下一次事件仍可重试', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    native.play.mockRejectedValueOnce(new Error('Audio session interrupted'));
    const { play } = await import('../src/audio/sound');
    play('move');
    await Promise.resolve();
    expect(warning).toHaveBeenCalled();
    vi.advanceTimersByTime(70);
    play('move');
    expect(native.play).toHaveBeenCalledTimes(2);
  });

  it('保留原生落子声去重，防止同一次落子被触发两遍', async () => {
    const { play } = await import('../src/audio/sound');
    play('move');
    play('capture');
    expect(native.play).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(70);
    play('capture');
    expect(native.play).toHaveBeenCalledTimes(2);
  });
});
