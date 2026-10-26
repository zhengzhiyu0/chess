/** English opponent speech using the operating system/browser voice, never bundled audio data. */

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

/** Speak one short English reply with the system voice. */
export function speakEnglish(text: string, enabled: boolean, gender: 'female' | 'male' = 'female') {
  if (!enabled || !text || (typeof document !== 'undefined' && document.hidden)) return;
  const epoch = ++speechEpoch;
  stopBrowserSpeech();
  if (isNative) {
    void SoundNative.speak({ text, language: 'en-US', gender }).catch(() => {});
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
