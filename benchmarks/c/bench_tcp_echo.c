#include "harness.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define TCP_ECHO_BYTES (32U * 1024U)

typedef struct {
    pthread_t thread;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
    uint16_t port;
    bool ready;
} server_ctx_t;

typedef struct {
    int client_fd;
    uint8_t *send_buf;
    uint8_t *recv_buf;
} tcp_echo_ctx_t;

static int start_listener(uint16_t *port);

static void fail_msg(const char *msg) {
    fprintf(stderr, "error: %s\n", msg);
    exit(1);
}

static void set_socket_options(int fd) {
    int one = 1;
    if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)) != 0) die("setsockopt TCP_NODELAY");

    struct timeval timeout = { .tv_sec = 1, .tv_usec = 0 };
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0) die("setsockopt SO_RCVTIMEO");
    if (setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) != 0) die("setsockopt SO_SNDTIMEO");
}

static void send_all(int fd, const uint8_t *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t n = send(fd, buf + off, len - off, MSG_NOSIGNAL);
        if (n < 0) {
            if (errno == EINTR) continue;
            die("send");
        }
        if (n == 0) fail_msg("send returned 0");
        off += (size_t)n;
    }
}

static void recv_exact(int fd, uint8_t *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t n = recv(fd, buf + off, len - off, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            die("recv");
        }
        if (n == 0) fail_msg("peer closed before full echo was read");
        off += (size_t)n;
    }
}

static uint64_t checksum_echo(const uint8_t *buf) {
    uint64_t checksum = 1469598103934665603ULL;
    for (size_t i = 0; i < TCP_ECHO_BYTES; i += 997) {
        checksum ^= (uint64_t)buf[i];
        checksum *= 1099511628211ULL;
    }
    checksum ^= (uint64_t)buf[TCP_ECHO_BYTES - 1];
    checksum *= 1099511628211ULL;
    return checksum;
}

static uint64_t tcp_echo_run(void *arg) {
    tcp_echo_ctx_t *ctx = (tcp_echo_ctx_t *)arg;
    send_all(ctx->client_fd, ctx->send_buf, TCP_ECHO_BYTES);
    recv_exact(ctx->client_fd, ctx->recv_buf, TCP_ECHO_BYTES);
    return checksum_echo(ctx->recv_buf);
}

static void *server_main(void *arg) {
    server_ctx_t *server = (server_ctx_t *)arg;
    uint16_t port = 0;
    int listen_fd = start_listener(&port);

    int rc = pthread_mutex_lock(&server->mutex);
    if (rc != 0) {
        errno = rc;
        die("pthread_mutex_lock");
    }
    server->port = port;
    server->ready = true;
    rc = pthread_cond_signal(&server->cond);
    if (rc != 0) {
        errno = rc;
        die("pthread_cond_signal");
    }
    rc = pthread_mutex_unlock(&server->mutex);
    if (rc != 0) {
        errno = rc;
        die("pthread_mutex_unlock");
    }

    struct sockaddr_in peer;
    socklen_t peer_len = sizeof(peer);

    int fd;
    for (;;) {
        fd = accept(listen_fd, (struct sockaddr *)&peer, &peer_len);
        if (fd >= 0) break;
        if (errno == EINTR) continue;
        die("accept");
    }
    close(listen_fd);

    set_socket_options(fd);
    uint8_t *buf = (uint8_t *)xalloc(64, TCP_ECHO_BYTES);

    for (;;) {
        ssize_t n = recv(fd, buf, TCP_ECHO_BYTES, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            die("server recv");
        }
        if (n == 0) break;
        send_all(fd, buf, (size_t)n);
    }

    free(buf);
    close(fd);
    return NULL;
}

static int start_listener(uint16_t *port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) die("socket");

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(0);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) die("bind");
    if (listen(fd, 1) != 0) die("listen");

    socklen_t addr_len = sizeof(addr);
    if (getsockname(fd, (struct sockaddr *)&addr, &addr_len) != 0) die("getsockname");
    *port = ntohs(addr.sin_port);
    return fd;
}

static uint16_t wait_for_server_port(server_ctx_t *server) {
    int rc = pthread_mutex_lock(&server->mutex);
    if (rc != 0) {
        errno = rc;
        die("pthread_mutex_lock");
    }
    while (!server->ready) {
        rc = pthread_cond_wait(&server->cond, &server->mutex);
        if (rc != 0) {
            errno = rc;
            die("pthread_cond_wait");
        }
    }
    uint16_t port = server->port;
    rc = pthread_mutex_unlock(&server->mutex);
    if (rc != 0) {
        errno = rc;
        die("pthread_mutex_unlock");
    }
    return port;
}

static int connect_client(uint16_t port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) die("socket");

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) die("connect");
    set_socket_options(fd);
    return fd;
}

static void stop_server(tcp_echo_ctx_t *tcp, server_ctx_t *server) {
    if (tcp->client_fd >= 0) {
        shutdown(tcp->client_fd, SHUT_RDWR);
        close(tcp->client_fd);
        tcp->client_fd = -1;
    }

    int rc = pthread_join(server->thread, NULL);
    if (rc != 0) {
        errno = rc;
        die("pthread_join");
    }

    rc = pthread_cond_destroy(&server->cond);
    if (rc != 0) {
        errno = rc;
        die("pthread_cond_destroy");
    }
    rc = pthread_mutex_destroy(&server->mutex);
    if (rc != 0) {
        errno = rc;
        die("pthread_mutex_destroy");
    }
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);

    tcp_echo_ctx_t tcp = {0};
    tcp.client_fd = -1;
    tcp.send_buf = (uint8_t *)xalloc(64, TCP_ECHO_BYTES);
    tcp.recv_buf = (uint8_t *)xalloc(64, TCP_ECHO_BYTES);
    for (size_t i = 0; i < TCP_ECHO_BYTES; i++) {
        tcp.send_buf[i] = (uint8_t)((i * 131U + i / 251U + 17U) & 0xffU);
    }

    server_ctx_t server = {0};
    int rc = pthread_mutex_init(&server.mutex, NULL);
    if (rc != 0) {
        errno = rc;
        die("pthread_mutex_init");
    }
    rc = pthread_cond_init(&server.cond, NULL);
    if (rc != 0) {
        errno = rc;
        die("pthread_cond_init");
    }
    rc = pthread_create(&server.thread, NULL, server_main, &server);
    if (rc != 0) {
        errno = rc;
        die("pthread_create");
    }

    uint16_t port = wait_for_server_port(&server);
    tcp.client_fd = connect_client(port);

    uint64_t expected = checksum_echo(tcp.send_buf);
    uint64_t observed = tcp_echo_run(&tcp);
    if (observed != expected || memcmp(tcp.send_buf, tcp.recv_buf, TCP_ECHO_BYTES) != 0) {
        fprintf(stderr, "error: tcp_echo validation failed\n");
        stop_server(&tcp, &server);
        free(tcp.recv_buf);
        free(tcp.send_buf);
        return 1;
    }

    result_t results[1];
    results[0] = measure("tcp_echo", "32 KiB", 1, TCP_ECHO_BYTES,
                         tcp_echo_run, &tcp, opts.samples, opts.target_calibration_ns);
    print_json(results, 1);

    stop_server(&tcp, &server);
    free(tcp.recv_buf);
    free(tcp.send_buf);
    return 0;
}
