/* tcp_echo: send a buffer over a loopback TCP connection to an echo server on
 * a second thread of the same process, and read the whole of it back.
 *
 * Parameters:
 *   LM_PARAM_SIZE_BYTES  bytes sent, and read back, per repetition; 1 to 65536
 *
 * Observed:
 *   bytes_per_repetition  bytes one repetition sends and reads back, each counted once
 *
 * The connection (127.0.0.1, a port the kernel picks, TCP_NODELAY and one-second
 * send and receive timeouts on both ends), the echo server and the round trip
 * are the ones the July 2026 proof of concept ran, unchanged. Each repetition
 * returns a hash of bytes it read back, so no round trip can be dropped.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "tcp_echo requires Linux x86_64"
#endif

#include "lm.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

/* Larger buffers could fill both directions' socket buffers before the client
 * reads, and the round trip would stall into the timeout. */
#define MAX_ECHO_BYTES (64U * 1024U)

typedef struct {
    pthread_t thread;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    uint16_t port;
    bool ready;
    size_t bytes;
} server_ctx_t;

typedef struct {
    int client_fd;
    uint8_t *send_buf;
    uint8_t *recv_buf;
    size_t bytes;
} tcp_echo_ctx_t;

static void check_rc(int rc, const char *what) {
    if (rc != 0) lm_die("%s: %s", what, strerror(rc));
}

static void set_socket_options(int fd) {
    int one = 1;
    if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)) != 0) lm_die("setsockopt TCP_NODELAY: %s", strerror(errno));

    struct timeval timeout = { .tv_sec = 1, .tv_usec = 0 };
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0) lm_die("setsockopt SO_RCVTIMEO: %s", strerror(errno));
    if (setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) != 0) lm_die("setsockopt SO_SNDTIMEO: %s", strerror(errno));
}

static void send_all(int fd, const uint8_t *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t n = send(fd, buf + off, len - off, MSG_NOSIGNAL);
        if (n < 0) {
            if (errno == EINTR) continue;
            lm_die("send: %s", strerror(errno));
        }
        if (n == 0) lm_die("send returned 0");
        off += (size_t)n;
    }
}

static void recv_exact(int fd, uint8_t *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t n = recv(fd, buf + off, len - off, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            lm_die("recv: %s", strerror(errno));
        }
        if (n == 0) lm_die("the peer closed before the whole echo was read");
        off += (size_t)n;
    }
}

static uint64_t checksum_echo(const uint8_t *buf, size_t len) {
    uint64_t checksum = 1469598103934665603ULL;
    for (size_t i = 0; i < len; i += 997) {
        checksum ^= (uint64_t)buf[i];
        checksum *= 1099511628211ULL;
    }
    checksum ^= (uint64_t)buf[len - 1];
    checksum *= 1099511628211ULL;
    return checksum;
}

/* One repetition: one round trip of the whole buffer. */
static uint64_t tcp_echo_run(void *arg) {
    tcp_echo_ctx_t *ctx = (tcp_echo_ctx_t *)arg;
    send_all(ctx->client_fd, ctx->send_buf, ctx->bytes);
    recv_exact(ctx->client_fd, ctx->recv_buf, ctx->bytes);
    return checksum_echo(ctx->recv_buf, ctx->bytes);
}

static int start_listener(uint16_t *port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) lm_die("socket: %s", strerror(errno));

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(0);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) lm_die("bind: %s", strerror(errno));
    if (listen(fd, 1) != 0) lm_die("listen: %s", strerror(errno));

    socklen_t addr_len = sizeof(addr);
    if (getsockname(fd, (struct sockaddr *)&addr, &addr_len) != 0) lm_die("getsockname: %s", strerror(errno));
    *port = ntohs(addr.sin_port);
    return fd;
}

