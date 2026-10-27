#import <Foundation/Foundation.h>
#import <espeak-ng/bundle.h>
#import <espeak-ng/speak_lib.h>

#include "EspeakBridge.h"

#include <string>

namespace {
std::string phonemeBuffer;
std::string errorBuffer;
bool initialized = false;

const char *terminatorText(int terminator) {
  switch (terminator & 0x000FFFFF) {
  case 0x00080028: return ". ";
  case 0x00082028: return "? ";
  case 0x0008302D: return "! ";
  case 0x00041014: return ", ";
  case 0x0004001E: return ": ";
  case 0x0004101E: return "; ";
  default: return "";
  }
}
}

extern "C" int maia_espeak_initialize(const char *document_path) {
  if (initialized) return 1;
  if (!document_path || !document_path[0]) {
    errorBuffer = "missing eSpeak data directory";
    return 0;
  }

  @autoreleasepool {
    NSString *path = [NSString stringWithUTF8String:document_path];
    NSURL *root = [NSURL fileURLWithPath:path isDirectory:YES];
    NSError *error = nil;
    if (![EspeakLib ensureBundleInstalledInRoot:root error:&error]) {
      errorBuffer = error.localizedDescription.UTF8String ?: "could not install eSpeak data";
      return 0;
    }
  }

  const int sampleRate = espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, document_path, 0);
  if (sampleRate <= 0 || espeak_SetVoiceByName("en-us") != EE_OK) {
    errorBuffer = "eSpeak initialization or en-us voice selection failed";
    return 0;
  }
  initialized = true;
  return sampleRate;
}

extern "C" const char *maia_espeak_phonemize(const char *text, size_t *output_length) {
  if (!initialized || !text || !output_length) {
    errorBuffer = "eSpeak is not initialized or input is invalid";
    return nullptr;
  }

  phonemeBuffer.clear();
  std::string sentencePhonemes;
  const void *textPointer = text;
  while (textPointer != nullptr) {
    int terminator = 0;
    const char *phonemes = espeak_TextToPhonemesWithTerminator(
        &textPointer, espeakCHARS_AUTO, espeakPHONEMES_IPA, &terminator);
    if (phonemes) sentencePhonemes += phonemes;
    const char *terminatorString = terminatorText(terminator);
    if (terminatorString[0]) {
      if (!sentencePhonemes.empty()) {
        phonemeBuffer += "[[" + sentencePhonemes + "]]";
        sentencePhonemes.clear();
      }
      phonemeBuffer += terminatorString;
    }
  }
  if (!sentencePhonemes.empty()) phonemeBuffer += "[[" + sentencePhonemes + "]]";

  *output_length = phonemeBuffer.size();
  return phonemeBuffer.c_str();
}

extern "C" const char *maia_espeak_last_error(void) {
  return errorBuffer.c_str();
}
