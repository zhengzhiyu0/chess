#pragma once
// Stockfish 19 (lite NNUE) running natively in-process. See stockfish/bridge/sf_bridge.cpp.
#ifdef __cplusplus
extern "C" {
#endif
typedef void (*sf_lite_line_cb)(void* _Nullable ctx, const char* _Nonnull line);
/** Starts the engine thread once (later calls only rebind the callback). */
void sf_lite_start(const char* _Nonnull nnuePath, sf_lite_line_cb _Nonnull cb, void* _Nullable ctx);
/** Queues one UCI command. */
void sf_lite_send(const char* _Nonnull cmd);
#ifdef __cplusplus
}
#endif
