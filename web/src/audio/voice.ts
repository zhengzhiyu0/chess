/** Offline character recordings, shared by the web app and iOS native player. */
import { SoundNative } from 'maia-native';
import { isNative } from '../native';
import { COACH_CLIPS, hasCoachVoice, isCoachClip, type VoiceClip } from '../coach-voice/dialogue';

let player: HTMLAudioElement | null = null;
let epoch = 0;
let unlocked = false;
const url = (clip: VoiceClip) => `${import.meta.env.BASE_URL}voices/${clip.role}/${clip.file}`;

/** Called directly by a tap/key gesture to authorize the shared browser player. */
export function unlockCoachVoice(coachIndex: number) {
  if (isNative || unlocked || !hasCoachVoice(coachIndex) || typeof Audio === 'undefined') return;
  player ??= new Audio();
  const audio = player;
  const request = ++epoch;
  audio.src = url(COACH_CLIPS.find(clip => clip.coachIndex === coachIndex)!);
  audio.muted = true;
  void audio.play().then(() => {
    unlocked = true;
    if (request !== epoch) return;
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
  }).catch(() => { if (request === epoch) audio.muted = false; });
}

export function stopCoachVoice() {
  epoch++;
  unlocked = false;
  player?.pause();
  if (isNative) void SoundNative.stopVoice().catch(() => {});
}

export function playCoachVoice(clip: VoiceClip, enabled: boolean, coachIndex: number) {
  if (!enabled || !isCoachClip(clip, coachIndex) || (typeof document !== 'undefined' && document.hidden)) return;
  epoch++;
  if (isNative) {
    void SoundNative.playVoice({ file: clip.file }).catch(err => console.warn('角色录音播放失败', err));
    return;
  }
  if (typeof Audio === 'undefined') return;
  player ??= new Audio();
  player.pause();
  player.muted = false;
  player.src = url(clip);
  void player.play().catch(err => console.warn('角色录音播放失败', err));
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCoachVoice();
});
