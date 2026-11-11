/* A test shim, loaded with LD_PRELOAD into a dynamically linked http_get
 * (tests/http-get.test.ts): the Nth write(2) to a socket fails with EPIPE, as
 * if the server had reset the connection at that moment. N is
 * LM_TEST_FAIL_SOCKET_WRITE (1 is the first); unset or 0, nothing fails.
 * AWS-LC writes TLS records to the socket with write(2). Only writes to an
 * IPv4 or IPv6 stream socket are counted: the DNS query goes out with send(2)
 * on a datagram socket, and stdout may be a Unix socket (Bun's spawnSync
 * makes it one). Never part of a Run. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static int tcp_socket(int fd) {
    int type = 0;
    socklen_t len = sizeof(type);
    struct sockaddr_storage address;
    socklen_t address_len = sizeof(address);
    return getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &len) == 0 && type == SOCK_STREAM &&
           getsockname(fd, (struct sockaddr *)&address, &address_len) == 0 && (address.ss_family == AF_INET || address.ss_family == AF_INET6);
}

ssize_t write(int fd, const void *buf, size_t count) {
    static ssize_t (*real)(int, const void *, size_t);
    static long target = -1, seen;
    if (real == NULL) real = (ssize_t(*)(int, const void *, size_t))dlsym(RTLD_NEXT, "write");
    if (target < 0) {
        const char *text = getenv("LM_TEST_FAIL_SOCKET_WRITE");
        target = text != NULL ? atol(text) : 0;
    }
    if (target > 0 && tcp_socket(fd) && ++seen == target) {
        errno = EPIPE;
        return -1;
    }
    return real(fd, buf, count);
}
