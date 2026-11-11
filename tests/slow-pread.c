/* A slow disk, for tests/fixture.test.ts: loaded with LD_PRELOAD into a
 * dynamic build of a disk benchmark, it makes every pread (and pread64) wait
 * SLOW_PREAD_MS milliseconds before reading. With reads slower than the tenth
 * of a second --quick calibrates to, the benchmark settles on one read per
 * sample, the fewest reads any machine can give: five.
 *
 *     cc -shared -fPIC -o slow-pread.so tests/slow-pread.c -ldl
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <sys/types.h>
#include <time.h>

static void wait_a_while(void) {
    const char *text = getenv("SLOW_PREAD_MS");
    if (text == NULL) return;
    long ms = atol(text);
    struct timespec t = { ms / 1000, (ms % 1000) * 1000000L };
    while (nanosleep(&t, &t) != 0) {
    }
}

ssize_t pread(int fd, void *buf, size_t count, off_t offset) {
    static ssize_t (*real)(int, void *, size_t, off_t);
    if (real == NULL) real = (ssize_t (*)(int, void *, size_t, off_t))dlsym(RTLD_NEXT, "pread");
    wait_a_while();
    return real(fd, buf, count, offset);
}

ssize_t pread64(int fd, void *buf, size_t count, off_t offset) {
    static ssize_t (*real)(int, void *, size_t, off_t);
    if (real == NULL) real = (ssize_t (*)(int, void *, size_t, off_t))dlsym(RTLD_NEXT, "pread64");
    wait_a_while();
    return real(fd, buf, count, offset);
}
