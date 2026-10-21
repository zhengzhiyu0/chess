// Host-side smoke test for the embedded Stockfish bridge (not shipped in the app).
// Links the full and lite engines into one binary, as the iOS app does, and checks that both
// answer UCI, load their bundled networks, search, and honour "stop".
// Usage: sf_smoke <dir containing nn-*.nnue>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

#include "../full/include/sf_full.h"
#include "../lite/include/sf_lite.h"

struct Sink {
    const char*             tag;
    std::mutex              m;
    std::condition_variable cv;
    std::string             last;
    std::atomic<int>        infos{0};
};

static void on_line(void* ctx, const char* line) {
    auto* s = static_cast<Sink*>(ctx);
    bool info = strncmp(line, "info depth", 10) == 0;
    if (!info || s->infos++ % 6 == 0)
        printf("[%s] %s\n", s->tag, line);
    std::lock_guard lk(s->m);
    s->last = line;
    s->cv.notify_all();
}

static bool wait_for(Sink& s, const char* prefix, int seconds) {
    std::unique_lock lk(s.m);
    return s.cv.wait_for(lk, std::chrono::seconds(seconds), [&] { return s.last.rfind(prefix, 0) == 0; });
}

static bool exercise(Sink& s, void (*send)(const char*)) {
    send("uci");
    if (!wait_for(s, "uciok", 60))
        return false;
    send("setoption name Threads value 2");
    send("setoption name UCI_ShowWDL value true");
    send("isready");
    if (!wait_for(s, "readyok", 60))
        return false;
    send("position startpos moves e2e4 e7e5");
    send("go movetime 1500");
    if (!wait_for(s, "bestmove", 30))
        return false;
    send("position fen r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3");
    send("go infinite");
    std::this_thread::sleep_for(std::chrono::milliseconds(800));
    send("stop");
    return wait_for(s, "bestmove", 10);
}

int main(int argc, char** argv) {
    if (argc < 2)
    {
        fprintf(stderr, "usage: %s <net dir>\n", argv[0]);
        return 2;
    }
    std::string dir  = argv[1];
    std::string full = dir + "/nn-1a298aa575a0.nnue";
    std::string lite = dir + "/nn-61e7af4bb97d.nnue";

    Sink f{"full"}, l{"lite"};
    sf_full_start(full.c_str(), on_line, &f);
    sf_lite_start(lite.c_str(), on_line, &l);

    bool okL = exercise(l, sf_lite_send);
    bool okF = exercise(f, sf_full_send);
    printf("lite: %s\nfull: %s\n", okL ? "OK" : "FAIL", okF ? "OK" : "FAIL");
    fflush(stdout);
    // engine threads are detached and run forever; skip static destructors
    std::_Exit(okL && okF ? 0 : 1);
}
