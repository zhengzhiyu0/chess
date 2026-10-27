#ifndef MAIA_ESPEAK_BRIDGE_H
#define MAIA_ESPEAK_BRIDGE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int maia_espeak_prepare(const char *document_path);
const char *maia_espeak_last_error(void);

#ifdef __cplusplus
}
#endif

#endif
