#!/bin/sh
# Builds the embedded Stockfish (full + lite linked into one binary) with the same defines as
# Package.swift and runs sf_smoke.cpp against it. Works with clang/g++ or `zig c++`.
#   sh build_smoke.sh <dir with nn-*.nnue>        (CXX / OUT / ARCH_FLAGS may be overridden)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root="$here/.."
nets="${1:?usage: build_smoke.sh <net dir>}"
CXX="${CXX:-c++}"
out="${OUT:-/tmp/sf_smoke_build}"
mkdir -p "$out"
if [ -z "${ARCH_FLAGS:-}" ]; then
  case "$(uname -m)" in
    arm64|aarch64) ARCH_FLAGS="-DUSE_NEON=8 -DUSE_NEON_DOTPROD -march=armv8.2-a+dotprod" ;;
    *) ARCH_FLAGS="-DUSE_SSE41 -DUSE_SSSE3 -DUSE_SSE2 -msse4.1" ;;
  esac
fi
common="-std=c++17 -O2 -DNDEBUG -DIS_64BIT -DUSE_POPCNT -DNNUE_EMBEDDING_OFF -DSF_EMBEDDED -DSF_NO_SHM $ARCH_FLAGS -w"

objs=""
build() {
  flavour=$1
  extra=$2
  for f in "$root/$flavour"/*.cpp; do
    o="$out/${flavour}_$(basename "$f" .cpp).o"
    objs="$objs $o"
    $CXX $common $extra -c "$f" -o "$o" &
  done
}
build full "-DStockfish=StockfishFull -DSF_C_PREFIX=sf_full"
build lite "-DStockfish=StockfishLite -DSF_C_PREFIX=sf_lite -DUSE_LITE_NET"
wait
for o in $objs; do [ -s "$o" ] || { echo "compile failed: $o" >&2; exit 1; }; done
$CXX -std=c++17 -O2 -c "$here/sf_smoke.cpp" -o "$out/smoke.o"
$CXX $objs "$out/smoke.o" -lpthread -o "$out/sf_smoke"
"$out/sf_smoke" "$nets"
