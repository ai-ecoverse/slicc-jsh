#include <stddef.h>
#include <stdint.h>

#define HAVE_MMAP 0
#define MORECORE_CANNOT_TRIM 1
#define MORECORE jsh_sbrk
#define ABORT __builtin_unreachable()
#define LACKS_TIME_H 1
#define NO_MALLINFO 1
#define NO_MALLOC_STATS 1
#define MALLOC_ALIGNMENT 16
#define MALLOC_FAILURE_ACTION
#define malloc_getpagesize ((size_t)65536)
#define DEFAULT_GRANULARITY ((size_t)65536)
#define USE_DL_PREFIX 1
#define DLMALLOC_EXPORT static inline

static void *jsh_sbrk(intptr_t increment) {
  size_t end = __builtin_wasm_memory_size(0) * 65536;
  if (increment == 0) return (void *)end;
  if (increment < 0 || increment % 65536) return (void *)-1;
  if (__builtin_wasm_memory_grow(0, (size_t)increment / 65536) == (size_t)-1) return (void *)-1;
  return (void *)end;
}

#include "dlmalloc.c"

void *malloc(size_t size) { return dlmalloc(size); }
void free(void *ptr) { dlfree(ptr); }
void *calloc(size_t count, size_t size) { return dlcalloc(count, size); }
void *realloc(void *ptr, size_t size) { return dlrealloc(ptr, size); }
