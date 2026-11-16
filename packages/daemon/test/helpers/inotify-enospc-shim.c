/* workspaces-o9o.38 (shim by build-impl5, o9o.26): LD_PRELOAD this to make inotify_add_watch fail ENOSPC after FAIL_AFTER calls, per process. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/inotify.h>
/* Simulated inotify watch exhaustion for ONE process tree: the first FAIL_AFTER calls pass, every later one fails ENOSPC. */
static long calls = 0;
int inotify_add_watch(int fd, const char *path, uint32_t mask) {
  static int (*real)(int, const char *, uint32_t) = 0;
  if (!real) real = (int (*)(int, const char *, uint32_t))dlsym(RTLD_NEXT, "inotify_add_watch");
  const char *n = getenv("FAIL_AFTER");
  long limit = n ? atol(n) : -1;
  if (limit >= 0 && __atomic_fetch_add(&calls, 1, __ATOMIC_SEQ_CST) >= limit) { errno = ENOSPC; return -1; }
  return real(fd, path, mask);
}