static void *server_main(void *arg) {
    server_ctx_t *server = (server_ctx_t *)arg;
    uint16_t port = 0;
    int listen_fd = start_listener(&port);

    check_rc(pthread_mutex_lock(&server->mutex), "pthread_mutex_lock");
    server->port = port;
    server->ready = true;
    check_rc(pthread_cond_signal(&server->cond), "pthread_cond_signal");
    check_rc(pthread_mutex_unlock(&server->mutex), "pthread_mutex_unlock");

    struct sockaddr_in peer;
    socklen_t peer_len = sizeof(peer);
    int fd;
    for (;;) {
        fd = accept(listen_fd, (struct sockaddr *)&peer, &peer_len);
        if (fd >= 0) break;
        if (errno == EINTR) continue;
        lm_die("accept: %s", strerror(errno));
    }
    close(listen_fd);

    set_socket_options(fd);
    uint8_t *buf = (uint8_t *)lm_alloc(64, server->bytes);

    for (;;) {
        ssize_t n = recv(fd, buf, server->bytes, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            lm_die("server recv: %s", strerror(errno));
        }
        if (n == 0) break;
        send_all(fd, buf, (size_t)n);
    }

    free(buf);
    close(fd);
    return NULL;
}

static uint16_t wait_for_server_port(server_ctx_t *server) {
    check_rc(pthread_mutex_lock(&server->mutex), "pthread_mutex_lock");
    while (!server->ready) check_rc(pthread_cond_wait(&server->cond, &server->mutex), "pthread_cond_wait");
    uint16_t port = server->port;
    check_rc(pthread_mutex_unlock(&server->mutex), "pthread_mutex_unlock");
    return port;
}

static int connect_client(uint16_t port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) lm_die("socket: %s", strerror(errno));

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) lm_die("connect: %s", strerror(errno));
    set_socket_options(fd);
    return fd;
}

static void stop_server(tcp_echo_ctx_t *tcp, server_ctx_t *server) {
    shutdown(tcp->client_fd, SHUT_RDWR);
    close(tcp->client_fd);
    tcp->client_fd = -1;
    check_rc(pthread_join(server->thread, NULL), "pthread_join");
    check_rc(pthread_cond_destroy(&server->cond), "pthread_cond_destroy");
    check_rc(pthread_mutex_destroy(&server->mutex), "pthread_mutex_destroy");
}

int main(int argc, char **argv) {
    lm_start(argc, argv);

    uint64_t size_bytes = lm_param_u64("size_bytes", "32768");
    if (size_bytes == 0 || size_bytes > MAX_ECHO_BYTES) {
        lm_usage("parameter size_bytes must be between 1 and %u, got %llu", MAX_ECHO_BYTES, (unsigned long long)size_bytes);
    }

    tcp_echo_ctx_t tcp = {0};
    tcp.client_fd = -1;
    tcp.bytes = (size_t)size_bytes;
    tcp.send_buf = (uint8_t *)lm_alloc(64, tcp.bytes);
    tcp.recv_buf = (uint8_t *)lm_alloc(64, tcp.bytes);
    for (size_t i = 0; i < tcp.bytes; i++) {
        tcp.send_buf[i] = (uint8_t)((i * 131U + i / 251U + 17U) & 0xffU);
    }

    server_ctx_t server = {0};
    server.bytes = tcp.bytes;
    check_rc(pthread_mutex_init(&server.mutex, NULL), "pthread_mutex_init");
    check_rc(pthread_cond_init(&server.cond, NULL), "pthread_cond_init");
    check_rc(pthread_create(&server.thread, NULL, server_main, &server), "pthread_create");

    tcp.client_fd = connect_client(wait_for_server_port(&server));

    uint64_t expected = checksum_echo(tcp.send_buf, tcp.bytes);
    if (tcp_echo_run(&tcp) != expected || memcmp(tcp.send_buf, tcp.recv_buf, tcp.bytes) != 0) {
        lm_die("the bytes read back are not the bytes sent");
    }

    lm_observe_u64("bytes_per_repetition", (uint64_t)tcp.bytes);
    lm_observed();

    lm_measure(tcp_echo_run, &tcp);

    stop_server(&tcp, &server);
    free(tcp.recv_buf);
    free(tcp.send_buf);
    lm_finish();
    return 0;
}
