#!/usr/bin/env bash
set -euo pipefail

ZIG_VERSION=0.16.0
BINARYEN_VERSION=132
BROTLI_URL=https://github.com/google/brotli/archive/refs/tags/v1.1.0.tar.gz
BROTLI_SHA256=e720a6ca29428b803f4ad165371771f5398faba397edf6778837a18599ea13ff
ZSTD_URL=https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz
ZSTD_SHA256=eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3
DLMALLOC_URL=https://raw.githubusercontent.com/WebAssembly/wasi-libc/wasi-sdk-25/dlmalloc/src/malloc.c
DLMALLOC_SHA256=9e7ce51d813331ae87ef235f6ca2d5ce2167692e30bb51a173513e3754a67f8f

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
[ "$(zig version)" = "$ZIG_VERSION" ] || { echo "zig $ZIG_VERSION is needed" >&2; exit 1; }
wasm-opt --version | grep -q "version $BINARYEN_VERSION\b" || { echo "binaryen $BINARYEN_VERSION is needed" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fetch() {
  curl -fsSL "$1" -o "$work/src.tar.gz"
  echo "$2  $work/src.tar.gz" | shasum -a 256 -c - >/dev/null
  tar xzf "$work/src.tar.gz" -C "$work"
  rm "$work/src.tar.gz"
}
fetch "$BROTLI_URL" "$BROTLI_SHA256"
fetch "$ZSTD_URL" "$ZSTD_SHA256"
curl -fsSL "$DLMALLOC_URL" -o "$work/dlmalloc.c"
echo "$DLMALLOC_SHA256  $work/dlmalloc.c" | shasum -a 256 -c - >/dev/null

cc() { zig cc -target wasm32-wasi -O2 -ffile-prefix-map="$work"=. "$@"; }
features="--enable-bulk-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --enable-multivalue --enable-reference-types"
link() {
  local out=$1; shift
  local exports=()
  while [ "$1" != -- ]; do exports+=("-Wl,--export=$1"); shift; done
  shift
  zig cc -target wasm32-wasi -mexec-model=reactor -O2 -Wl,-z,stack-size=1048576 "${exports[@]}" "$@" -o "$work/linked.wasm"
  wasm-opt $features -O2 --strip-debug --strip-producers "$work/linked.wasm" -o "$out"
}

b="$work/brotli-1.1.0/c"
sed -i.orig 's/BROTLI_DISTANCE_BIT_PENALTY \* 8 \* sizeof(size_t)/BROTLI_DISTANCE_BIT_PENALTY * 8 * 8/' "$b/enc/hash.h"
cmp -s "$b/enc/hash.h" "$b/enc/hash.h.orig" && { echo "hash.h: BROTLI_SCORE_BASE moved" >&2; exit 1; }
cc -I"$work" -c "$here/malloc.c" -o "$work/malloc.o"
mkdir -p "$work/obj-brotli"
for s in "$b"/common/*.c "$b"/enc/*.c; do
  cc -DBROTLI_EXTERNAL_DICTIONARY_DATA -Dexit=jsh_exit -I"$b/include" -c "$s" -o "$work/obj-brotli/$(basename "$(dirname "$s")")_$(basename "$s" .c).o"
done
cc -c "$here/shim.c" -o "$work/obj-brotli/shim.o"
cp "$work/malloc.o" "$work/obj-brotli/malloc.o"
link "$root/src/brotli/encoder.wasm" malloc free BrotliSetDictionaryData BrotliEncoderCreateInstance BrotliEncoderDestroyInstance \
  BrotliEncoderSetParameter BrotliEncoderCompressStream -- "$work"/obj-brotli/*.o

z="$work/zstd-1.5.7/lib"
mkdir -p "$work/obj-zstd"
zdefs="-DZSTD_DISABLE_ASM -DXXH_NAMESPACE=ZSTD_ -I$z -I$z/common"
for s in "$z"/common/{entropy_common,error_private,fse_decompress,xxhash,zstd_common,threading}.c "$z"/compress/*.c; do
  cc -DZSTD_MULTITHREAD $zdefs -c "$s" -o "$work/obj-zstd/$(basename "$s" .c).o"
done
cc $zdefs -c "$z/common/pool.c" -o "$work/obj-zstd/pool.o"
cc -c "$here/shim.c" -o "$work/obj-zstd/shim.o"
cp "$work/malloc.o" "$work/obj-zstd/malloc.o"
link "$root/src/zstd/compress.wasm" malloc free ZSTD_isError ZSTD_getErrorCode ZSTD_createCCtx ZSTD_freeCCtx ZSTD_CCtx_setParameter \
  ZSTD_CCtx_setPledgedSrcSize ZSTD_CCtx_loadDictionary ZSTD_compressStream2 -- "$work"/obj-zstd/*.o

ls -l "$root/src/brotli/encoder.wasm" "$root/src/zstd/compress.wasm"
