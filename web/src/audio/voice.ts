/** Offline Lia recordings, shared by the web app and the iOS native player. */
import { SoundNative } from 'maia-native';
import { isNative } from '../native';
import { LIA_CLIPS, LIA_COACH_INDEX, LIA_FILES, type VoiceClip } from '../lia/dialogue';

let player: HTMLAudioElement | null = null;
let epoch = 0;
let unlocked = false;
const url = (file: string) => `${import.meta.env.BASE_URL}voices/lia/${file}`;

/** Called directly by a tap/key gesture to authorize the shared browser player. */
export function unlockLiaVoice() {
  if (isNative || unlocked || typeof Audio === 'undefined') return;
  player ??= new Audio();
  const audio = player;
  const request = ++epoch;
  audio.src = url(LIA_CLIPS[0].file);
  audio.muted = true;
  void audio.play().then(() => {
    unlocked = true;
    if (request !== epoch) return;
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
  }).catch(() => { if (request === epoch) audio.muted = false; });
}

export function stopLiaVoice() {
  epoch++;
  unlocked = false;
  player?.pause();
  if (isNative) void SoundNative.stopVoice().catch(() => {});
}

export function playLiaVoice(clip: VoiceClip, enabled: boolean, coachIndex: number) {
  if (!enabled || coachIndex !== LIA_COACH_INDEX || !LIA_FILES.has(clip.file) || (typeof document !== 'undefined' && document.hidden)) return;
  epoch++;
  if (isNative) {
    void SoundNative.playVoice({ file: clip.file }).catch(err => console.warn('莉亚录音播放失败', err));
    return;
  }
  if (typeof Audio === 'undefined') return;
  player ??= new Audio();
  player.pause();
  player.muted = false;
  player.src = url(clip.file);
  void player.play().catch(err => console.warn('莉亚录音播放失败', err));
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLiaVoice();
});
