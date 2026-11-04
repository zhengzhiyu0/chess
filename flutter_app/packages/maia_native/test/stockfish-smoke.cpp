// Link both isolated pods at once; test real UCI, NNUE, finite and cancelled searches.
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include "sf_full.h"
#ifndef MAIA_STOCKFISH_FULL_ONLY
#include "sf_lite.h"
#endif

struct Sink {
    std::mutex mutex;
    std::condition_variable changed;
    std::deque<std::string> lines;
};

static void line(void* context, const char* value) {
    auto& sink = *static_cast<Sink*>(context);
    std::lock_guard lock(sink.mutex);
    sink.lines.emplace_back(value);
    sink.changed.notify_one();
}

static bool waitFor(Sink& sink, const char* prefix, int seconds = 60) {
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
    std::unique_lock lock(sink.mutex);
    for (;;) {
        while (!sink.lines.empty()) {
            auto value = std::move(sink.lines.front());
            sink.lines.pop_front();
            if (value.find("CRITICAL ERROR") != std::string::npos) return false;
            if (value.rfind(prefix, 0) == 0) return true;
        }
        if (sink.changed.wait_until(lock, until) == std::cv_status::timeout) return false;
    }
}

static bool exercise(Sink& sink, void (*send)(const char*)) {
    send("uci");
    if (!waitFor(sink, "uciok")) return false;
    send("setoption name Threads value 2");
    send("setoption name Hash value 16");
    send("isready");
    if (!waitFor(sink, "readyok")) return false;
    send("position startpos moves e2e4 e7e5");
    send("go movetime 500");
    if (!waitFor(sink, "bestmove ", 30)) return false;
    send("position startpos");
    send("go infinite");
    if (!waitFor(sink, "info depth", 30)) return false;
    send("stop");
    if (!waitFor(sink, "bestmove ", 10)) return false;
    send("ucinewgame");
    send("isready");
    return waitFor(sink, "readyok");
}

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    const std::string native = argv[1];
    Sink full;
    sf_full_start((native + "/nn-1a298aa575a0.nnue").c_str(), line, &full);
#ifndef MAIA_STOCKFISH_FULL_ONLY
    Sink lite;
    sf_lite_start((native + "/nn-61e7af4bb97d.nnue").c_str(), line, &lite);
    const bool liteOK = exercise(lite, sf_lite_send);
    std::printf("lite: %s\n", liteOK ? "OK" : "FAIL");
#else
    const bool liteOK = true;
#endif
    const bool fullOK = exercise(full, sf_full_send);
    std::printf("full: %s\n", fullOK ? "OK" : "FAIL");
    std::fflush(stdout);
    // The real bridge intentionally owns detached threads until process exit.
    std::_Exit(fullOK && liteOK ? 0 : 1);
}
