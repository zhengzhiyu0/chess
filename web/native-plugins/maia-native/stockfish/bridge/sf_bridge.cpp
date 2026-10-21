// Hosts one Stockfish engine inside the iOS app.
//
// This file is compiled once per network flavour (see ../full and ../lite). Each copy is built with
// -DStockfish=<unique namespace> so the full and lite engines (which differ in NNUE architecture)
// link into the same binary, and with -DSF_C_PREFIX=<prefix> for its C entry points.
//
// Commands are processed on a dedicated thread in order; "go" returns immediately (search runs on
// Stockfish's own pthreads), so "stop" queued behind it is handled promptly. Output goes through
// SF_OUT (see misc.h) to the host callback one line at a time.

#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <ostream>
#include <pthread.h>
#include <streambuf>
#include <string>

#include "../src/attacks.h"
#include "../src/misc.h"
#include "../src/position.h"
#include "../src/tune.h"
#include "../src/uci.h"

typedef void (*sf_line_cb)(void* ctx, const char* line);

#ifndef SF_C_PREFIX
    #error "define SF_C_PREFIX (e.g. sf_full)"
#endif
#define SF_CAT2(a, b) a##b
#define SF_CAT(a, b) SF_CAT2(a, b)
#define SF_FN(name) SF_CAT(SF_C_PREFIX, name)

namespace {

std::mutex              qMutex;
std::condition_variable qCv;
std::deque<std::string> queue;

std::mutex cbMutex;
sf_line_cb lineCb  = nullptr;
void*      lineCtx = nullptr;

bool started = false;

// Collects characters and hands each complete line to the host. Stockfish holds its IO_LOCK
// for a whole sync_cout ... sync_endl statement, so lines from different threads never mix.
class LineBuf: public std::streambuf {
    std::string line;

    void emit() {
        std::lock_guard lk(cbMutex);
        if (lineCb)
            lineCb(lineCtx, line.c_str());
        line.clear();
    }

   protected:
    int_type overflow(int_type ch) override {
        if (ch == traits_type::eof())
            return 0;
        if (ch == '\n')
            emit();
        else
            line.push_back(char(ch));
        return ch;
    }
    std::streamsize xsputn(const char* s, std::streamsize n) override {
        for (std::streamsize i = 0; i < n; ++i)
        {
            if (s[i] == '\n')
                emit();
            else
                line.push_back(s[i]);
        }
        return n;
    }
};

LineBuf      lineBuf;
std::ostream out(&lineBuf);

std::string netPath;

void* run(void*) {
    using namespace Stockfish;
    sf_out() << engine_info() << std::endl;
    Attacks::init();
    Position::init();

    static char  arg0[] = "stockfish";
    static char* argv[] = {arg0, nullptr};
    auto         uci    = std::make_unique<UCIEngine>(CommandLine(1, argv));
    Tune::init(uci->engine_options());
    // the network is a bundle resource, not embedded in the binary
    uci->process_command("setoption name EvalFile value " + netPath);

    for (;;)
    {
        std::unique_lock lk(qMutex);
        qCv.wait(lk, [] { return !queue.empty(); });
        std::string cmd = std::move(queue.front());
        queue.pop_front();
        lk.unlock();
        uci->process_command(cmd);
    }
    return nullptr;
}

}  // namespace

namespace Stockfish {
std::ostream& sf_out() { return out; }
}

extern "C" {

/** Starts the engine thread (once) and (re)binds the output callback. */
void SF_FN(_start)(const char* nnuePath, sf_line_cb cb, void* ctx) {
    {
        std::lock_guard lk(cbMutex);
        lineCb  = cb;
        lineCtx = ctx;
    }
    std::lock_guard lk(qMutex);
    if (started)
        return;
    started = true;
    netPath = nnuePath;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 8 * 1024 * 1024);
    pthread_t th;
    pthread_create(&th, &attr, run, nullptr);
    pthread_detach(th);
    pthread_attr_destroy(&attr);
}

/** Queues one UCI command. "quit" is ignored: the engine lives as long as the app. */
void SF_FN(_send)(const char* cmd) {
    std::string s(cmd);
    if (s == "quit")
        return;
    {
        std::lock_guard lk(qMutex);
        queue.push_back(std::move(s));
    }
    qCv.notify_one();
}

}  // extern "C"
