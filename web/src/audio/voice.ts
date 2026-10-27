/** English opponent speech uses bundled Piper voices on iOS and system voices on web. */

import { isNative } from '../native';
import { SoundNative } from 'maia-native';

let speechEpoch = 0;

function browserSpeech(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  return window.speechSynthesis;
}

function stopBrowserSpeech() {
  try { browserSpeech()?.cancel(); } catch { /* speech may be unavailable in an embedded browser */ }
}

/** Browser voices do not expose a standard gender field, so prefer the common
 * system voice names and only use pitch as a last-resort fallback. */
function browserVoiceOf(voices: SpeechSynthesisVoice[], gender: 'female' | 'male'): SpeechSynthesisVoice | null {
  const english = voices.filter((voice) => /^en(?:-|$)/i.test(voice.lang));
  const names = gender === 'male'
    ? /\b(male|man|alex|daniel|david|fred|george|james|mark|michael|richard|tom)\b/i
    : /\b(female|woman|ava|karen|kate|samantha|victoria|zira|susan|allison|moira)\b/i;
  return english.find((voice) => names.test(`${voice.name} ${voice.voiceURI}`)) ?? english[0] ?? null;
}

/** Stop the current sentence before changing games, hiding the page, or disabling the option. */
export function stopEnglishVoice() {
  speechEpoch++;
  stopBrowserSpeech();
  if (isNative) void SoundNative.stopSpeech().catch(() => {});
}

const PIPER_VOICES = {
  female: 'en_US-lessac-medium',
  male: 'en_US-ryan-medium',
} as const;

/** Warm the selected native voice while the game is getting ready. */
export function prepareEnglishVoice(enabled: boolean, gender: 'female' | 'male' = 'female') {
  if (enabled && isNative) void SoundNative.prepareSpeech({ voice: PIPER_VOICES[gender] }).catch((err) => console.warn('Piper 预加载失败', err));
}

/** Speak one short English reply with Piper on iOS and the system voice in browsers. */
export function speakEnglish(text: string, enabled: boolean, gender: 'female' | 'male' = 'female') {
  if (!enabled || !text || (typeof document !== 'undefined' && document.hidden)) return;
  const epoch = ++speechEpoch;
  stopBrowserSpeech();
  if (isNative) {
    void SoundNative.speak({ text, voice: PIPER_VOICES[gender] }).catch((err) => console.warn('Piper 播放请求失败', err));
    return;
  }
  const synth = browserSpeech();
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = 0.94;
  utterance.pitch = gender === 'female' ? 1.08 : 0.9;
  const voices = synth.getVoices();
  utterance.voice = browserVoiceOf(voices, gender);
  utterance.onstart = () => { if (epoch !== speechEpoch) synth.cancel(); };
  synth.speak(utterance);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopEnglishVoice();
  });
}
