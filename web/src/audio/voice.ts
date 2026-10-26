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
  utterance.voice = voices.find((voice) => /^en(?:-|$)/i.test(voice.lang)) ?? null;
  utterance.onstart = () => { if (epoch !== speechEpoch) synth.cancel(); };
  synth.speak(utterance);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopEnglishVoice();
  });
}
