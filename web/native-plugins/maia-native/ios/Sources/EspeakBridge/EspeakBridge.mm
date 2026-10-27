#import <Foundation/Foundation.h>
#import <espeak-ng/bundle.h>

#include "EspeakBridge.h"

namespace {
NSString *errorMessage = nil;
}

extern "C" int maia_espeak_prepare(const char *document_path) {
  if (!document_path || !document_path[0]) {
    errorMessage = @"missing eSpeak data directory";
    return 0;
  }

  @autoreleasepool {
    NSString *path = [NSString stringWithUTF8String:document_path];
    NSURL *root = [NSURL fileURLWithPath:path isDirectory:YES];
    NSError *error = nil;
    if (![EspeakLib ensureBundleInstalledInRoot:root error:&error]) {
      errorMessage = error.localizedDescription ?: @"could not install eSpeak data";
      return 0;
    }
  }

  return 1;
}

extern "C" const char *maia_espeak_last_error(void) {
  return errorMessage ? errorMessage.UTF8String : "";
}
