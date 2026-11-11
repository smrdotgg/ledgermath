/* http_get: HTTPS GET requests to S3, one request per sample, each phase an event.
 *
 * The binary resolves the endpoint's name itself (one UDP query to the box's
 * resolver), opens TCP, does TLS with AWS-LC (linked statically), writes
 * HTTP/1.1 by hand, signs each request by hand with SigV4 before the request's
 * first timestamp, and reads the response, framing it itself. Nothing retries.
 * An error (a status that is not 2xx, a reset, a timeout, a short body, a TLS
 * or DNS failure) is an event holding what was received, and the Run goes on.
 *
 * README.md says what each event means, which two clock reads bound each
 * phase, every parameter, and the exit codes.
 */
#include "lm.h"
#include "lm_dns.h"
#include "lm_fixture.h"
#include "lm_http.h"
#include "lm_lines.h"
#include "lm_sigv4.h"
#include "lm_tls.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <linux/tcp.h>
#include <math.h>
#include <netinet/in.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <openssl/crypto.h>
#include <openssl/sha.h>

#if !defined(LM_AWS_LC_SHA256)
#error "LM_AWS_LC_SHA256 must be defined from benchmarks/harness/c/vendor/aws-lc.lock"
#endif

#define USER_AGENT "ledgermath-http_get/1"
#define EMPTY_SHA256 "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
#define MAX_HEAD (64 * 1024)          /* the response's header block, and its trailers */
#define BODY_SLACK (64 * 1024)        /* body buffer beyond object_bytes, for error bodies */
#define MAX_PRINTED_HEAD 4096         /* a header block that never completed, or did not parse, is printed up to this many bytes */
#define MAX_ERROR_ELEMENTS 64         /* element names kept from a non-2xx body */
#define DNS_BUFFER 4096               /* the resolver's reply is read into this many bytes */
#define UNREACHABLE_LIMIT 10          /* this many requests in a row that reach no server end the Run */
#define GAP_SEED 0x6c65646765726d61ULL /* "ledgerma": the gaps' fixed seed */

/* Secret slots (lm_lines.h): the credentials, then a ring of recent signatures. */
enum { SECRET_KEY_ID = 0, SECRET_KEY = 1, SECRET_TOKEN = 2, SECRET_SIGNATURES = 3 };

typedef enum { CONN_NEW, CONN_REUSED } conn_mode;

static struct {
    uint64_t object_bytes;
    const char *key;
    conn_mode connection;
    uint64_t gap_mean_ms;
    uint64_t budget_seconds;
    uint64_t timeout_ms;
    const char *ca_file;
    const char *resolv_conf;
    bool sign;
} P;

static struct {
    char host[254];
    uint16_t port;
    char host_header[270];
    const char *region;
    const char *key_id;
    const char *secret;
    const char *token; /* NULL when there is none */
    char target[3 * 1024 + 2];
} S;

static struct sockaddr_in g_resolver;
static char g_resolver_text[160];
static unsigned char g_fixture_sha256[32];
static unsigned char *g_body;
static size_t g_body_cap;
static lm_lines g_out;

/* Certificates already written as `certificate` events in this Run. */
static unsigned char (*g_seen_certs)[32];
static size_t g_seen_cert_count, g_seen_cert_cap;

/* What the Run did, for the closing `observed`, `verified` and the exit code. */
static struct {
    unsigned requests_made;
    unsigned responses;
    unsigned responses_2xx_verified;
    unsigned requests_failed;
    unsigned setups_failed;
    unsigned connections_opened;
    bool body_mismatch;
    bool any_error;
    uint64_t verified_body_bytes;
    bool have_verified_body_bytes;
    unsigned statuses[1000];
    unsigned failures[16];
    SHA256_CTX digests; /* every response's body digest, in order: the elision guard */
} R;

/* ---- clocks ---- */

static uint64_t cpu_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

typedef struct {
    uint64_t t;
    uint64_t cpu;
} mark;

static inline mark now_mark(void) {
    mark m;
    m.t = lm_now_ns();
    m.cpu = cpu_ns();
    return m;
}

static int cmp_u64(const void *a, const void *b) {
    uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
    return (x > y) - (x < y);
}

/* The median cost of reading the thread CPU clock, which every phase boundary does once. */
static uint64_t cpu_clock_read_cost_ns(void) {
    enum { BATCHES = 51, READS = 1000 };
    uint64_t per[BATCHES];
    volatile uint64_t sink = 0;
    for (int b = 0; b < BATCHES; b++) {
        uint64_t t0 = lm_now_ns();
        for (int i = 0; i < READS; i++) sink += cpu_ns();
        per[b] = (lm_now_ns() - t0) / READS;
    }
    (void)sink;
    qsort(per, BATCHES, sizeof(per[0]), cmp_u64);
    return per[BATCHES / 2];
}

/* ---- inputs ---- */

static const char *env_required(const char *name) {
    const char *value = getenv(name);
    if (value == NULL || value[0] == '\0') lm_usage("%s is not set", name);
    return value;
}

static void read_service(void) {
    const char *endpoint = env_required("LM_SERVICE_ENDPOINT");
    if (strncmp(endpoint, "https://", 8) != 0) lm_usage("LM_SERVICE_ENDPOINT must start with https://");
    const char *host = endpoint + 8;
    const char *end = host;
    while (*end && *end != ':' && *end != '/') end++;
    size_t host_len = (size_t)(end - host);
    if (host_len == 0 || host_len >= sizeof(S.host)) lm_usage("LM_SERVICE_ENDPOINT has no host, or one longer than 253 bytes");
    for (const char *p = host; p < end; p++) {
        if (!(isalnum((unsigned char)*p) || *p == '-' || *p == '.')) lm_usage("LM_SERVICE_ENDPOINT's host must be a DNS name");
    }
    memcpy(S.host, host, host_len);
    S.host[host_len] = '\0';
    S.port = 443;
    if (*end == ':') {
        char *after = NULL;
        unsigned long port = strtoul(end + 1, &after, 10);
        if (after == end + 1 || port == 0 || port > 65535) lm_usage("LM_SERVICE_ENDPOINT has a bad port");
        S.port = (uint16_t)port;
        end = after;
    }
    if (*end == '/' && end[1] == '\0') end++;
    if (*end != '\0') lm_usage("LM_SERVICE_ENDPOINT must be https://<host>[:<port>], with no path");
    if (S.port == 443) snprintf(S.host_header, sizeof(S.host_header), "%s", S.host);
    else snprintf(S.host_header, sizeof(S.host_header), "%s:%u", S.host, S.port);

    if (!P.sign) return;
    S.region = env_required("LM_SERVICE_REGION");
    for (const char *p = S.region; *p; p++) {
        if (!(islower((unsigned char)*p) || isdigit((unsigned char)*p) || *p == '-')) lm_usage("LM_SERVICE_REGION must be a Region code such as us-east-2");
    }
    /* Credentials: never echoed, not even in an error. */
    S.key_id = env_required("LM_SERVICE_AWS_ACCESS_KEY_ID");
    S.secret = env_required("LM_SERVICE_AWS_SECRET_ACCESS_KEY");
    S.token = getenv("LM_SERVICE_AWS_SESSION_TOKEN");
    if (S.token != NULL && S.token[0] == '\0') S.token = NULL;
    size_t id_len = strlen(S.key_id);
    bool id_ok = id_len >= 16 && id_len <= 128;
    for (const char *p = S.key_id; *p; p++) id_ok = id_ok && (isupper((unsigned char)*p) || isdigit((unsigned char)*p));
    if (!id_ok) lm_usage("LM_SERVICE_AWS_ACCESS_KEY_ID is not an access key ID (16 to 128 capital letters and digits)");
    /* Every real one is far longer; a short one could be matched by chance in
     * what is printed, and the guard (lm_lines.h) would refuse it there. */
    if (strlen(S.secret) < 16) lm_usage("LM_SERVICE_AWS_SECRET_ACCESS_KEY is shorter than any secret key (16 characters)");
    if (S.token != NULL && strlen(S.token) < 16) lm_usage("LM_SERVICE_AWS_SESSION_TOKEN is shorter than any session token (16 characters)");
    for (const char *p = S.secret; *p; p++) {
        if (*p <= ' ' || *p > '~') lm_usage("LM_SERVICE_AWS_SECRET_ACCESS_KEY holds a character no secret key holds");
    }
    for (const char *p = S.token ? S.token : ""; *p; p++) {
        if (*p <= ' ' || *p > '~') lm_usage("LM_SERVICE_AWS_SESSION_TOKEN holds a character no session token holds");
    }
    /* Registered with their encodings (lm_lines.h). A credential that could
     * be read inside the stream's own sample, verified or finished lines (one
     * of digits alone, say) is refused: no real one is like that. */
    if (!lm_secret_add(SECRET_KEY_ID, S.key_id, id_len)) lm_usage("LM_SERVICE_AWS_ACCESS_KEY_ID could be mistaken for the stream's own text");
    if (!lm_secret_add(SECRET_KEY, S.secret, strlen(S.secret))) lm_usage("LM_SERVICE_AWS_SECRET_ACCESS_KEY could be mistaken for the stream's own text");
    if (S.token != NULL && !lm_secret_add(SECRET_TOKEN, S.token, strlen(S.token))) lm_usage("LM_SERVICE_AWS_SESSION_TOKEN could be mistaken for the stream's own text");
}

static void read_params(void) {
    P.object_bytes = lm_param_u64("object_bytes", "4096");
    if (P.object_bytes == 0 || P.object_bytes > (1ULL << 30)) lm_usage("parameter object_bytes must be 1 to 1073741824");
    P.key = lm_param("key", "http_get/v1/4096");
    if (P.key[0] == '\0' || P.key[0] == '/' || strlen(P.key) > 1024) lm_usage("parameter key must be an object key of 1 to 1024 bytes, not starting with /");
    const char *connection = lm_param("connection", "new");
    if (strcmp(connection, "new") == 0) P.connection = CONN_NEW;
    else if (strcmp(connection, "reused") == 0) P.connection = CONN_REUSED;
    else lm_usage("parameter connection must be new or reused, got \"%s\"", connection);
    P.gap_mean_ms = lm_param_u64("gap_mean_ms", "10");
    if (P.gap_mean_ms > 60000) lm_usage("parameter gap_mean_ms must be at most 60000");
    P.budget_seconds = lm_param_u64("budget_seconds", "60");
    if (P.budget_seconds == 0 || P.budget_seconds > 86400) lm_usage("parameter budget_seconds must be 1 to 86400");
    P.timeout_ms = lm_param_u64("timeout_ms", "5000");
    if (P.timeout_ms == 0 || P.timeout_ms > 600000) lm_usage("parameter timeout_ms must be 1 to 600000");
    P.ca_file = lm_param("ca_file", "/etc/pki/tls/certs/ca-bundle.crt");
    P.resolv_conf = lm_param("resolv_conf", "/etc/resolv.conf");
    const char *auth = lm_param("auth", "sigv4");
    if (strcmp(auth, "sigv4") == 0) P.sign = true;
    else if (strcmp(auth, "none") == 0) P.sign = false;
    else lm_usage("parameter auth must be sigv4 or none, got \"%s\"", auth);
    if (lm_sigv4_encode_path(P.key, S.target + 1, sizeof(S.target) - 1) == 0) lm_usage("parameter key is too long once encoded");
    S.target[0] = '/';
}

static unsigned counted_samples(void) {
    const char *text = getenv("LM_SAMPLES");
    if (text == NULL) return 3; /* lm_start() has refused an absent LM_SAMPLES outside --quick */
    return (unsigned)strtoul(text, NULL, 10);
}

/* The first nameserver line of the resolver file. An address may carry a port
 * as <address>:<port>, which no system resolver reads; the tests' stand-in
 * listens on one. */
static void read_resolver(void) {
    FILE *f = fopen(P.resolv_conf, "r");
    if (f == NULL) lm_die("cannot read %s: %s", P.resolv_conf, strerror(errno));
    char line[512];
    bool found = false;
    while (!found && fgets(line, sizeof(line), f) != NULL) {
        char word[32], address[128];
        if (sscanf(line, " %31s %127s", word, address) != 2 || strcmp(word, "nameserver") != 0) continue;
        unsigned long port = 53;
        char *colon = strchr(address, ':');
        if (colon != NULL) {
            if (strchr(colon + 1, ':') != NULL) continue; /* IPv6: not used, the query is IPv4 */
            char *end = NULL;
            port = strtoul(colon + 1, &end, 10);
            if (end == colon + 1 || *end != '\0' || port == 0 || port > 65535) continue;
            *colon = '\0';
        }
        memset(&g_resolver, 0, sizeof(g_resolver));
        g_resolver.sin_family = AF_INET;
        g_resolver.sin_port = htons((uint16_t)port);
        if (inet_pton(AF_INET, address, &g_resolver.sin_addr) != 1) continue;
        snprintf(g_resolver_text, sizeof(g_resolver_text), "%s:%lu", address, port);
        found = true;
    }
    fclose(f);
    if (!found) lm_die("%s has no IPv4 nameserver line", P.resolv_conf);
}

static void sha256_file(const char *path, unsigned char out[32]) {
    FILE *f = fopen(path, "rb");
    if (f == NULL) lm_die("cannot read %s: %s", path, strerror(errno));
    SHA256_CTX ctx;
    SHA256_Init(&ctx);
    unsigned char buf[65536];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) SHA256_Update(&ctx, buf, n);
    if (ferror(f)) lm_die("cannot read %s", path);
    fclose(f);
    SHA256_Final(out, &ctx);
}

/* The Fixture's first object_bytes bytes (lm_fixture.h), into the body
 * buffer, hashed; the buffer is overwritten by every response. */
static void fixture_digest(void) {
    for (uint64_t o = 0; o < P.object_bytes; o += 8) {
        uint64_t word = lm_fixture_word(o);
        unsigned char le[8];
        for (int i = 0; i < 8; i++) le[i] = (unsigned char)(word >> (8 * i));
        size_t n = P.object_bytes - o < 8 ? (size_t)(P.object_bytes - o) : 8;
        memcpy(g_body + o, le, n);
    }
    SHA256(g_body, (size_t)P.object_bytes, g_fixture_sha256);
}

/* ---- what may be printed of what was received ---- */

static bool has_key_id_pattern(const unsigned char *p, size_t len) {
    for (size_t i = 0; i + 20 <= len; i++) {
        if (p[i] != 'A' || p[i + 2] != 'I' || p[i + 3] != 'A' || (p[i + 1] != 'K' && p[i + 1] != 'S')) continue;
        size_t k = 4;
        while (k < 20 && (isupper(p[i + k]) || isdigit(p[i + k]))) k++;
        if (k == 20) return true;
    }
    return false;
}

/* A number of exactly twelve digits standing alone, with no letter or digit
 * on either side: how an account ID appears (arn:aws:iam::123456789012:...,
 * >123456789012<, "account 123456789012"). Digits inside a hex or base64
 * value (an ETag, a request ID) touch letters, and are not one. */
static bool has_account_id(const unsigned char *p, size_t len) {
    size_t i = 0;
    while (i < len) {
        if (!isdigit(p[i])) {
            i++;
            continue;
        }
        size_t start = i;
        while (i < len && isdigit(p[i])) i++;
        bool alone = (start == 0 || !isalpha(p[start - 1])) && (i == len || !isalpha(p[i]));
        if (i - start == 12 && alone) return true;
    }
    return false;
}

/* The caller's half of the one rule for printing anything received
 * (lm_lines.h makes the decision, on the bytes and on the text that would be
 * written, and adds the search for our credentials and signatures in every
 * registered form): nothing shaped like an access key ID (AKIA or ASIA and
 * sixteen more), and no twelve-digit number standing alone (an account ID). */
static bool may_print(const void *data, size_t len) {
    return !has_key_id_pattern(data, len) && !has_account_id(data, len);
}

/* ---- the request ---- */

typedef struct {
    char text[16384];
    size_t len;
    char amz_date[17];
    char credential_scope[128];
    char signed_headers[1024];
} request;

static void build_request(request *rq, unsigned number) {
    char *t = rq->text;
    size_t cap = sizeof(rq->text);
    int n;
    if (!P.sign) {
        n = snprintf(t, cap, "GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: " USER_AGENT "\r\nx-amz-checksum-mode: ENABLED\r\n\r\n", S.target, S.host_header);
        if (n < 0 || (size_t)n >= cap) lm_die("the request is too long");
        rq->len = (size_t)n;
        return;
    }
    struct timespec wall;
    clock_gettime(CLOCK_REALTIME, &wall);
    struct tm utc;
    gmtime_r(&wall.tv_sec, &utc);
    strftime(rq->amz_date, sizeof(rq->amz_date), "%Y%m%dT%H%M%SZ", &utc);
    lm_sigv4_header headers[5] = {
        { "host", S.host_header },
        { "x-amz-checksum-mode", "ENABLED" },
        { "x-amz-content-sha256", EMPTY_SHA256 },
        { "x-amz-date", rq->amz_date },
        { "x-amz-security-token", S.token },
    };
    lm_sigv4_request sr = {
        .method = "GET", .canonical_uri = S.target, .canonical_query = "", .headers = headers,
        .header_count = S.token != NULL ? 5 : 4, .payload_sha256 = EMPTY_SHA256, .amz_date = rq->amz_date,
        .region = S.region, .service = "s3", .access_key_id = S.key_id, .secret_access_key = S.secret,
    };
    static lm_sigv4_result signed_;
    const char *why = lm_sigv4_sign(&sr, &signed_);
    if (why != NULL) lm_die("cannot sign the request: %s", why);
    if (!lm_secret_add(SECRET_SIGNATURES + (int)(number % (LM_SECRET_SLOTS - SECRET_SIGNATURES)), signed_.signature, strlen(signed_.signature))) {
        lm_die("a signature could be mistaken for the stream's own text"); /* 64 hex digits: cannot happen */
    }
    snprintf(rq->credential_scope, sizeof(rq->credential_scope), "%s", signed_.credential_scope);
    snprintf(rq->signed_headers, sizeof(rq->signed_headers), "%s", signed_.signed_headers);
    n = snprintf(t, cap,
                 "GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: " USER_AGENT "\r\nx-amz-checksum-mode: ENABLED\r\n"
                 "x-amz-content-sha256: " EMPTY_SHA256 "\r\nx-amz-date: %s\r\n%s%s%sAuthorization: %s\r\n\r\n",
                 S.target, S.host_header, rq->amz_date, S.token ? "x-amz-security-token: " : "", S.token ? S.token : "", S.token ? "\r\n" : "",
                 signed_.authorization);
    OPENSSL_cleanse(&signed_, sizeof(signed_));
    if (n < 0 || (size_t)n >= cap) lm_die("the request is too long");
    rq->len = (size_t)n;
}

/* The request's headers as sent, except the values that carry a credential. */
static void request_sent_fields(lm_lines *b, const request *rq) {
    lm_lines_str(b, "method", "GET");
    lm_lines_str(b, "target", S.target);
    lm_lines_u64(b, "request_bytes", rq->len);
    lm_lines_array(b, "headers");
    const char *names[] = { "Host", "User-Agent", "x-amz-checksum-mode", "x-amz-content-sha256", "x-amz-date", "x-amz-security-token", "Authorization" };
    const char *values[] = { S.host_header, USER_AGENT, "ENABLED", EMPTY_SHA256, rq->amz_date, "<withheld>", "<withheld>" };
    for (int i = 0; i < 7; i++) {
        if (!P.sign && i >= 3) break;
        if (i == 5 && S.token == NULL) continue;
        lm_lines_array(b, NULL);
        lm_lines_str(b, NULL, names[i]);
        lm_lines_str(b, NULL, values[i]);
        lm_lines_close(b);
    }
    lm_lines_close(b);
    if (P.sign) {
        lm_lines_object(b, "signing");
        lm_lines_str(b, "algorithm", "AWS4-HMAC-SHA256");
        lm_lines_str(b, "credential_scope", rq->credential_scope);
        lm_lines_str(b, "signed_headers", rq->signed_headers);
        lm_lines_close(b);
    }
}

/* ---- a connection ---- */

typedef struct {
    bool open;
    unsigned number;
    unsigned requests;
    int fd;
    lm_tls_conn *tls;
    uint32_t address;
    char address_text[INET_ADDRSTRLEN];
} connection;

static unsigned g_next_connection;

static int new_tcp_socket(void) {
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) lm_die("socket: %s", strerror(errno));
    int one = 1;
    if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)) != 0) lm_die("TCP_NODELAY: %s", strerror(errno));
    struct timeval tv = { (time_t)(P.timeout_ms / 1000), (suseconds_t)((P.timeout_ms % 1000) * 1000) };
    /* SO_SNDTIMEO also bounds a blocking connect() on Linux. */
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv)) != 0 || setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv)) != 0) {
        lm_die("socket timeouts: %s", strerror(errno));
    }
    return fd;
}

static bool nodelay_set(int fd) {
    int value = 0;
    socklen_t len = sizeof(value);
    return getsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &value, &len) == 0 && value != 0;
}

static void tcp_info_fields(lm_lines *b, int fd) {
    struct tcp_info info;
    memset(&info, 0, sizeof(info));
    socklen_t len = sizeof(info);
    if (getsockopt(fd, IPPROTO_TCP, TCP_INFO, &info, &len) != 0) return;
    lm_lines_object(b, "tcp_info");
    lm_lines_u64(b, "rtt_us", info.tcpi_rtt);
    lm_lines_u64(b, "rttvar_us", info.tcpi_rttvar);
    if (len >= offsetof(struct tcp_info, tcpi_min_rtt) + sizeof(info.tcpi_min_rtt)) lm_lines_u64(b, "min_rtt_us", info.tcpi_min_rtt);
    lm_lines_u64(b, "rcv_rtt_us", info.tcpi_rcv_rtt);
    lm_lines_u64(b, "rcv_space", info.tcpi_rcv_space);
    lm_lines_u64(b, "rcv_mss", info.tcpi_rcv_mss);
    lm_lines_u64(b, "snd_mss", info.tcpi_snd_mss);
    lm_lines_u64(b, "pmtu", info.tcpi_pmtu);
    lm_lines_u64(b, "snd_cwnd", info.tcpi_snd_cwnd);
    lm_lines_u64(b, "total_retrans", info.tcpi_total_retrans);
    if (len >= offsetof(struct tcp_info, tcpi_segs_in) + sizeof(info.tcpi_segs_in)) {
        lm_lines_u64(b, "bytes_acked", info.tcpi_bytes_acked);
        lm_lines_u64(b, "bytes_received", info.tcpi_bytes_received);
        lm_lines_u64(b, "segs_out", info.tcpi_segs_out);
        lm_lines_u64(b, "segs_in", info.tcpi_segs_in);
    }
    lm_lines_close(b);
}

static void local_address(lm_lines *b, int fd) {
    struct sockaddr_in local;
    socklen_t len = sizeof(local);
    if (getsockname(fd, (struct sockaddr *)&local, &len) != 0 || local.sin_family != AF_INET) return;
    char text[INET_ADDRSTRLEN + 8];
    inet_ntop(AF_INET, &local.sin_addr, text, INET_ADDRSTRLEN);
    snprintf(text + strlen(text), 8, ":%u", ntohs(local.sin_port));
    lm_lines_str(b, "local", text);
}

/* Closes a connection and writes `connection_closed`, outside any sample. */
static void close_connection(connection *c, const char *reason, bool notify) {
    if (!c->open) return;
    if (notify && c->tls != NULL) lm_tls_shutdown(c->tls);
    unsigned tickets = c->tls != NULL ? lm_tls_tickets(c->tls) : 0;
    unsigned sessions = c->tls != NULL ? lm_tls_sessions(c->tls) : 0;
    close(c->fd);
    uint64_t t = lm_now_ns();
    lm_tls_free(c->tls);
    c->tls = NULL;
    c->open = false;
    lm_lines_begin(&g_out, "connection_closed", t);
    lm_lines_u64(&g_out, "connection", c->number);
    lm_lines_str(&g_out, "reason", reason);
    lm_lines_u64(&g_out, "requests", c->requests);
    lm_lines_u64(&g_out, "sessions_received", sessions);
    lm_lines_u64(&g_out, "session_tickets_received", tickets);
    lm_lines_end(&g_out);
}

/* ---- failures ---- */

enum { F_DNS, F_TIMEOUT, F_REFUSED, F_UNREACHABLE, F_RESET, F_EOF, F_TLS, F_ALERT, F_VERIFY, F_PROTOCOL, F_SYSTEM, F_COUNT };
static const char *const FAILURE_NAMES[F_COUNT] = { "dns", "timeout", "refused", "unreachable", "reset", "eof", "tls", "alert", "verify", "protocol", "system" };

static int failure_of_tls(int e) {
    switch (e) {
    case LM_TLS_TIMEOUT: return F_TIMEOUT;
    case LM_TLS_RESET: return F_RESET;
    case LM_TLS_EOF: return F_EOF;
    case LM_TLS_VERIFY: return F_VERIFY;
    case LM_TLS_PROTOCOL: return F_TLS;
    case LM_TLS_ALERT: return F_ALERT;
    default: return F_SYSTEM;
    }
}

static int failure_of_errno(int e) {
    switch (e) {
    case EINPROGRESS: case EAGAIN: case ETIMEDOUT: return F_TIMEOUT;
    case ECONNREFUSED: return F_REFUSED;
    case ENETUNREACH: case EHOSTUNREACH: case ENETDOWN: return F_UNREACHABLE;
    case ECONNRESET: case EPIPE: return F_RESET;
    default: return F_SYSTEM;
    }
}

/* What a failed TLS call left to say: the library's words, and the alert the
 * server sent, if that is what ended it. */
typedef struct {
    int failure;             /* -1, or an F_ value */
    const char *phase;
    char detail[256];
    int alert;               /* the alert's code, or -1 */
    const char *alert_name;
} failure_record;

static void failure_none(failure_record *f) {
    f->failure = -1;
    f->alert = -1;
    f->alert_name = "";
}

/* After the clock has been read: what the failed TLS call was. */
static void failure_from_tls(failure_record *f, lm_tls_conn *tls, int e, const char *phase) {
    if (e == LM_TLS_FAILED) e = lm_tls_failure(tls);
    f->failure = failure_of_tls(e);
    f->phase = phase;
    snprintf(f->detail, sizeof(f->detail), "%s", lm_tls_error_detail(tls));
    f->alert = lm_tls_alert(tls);
    f->alert_name = lm_tls_alert_name(tls);
}

/* ---- name resolution, connecting, securing: the phases before a request ---- */

typedef struct {
    int fd;
    uint16_t id;
    uint8_t query[512];
    size_t query_len;
} dns_query;

static void dns_prepare(dns_query *q) {
    q->fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (q->fd < 0) lm_die("socket: %s", strerror(errno));
    struct timeval tv = { (time_t)(P.timeout_ms / 1000), (suseconds_t)((P.timeout_ms % 1000) * 1000) };
    if (setsockopt(q->fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv)) != 0) lm_die("SO_RCVTIMEO: %s", strerror(errno));
    if (connect(q->fd, (struct sockaddr *)&g_resolver, sizeof(g_resolver)) != 0) lm_die("connect to the resolver %s: %s", g_resolver_text, strerror(errno));
    if (getrandom(&q->id, sizeof(q->id), 0) != sizeof(q->id)) lm_die("getrandom: %s", strerror(errno));
    q->query_len = lm_dns_query(q->query, sizeof(q->query), q->id, S.host);
    if (q->query_len == 0) lm_die("the endpoint's host cannot be put in a DNS query");
}

/* Everything the phases before a request found, for its events. */
typedef struct {
    mark start;              /* sample_started, or the setup's own start */
    bool dns_replied;
    mark dns;
    size_t reply_bytes;      /* the reply's real length */
    size_t reply_read;       /* how much of it the buffer held */
    const char *dns_problem; /* why the reply is not usable */
    mark tcp;
    bool connected;
    mark tls;
    bool secured;
    failure_record f;
} setup;

static uint8_t g_dns_buffer[DNS_BUFFER];
static lm_dns_reply g_reply;

/* Before a sample: the socket and the TLS object the next connection will
 * use, so neither is made inside a timed phase. */
static void prepare_connection(connection *c) {
    c->fd = new_tcp_socket();
    c->tls = lm_tls_new(S.host);
    if (c->tls == NULL) lm_die("cannot make a TLS connection object");
}

/* After a failed name resolution, or a sample the budget stopped before it
 * started: no connection was attempted, so nothing is written. */
static void discard_prepared(connection *c) {
    close(c->fd);
    lm_tls_free(c->tls);
    c->tls = NULL;
}

/* Resolves, connects and secures `c`. The caller has read `s->start` just
 * before; each boundary is read just after the work that ends its phase. */
static bool open_connection(connection *c, dns_query *q, setup *s) {
    failure_none(&s->f);
    ssize_t sent = send(q->fd, q->query, q->query_len, 0);
    if (sent != (ssize_t)q->query_len) {
        s->dns = now_mark();
        s->f.failure = failure_of_errno(errno);
        s->f.phase = "dns";
        snprintf(s->f.detail, sizeof(s->f.detail), "send to the resolver: %s", strerror(errno));
        close(q->fd);
        discard_prepared(c);
        return false;
    }
    /* MSG_TRUNC: the datagram's real length, even when the buffer is shorter. */
    ssize_t got = recv(q->fd, g_dns_buffer, sizeof(g_dns_buffer), MSG_TRUNC);
    if (got < 0) {
        s->dns = now_mark();
        int saved = errno;
        close(q->fd);
        s->f.failure = failure_of_errno(saved);
        s->f.phase = "dns";
        snprintf(s->f.detail, sizeof(s->f.detail), "no reply from the resolver: %s", strerror(saved));
        discard_prepared(c);
        return false;
    }
    s->dns_replied = true;
    s->reply_bytes = (size_t)got;
    s->reply_read = s->reply_bytes < sizeof(g_dns_buffer) ? s->reply_bytes : sizeof(g_dns_buffer);
    /* The parse is part of the DNS phase: it decides whether there is an
     * address. Formatting the records as text waits until the request ends. */
    const char *why = lm_dns_parse(g_dns_buffer, s->reply_read, &g_reply);
    if (why == NULL) {
        if (g_reply.id != q->id) why = "the reply's ID is not the query's";
        else if (!g_reply.qr) why = "the reply is not a response";
        else if (!g_reply.has_question || !lm_dns_name_is(g_dns_buffer, s->reply_read, g_reply.qname_at, S.host) || g_reply.qtype != LM_DNS_TYPE_A) why = "the reply's question is not the query's";
        else if (g_reply.tc) why = "the reply was truncated (TC set)";
        else if (g_reply.rcode != 0) why = "the reply's rcode is not NOERROR";
        else if (!g_reply.has_address) why = "the reply has no A record for the name";
    }
    s->dns = now_mark();
    close(q->fd);
    if (why != NULL) {
        s->dns_problem = why;
        s->f.failure = F_DNS;
        s->f.phase = "dns";
        snprintf(s->f.detail, sizeof(s->f.detail), "%s", why);
        discard_prepared(c);
        return false;
    }

    c->address = g_reply.address;
    struct sockaddr_in peer = { .sin_family = AF_INET, .sin_port = htons(S.port) };
    peer.sin_addr.s_addr = c->address;
    c->number = g_next_connection++;
    c->requests = 0;
    c->open = true;
    R.connections_opened++;

    int r = connect(c->fd, (struct sockaddr *)&peer, sizeof(peer));
    s->tcp = now_mark();
    if (r != 0) {
        int saved = errno;
        s->f.failure = failure_of_errno(saved);
        s->f.phase = "connect";
        snprintf(s->f.detail, sizeof(s->f.detail), "%s", saved == EINPROGRESS ? "the connection was not established within timeout_ms" : strerror(saved));
        return false;
    }
    s->connected = true;
    int e = lm_tls_handshake(c->tls, c->fd);
    s->tls = now_mark();
    if (e != LM_TLS_OK) {
        failure_from_tls(&s->f, c->tls, e, "tls");
        return false;
    }
    s->secured = true;
    return true;
}

/* The server's chain, each certificate's SHA-256 leaf first, written as
 * `peer_chain_sha256` (all of them, uncut); and a `certificate` event at `t`
 * for each one this Run has not written yet. The certificate events are
 * written by certificate_events(), after the line holding the fingerprints. */
typedef struct {
    size_t count;
    unsigned char (*digest)[32];
} chain_digests;

static chain_digests chain_of(lm_tls_conn *tls) {
    chain_digests d = { lm_tls_peer_chain_count(tls), NULL };
    if (d.count == 0) return d;
    d.digest = malloc(d.count * 32);
    if (d.digest == NULL) lm_die("cannot allocate the chain's digests");
    for (size_t i = 0; i < d.count; i++) {
        const unsigned char *der;
        size_t len;
        lm_tls_peer_cert(tls, i, &der, &len);
        SHA256(der, len, d.digest[i]);
    }
    return d;
}

static void chain_field(lm_lines *b, const chain_digests *d) {
    lm_lines_array(b, "peer_chain_sha256");
    for (size_t i = 0; i < d->count; i++) lm_lines_hex(b, NULL, d->digest[i], 32);
    lm_lines_close(b);
}

static void certificate_events(lm_tls_conn *tls, const chain_digests *d, uint64_t t) {
    for (size_t i = 0; i < d->count; i++) {
        bool seen = false;
        for (size_t k = 0; k < g_seen_cert_count && !seen; k++) seen = memcmp(g_seen_certs[k], d->digest[i], 32) == 0;
        if (seen) continue;
        if (g_seen_cert_count == g_seen_cert_cap) {
            size_t cap = g_seen_cert_cap ? 2 * g_seen_cert_cap : 16;
            unsigned char (*grown)[32] = realloc(g_seen_certs, cap * 32);
            if (grown == NULL) lm_die("cannot remember the Run's certificates");
            g_seen_certs = grown;
            g_seen_cert_cap = cap;
        }
        memcpy(g_seen_certs[g_seen_cert_count++], d->digest[i], 32);
        const unsigned char *der;
        size_t len;
        lm_tls_peer_cert(tls, i, &der, &len);
        lm_lines_begin(&g_out, "certificate", t);
        lm_lines_hex(&g_out, "sha256", d->digest[i], 32);
        lm_lines_base64(&g_out, "der_base64", der, len);
        lm_lines_end(&g_out);
    }
}

static void dns_records(lm_lines *b, const char *key, const lm_dns_record *records, unsigned count, size_t reply_len) {
    lm_lines_array(b, key);
    for (unsigned i = 0; i < count; i++) {
        char *text = lm_dns_record_text(g_dns_buffer, reply_len, &records[i]);
        lm_lines_bytes(b, NULL, text, strlen(text));
        free(text);
    }
    lm_lines_close(b);
}

/* Writes the events of the phases before a request: name_resolved,
 * connection_opened, connection_secured, any new certificate. `request` is
 * the sample's number, or -1 for a reused connection's setup outside any
 * sample. A failed handshake leaves its chain, if the server sent one, for
 * the failure event (failure_chain). */
static void setup_events(const connection *c, const setup *s, long request) {
    if (s->dns_replied) {
        const lm_dns_reply *r = &g_reply;
        lm_lines_begin(&g_out, "name_resolved", s->dns.t);
        if (request >= 0) lm_lines_u64(&g_out, "request", (uint64_t)request);
        lm_lines_str(&g_out, "server", g_resolver_text);
        lm_lines_str(&g_out, "name", S.host);
        lm_lines_u64(&g_out, "reply_bytes", s->reply_bytes);
        if (s->reply_read < s->reply_bytes) lm_lines_u64(&g_out, "reply_bytes_read", s->reply_read);
        lm_lines_u64(&g_out, "rcode", r->rcode);
        lm_lines_bool(&g_out, "truncated", r->tc);
        dns_records(&g_out, "answers", r->answer, r->answers, s->reply_read);
        if (r->authorities > 0) dns_records(&g_out, "authority", r->authority, r->authorities, s->reply_read);
        if (r->additionals > 0) dns_records(&g_out, "additional", r->additional, r->additionals, s->reply_read);
        if (r->end > 0 && r->end < s->reply_read) lm_lines_u64(&g_out, "trailing_bytes", s->reply_read - r->end);
        if (s->dns_problem == NULL) {
            char text[INET_ADDRSTRLEN];
            inet_ntop(AF_INET, &r->address, text, sizeof(text));
            lm_lines_str(&g_out, "address", text);
        }
        lm_lines_u64(&g_out, "cpu_ns", s->dns.cpu - s->start.cpu);
        lm_lines_end(&g_out);
    }
    if (s->dns_problem != NULL || !s->dns_replied) return;

    char address[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &c->address, address, sizeof(address));
    lm_lines_begin(&g_out, "connection_opened", s->tcp.t);
    lm_lines_u64(&g_out, "connection", c->number);
    if (request >= 0) lm_lines_u64(&g_out, "request", (uint64_t)request);
    lm_lines_str(&g_out, "address", address);
    lm_lines_u64(&g_out, "port", S.port);
    if (s->connected) {
        lm_lines_bool(&g_out, "nodelay", nodelay_set(c->fd));
        local_address(&g_out, c->fd);
    }
    lm_lines_u64(&g_out, "cpu_ns", s->tcp.cpu - s->dns.cpu);
    lm_lines_end(&g_out);
    if (!s->connected || !s->secured) return;

    chain_digests chain = chain_of(c->tls);
    char alpn[64];
    lm_tls_alpn(c->tls, alpn, sizeof(alpn));
    lm_lines_begin(&g_out, "connection_secured", s->tls.t);
    lm_lines_u64(&g_out, "connection", c->number);
    lm_lines_str(&g_out, "tls", lm_tls_version(c->tls));
    lm_lines_str(&g_out, "cipher", lm_tls_cipher(c->tls));
    lm_lines_str(&g_out, "group", lm_tls_group(c->tls));
    lm_lines_str(&g_out, "peer_signature", lm_tls_peer_signature(c->tls));
    lm_lines_str(&g_out, "alpn", alpn);
    lm_lines_bool(&g_out, "hello_retry", lm_tls_hello_retry(c->tls));
    lm_lines_bool(&g_out, "resumed", lm_tls_resumed(c->tls));
    lm_lines_str(&g_out, "verify", lm_tls_verify_result(c->tls));
    chain_field(&g_out, &chain);
    lm_lines_u64(&g_out, "cpu_ns", s->tls.cpu - s->tcp.cpu);
    lm_lines_end(&g_out);
    certificate_events(c->tls, &chain, s->tls.t);
    free(chain.digest);
}

/* Starts a failure event; the caller adds what else it has and ends the line. */
static void failure_event(const char *name, mark at, long request, const failure_record *f) {
    lm_lines_begin(&g_out, name, at.t);
    if (request >= 0) lm_lines_u64(&g_out, "request", (uint64_t)request);
    lm_lines_str(&g_out, "phase", f->phase);
    lm_lines_str(&g_out, "error", FAILURE_NAMES[f->failure]);
    lm_lines_str(&g_out, "detail", f->detail);
    if (f->failure == F_ALERT) {
        lm_lines_u64(&g_out, "alert", (uint64_t)f->alert);
        lm_lines_str(&g_out, "alert_name", f->alert_name);
    }
}

/* The failure of the phases before a request (request_failed in a sample,
 * connection_failed outside one), with the chain a failed handshake was
 * shown: its certificates first, each new one as a `certificate` event, then
 * the failure with their fingerprints. */
static mark setup_failure(const connection *c, const setup *s, const char *name, long request) {
    mark end = s->connected ? s->tls : c->open ? s->tcp : s->dns;
    chain_digests chain = { 0, NULL };
    if (s->connected && c->tls != NULL) chain = chain_of(c->tls);
    if (chain.count > 0) certificate_events(c->tls, &chain, end.t);
    failure_event(name, end, request, &s->f);
    if (request >= 0) lm_lines_u64(&g_out, "bytes_received", 0);
    if (chain.count > 0) chain_field(&g_out, &chain);
    lm_lines_end(&g_out);
    free(chain.digest);
    return end;
}

/* ---- one request on an open connection ---- */

typedef enum { DONE_RESPONSE, DONE_FAILED } outcome;

typedef struct {
    mark sent, first, head, end;
    bool wrote, got_first, got_head;
    lm_http_response resp;
    failure_record f;
    uint64_t surplus;        /* bytes received after the end of the response, in the same record */
} exchange;

static unsigned char g_scratch[16384 + 512];

/* A failure found by this program (the parser, the bytes after a response,
 * an early close_notify): the clock is read first, then the words formatted. */
static outcome exchange_failed_at(exchange *x, mark at, int failure, const char *phase, const char *detail) {
    x->end = at;
    x->f.failure = failure;
    x->f.phase = phase;
    snprintf(x->f.detail, sizeof(x->f.detail), "%s", detail);
    return DONE_FAILED;
}

static outcome exchange_failed(exchange *x, int failure, const char *phase, const char *detail) {
    return exchange_failed_at(x, now_mark(), failure, phase, detail);
}

static const char *phase_now(const exchange *x) { return !x->got_first ? "first_byte" : !x->got_head ? "headers" : "body"; }

/* After the response ended: bytes beyond it that came in the same record as
 * its last bytes (still in our read buffer, or still in the library's) were
 * received with it, and make it a protocol error. Bytes in a later record
 * are not looked for: see check_idle(). */
static bool surplus_found(connection *c, exchange *x, size_t unread_in_buffer) {
    x->surplus = unread_in_buffer + lm_tls_pending(c->tls);
    if (x->surplus == 0) return false;
    mark at = now_mark();
    char detail[96];
    snprintf(detail, sizeof(detail), "%" PRIu64 " bytes after the end of the response", x->surplus);
    exchange_failed_at(x, at, F_PROTOCOL, "body", detail);
    return true;
}

/* Writes the request and reads its response. Each boundary is read just
 * after the call that ends its phase returns; the header block's end is read
 * once the parser has taken the block and before any body byte is handled. */
static outcome do_exchange(connection *c, const request *rq, exchange *x) {
    failure_none(&x->f);
    int e = lm_tls_write(c->tls, rq->text, rq->len);
    if (e != LM_TLS_OK) {
        x->end = now_mark();
        failure_from_tls(&x->f, c->tls, e, "send");
        return DONE_FAILED;
    }
    x->sent = now_mark();
    x->wrote = true;
    lm_http_response *resp = &x->resp;
    for (;;) {
        unsigned char *where;
        size_t room;
        bool direct = x->got_head && lm_http_direct(resp, &where, &room);
        if (resp->state == LM_HTTP_ERROR) break; /* the body buffer is full */
        long n = direct ? lm_tls_read(c->tls, where, room) : lm_tls_read(c->tls, g_scratch, sizeof(g_scratch));
        if (n > 0) {
            if (!x->got_first) {
                x->first = now_mark();
                x->got_first = true;
            }
            size_t unread = 0;
            if (direct) {
                lm_http_direct_done(resp, (size_t)n);
            } else {
                size_t used = 0;
                if (resp->state == LM_HTTP_HEAD) {
                    used = lm_http_feed(resp, g_scratch, (size_t)n);
                    if (resp->state == LM_HTTP_ERROR) break;
                    if (resp->state != LM_HTTP_HEAD) {
                        x->head = now_mark();
                        x->got_head = true;
                    }
                }
                if (resp->state == LM_HTTP_BODY && used < (size_t)n) {
                    used += lm_http_feed(resp, g_scratch + used, (size_t)n - used);
                    if (resp->state == LM_HTTP_ERROR) break;
                }
                unread = (size_t)n - used;
            }
            if (resp->state == LM_HTTP_DONE) {
                if (surplus_found(c, x, unread)) return DONE_FAILED;
                x->end = now_mark();
                return DONE_RESPONSE;
            }
            continue;
        }
        if (n == 0) {
            lm_http_eof(resp);
            mark at = now_mark();
            if (resp->state == LM_HTTP_DONE) {
                x->end = at;
                return DONE_RESPONSE;
            }
            char detail[256];
            snprintf(detail, sizeof(detail), "close_notify: %s", resp->error);
            return exchange_failed_at(x, at, F_EOF, phase_now(x), detail);
        }
        x->end = now_mark();
        failure_from_tls(&x->f, c->tls, (int)-n, phase_now(x));
        return DONE_FAILED;
    }
    return exchange_failed(x, F_PROTOCOL, !x->got_head ? "headers" : "body", resp->error);
}

/* The first XML element `name` of an S3 error body, under the rule. */
static void xml_field(lm_lines *b, const unsigned char *body, size_t len, const char *name) {
    char open[64], close_[64];
    snprintf(open, sizeof(open), "<%s>", name);
    snprintf(close_, sizeof(close_), "</%s>", name);
    const unsigned char *start = memmem(body, len, open, strlen(open));
    if (start == NULL) return;
    start += strlen(open);
    const unsigned char *end = memmem(start, len - (size_t)(start - body), close_, strlen(close_));
    if (end == NULL) return;
    lm_lines_bytes(b, name, start, (size_t)(end - start));
}

/* The name of every element of an error body, in order, without its value:
 * what a reader can know of the body's shape. */
static void xml_element_names(lm_lines *b, const unsigned char *body, size_t len) {
    unsigned count = 0;
    lm_lines_array(b, "error_elements");
    for (size_t i = 0; i + 1 < len; i++) {
        if (body[i] != '<' || body[i + 1] == '/' || body[i + 1] == '?' || body[i + 1] == '!') continue;
        size_t start = i + 1, end = start;
        while (end < len && body[end] != '>' && body[end] != '/' && body[end] != ' ' && body[end] != '\t' && body[end] != '\r' && body[end] != '\n' && body[end] != '<') end++;
        if (end == start || end == len || body[end] == '<') continue;
        if (count < MAX_ERROR_ELEMENTS) lm_lines_bytes(b, NULL, body + start, end - start);
        count++;
        i = end - 1;
    }
    lm_lines_close(b);
    if (count > MAX_ERROR_ELEMENTS) lm_lines_u64(b, "error_elements_total", count);
}

/* Base64 decode of S3's x-amz-checksum-sha256; true when it is 32 bytes equal to `digest`. */
static bool checksum_matches(const unsigned char *value, size_t len, const unsigned char digest[32]) {
    char expected[48];
    if (lm_base64(digest, 32, expected) != 44) return false;
    return len == 44 && memcmp(value, expected, 44) == 0;
}

static void field_pairs(lm_lines *b, const char *key, const unsigned char *base, const lm_http_header *fields, unsigned count) {
    lm_lines_array(b, key);
    for (unsigned i = 0; i < count; i++) {
        lm_lines_array(b, NULL);
        lm_lines_bytes(b, NULL, base + fields[i].name, fields[i].name_len);
        lm_lines_bytes(b, NULL, base + fields[i].value, fields[i].value_len);
        lm_lines_close(b);
    }
    lm_lines_close(b);
}

static bool status_2xx(const lm_http_response *resp) { return resp->status >= 200 && resp->status < 300; }

/* Writes request_sent, first_byte, response_headers and response_ended (or
 * request_failed) for an exchange, after the sample has ended, and judges the
 * body. `before` is the boundary before the request was written: the end of
 * the handshake on a new connection, the sample's start on a reused one. */
static void exchange_events(connection *c, const request *rq, exchange *x, unsigned request_number, outcome o, mark before) {
    lm_http_response *resp = &x->resp;
    if (x->wrote) {
        lm_lines_begin(&g_out, "request_sent", x->sent.t);
        lm_lines_u64(&g_out, "request", request_number);
        lm_lines_u64(&g_out, "connection", c->number);
        request_sent_fields(&g_out, rq);
        lm_lines_u64(&g_out, "cpu_ns", x->sent.cpu - before.cpu);
        lm_lines_end(&g_out);
    }
    if (x->got_first) {
        lm_lines_begin(&g_out, "first_byte", x->first.t);
        lm_lines_u64(&g_out, "request", request_number);
        lm_lines_u64(&g_out, "cpu_ns", x->first.cpu - x->sent.cpu);
        lm_lines_end(&g_out);
    }
    if (x->got_head) {
        lm_lines_begin(&g_out, "response_headers", x->head.t);
        lm_lines_u64(&g_out, "request", request_number);
        lm_lines_bytes(&g_out, "status_line", resp->head, resp->status_line_len);
        lm_lines_u64(&g_out, "status", resp->status);
        field_pairs(&g_out, "headers", resp->head, resp->header, resp->headers);
        lm_lines_u64(&g_out, "cpu_ns", x->head.cpu - x->first.cpu);
        lm_lines_end(&g_out);
    }
    uint64_t taken = resp->head_len + resp->wire_bytes; /* what the parser took, wherever it stopped */

    if (o == DONE_FAILED) {
        R.requests_failed++;
        R.any_error = true;
        R.failures[x->f.failure]++;
        failure_event("request_failed", x->end, request_number, &x->f);
        lm_lines_u64(&g_out, "bytes_received", taken);
        if (x->surplus > 0) lm_lines_u64(&g_out, "surplus_bytes", x->surplus);
        if (x->wrote && !x->got_head && resp->head_len > 0) {
            /* A header block that never completed, or completed and did not parse. */
            if (resp->head_len <= MAX_PRINTED_HEAD) {
                lm_lines_bytes(&g_out, "head_received", resp->head, resp->head_len);
            } else {
                lm_lines_object(&g_out, "head_received");
                lm_lines_u64(&g_out, "withheld_bytes", resp->head_len);
                lm_lines_close(&g_out);
            }
        }
        if (x->got_head) {
            if (resp->framing == LM_HTTP_LENGTH) lm_lines_u64(&g_out, "content_length", resp->content_length);
            lm_lines_u64(&g_out, "body_bytes_received", resp->body_len);
            if (status_2xx(resp)) {
                unsigned char partial[32];
                SHA256(g_body, resp->body_len, partial);
                lm_lines_hex(&g_out, "body_sha256_received", partial, 32);
            }
        }
        /* Trailer lines already taken (each one checked) before the failure. */
        if (resp->trailers > 0) field_pairs(&g_out, "trailers", resp->trailer, resp->trailer_field, resp->trailers);
        tcp_info_fields(&g_out, c->fd);
        lm_lines_end(&g_out);
        return;
    }

    /* A complete response. */
    R.responses++;
    R.statuses[resp->status]++; /* three digits, by the parser */
    bool ok_status = status_2xx(resp);
    static const char *const FRAMING[] = { "none", "length", "chunked", "close" };
    lm_lines_begin(&g_out, "response_ended", x->end.t);
    lm_lines_u64(&g_out, "request", request_number);
    lm_lines_u64(&g_out, "bytes", resp->body_len);
    lm_lines_u64(&g_out, "wire_bytes", resp->wire_bytes);
    lm_lines_str(&g_out, "framing", FRAMING[resp->framing]);
    if (resp->trailers > 0) field_pairs(&g_out, "trailers", resp->trailer, resp->trailer_field, resp->trailers);
    lm_lines_u64(&g_out, "cpu_ns", x->end.cpu - x->head.cpu);
    tcp_info_fields(&g_out, c->fd);
    if (ok_status) {
        unsigned char digest[32];
        SHA256(g_body, resp->body_len, digest);
        SHA256_Update(&R.digests, digest, sizeof(digest));
        lm_lines_hex(&g_out, "body_sha256", digest, 32);
        bool fixture = resp->body_len == P.object_bytes && memcmp(digest, g_fixture_sha256, 32) == 0;
        size_t checksum_len = 0;
        const unsigned char *checksum = lm_http_get(resp, "x-amz-checksum-sha256", &checksum_len);
        const char *s3 = checksum == NULL ? "absent" : checksum_matches(checksum, checksum_len, digest) ? "match" : "mismatch";
        lm_lines_str(&g_out, "fixture", fixture ? "match" : "mismatch");
        lm_lines_str(&g_out, "s3_checksum", s3);
        if (fixture && strcmp(s3, "match") == 0) {
            R.responses_2xx_verified++;
            R.verified_body_bytes = resp->body_len;
            R.have_verified_body_bytes = true;
        } else {
            R.body_mismatch = true;
        }
    } else {
        /* An error body: its length (above), S3's four fields under the rule,
         * and the names of its elements. Nothing else of it, not even a digest. */
        R.any_error = true;
        lm_lines_object(&g_out, "error_fields");
        xml_field(&g_out, g_body, resp->body_len, "Code");
        xml_field(&g_out, g_body, resp->body_len, "Message");
        xml_field(&g_out, g_body, resp->body_len, "RequestId");
        xml_field(&g_out, g_body, resp->body_len, "HostId");
        lm_lines_close(&g_out);
        xml_element_names(&g_out, g_body, resp->body_len);
    }
    lm_lines_end(&g_out);
}

/* ---- samples ---- */

/* A sample's two lines. Every field of sample_started is known when the
 * sample starts, so it is written first, before the request's other events,
 * and the whole request is written once it has ended. */
static void sample_started_line(unsigned sample, bool warmup, uint64_t t) {
    lm_lines_begin(&g_out, "sample_started", t);
    lm_lines_u64(&g_out, "sample", sample);
    lm_lines_bool(&g_out, "warmup", warmup);
    lm_lines_u64(&g_out, "repetitions", 1);
    lm_lines_end(&g_out);
}

static void sample_ended_line(unsigned sample, uint64_t t) {
    lm_lines_begin(&g_out, "sample_ended", t);
    lm_lines_u64(&g_out, "sample", sample);
    lm_lines_end(&g_out);
}

/* ---- the budget ---- */

static uint64_t g_run_start, g_budget_ns;

static uint64_t monotonic_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

/* Whether the Run's time is up: asked immediately before every sample starts. */
static bool budget_spent(void) { return monotonic_ns() - g_run_start >= g_budget_ns; }

/* ---- the two ways a request is made ---- */

typedef enum { SAMPLE_NOT_STARTED, SAMPLE_REACHED, SAMPLE_UNREACHED } sample_result;

/* One sample over a new connection: the sample starts just before the DNS
 * query is sent. Says whether a server was reached (TLS completed), or that
 * the budget was spent before the sample could start. */
static sample_result new_connection_sample(connection *conn, const request *rq, exchange *x, unsigned sample, bool warmup) {
    dns_query q;
    dns_prepare(&q);
    prepare_connection(conn);
    if (budget_spent()) {
        close(q.fd);
        discard_prepared(conn);
        return SAMPLE_NOT_STARTED;
    }
    setup s;
    memset(&s, 0, sizeof(s));
    s.start = now_mark();
    bool ok = open_connection(conn, &q, &s);
    outcome o = DONE_FAILED;
    if (ok) {
        o = do_exchange(conn, rq, x);
        conn->requests++;
    }
    R.requests_made++;
    sample_started_line(sample, warmup, s.start.t);
    setup_events(conn, &s, sample);
    mark end;
    if (ok) {
        exchange_events(conn, rq, x, sample, o, s.tls);
        end = x->end;
    } else {
        R.requests_failed++;
        R.any_error = true;
        R.failures[s.f.failure]++;
        end = setup_failure(conn, &s, "request_failed", sample);
    }
    sample_ended_line(sample, end.t);
    bool clean = ok && o == DONE_RESPONSE;
    close_connection(conn, clean ? "done" : "failed", clean);
    return ok ? SAMPLE_REACHED : SAMPLE_UNREACHED;
}

/* Before a request on a kept connection: whether the server closed it, or
 * sent anything, while it was idle; if so it is closed, outside any sample.
 * Bytes the server sends after a response has ended, if they arrive between
 * this look and the next request's write, are read as the start of the next
 * response instead: nothing can tell the two apart (README, "Bytes after a
 * response"). */
static void check_idle(connection *conn) {
    const char *why = NULL;
    switch (lm_tls_check_idle(conn->tls, conn->fd)) {
    case LM_TLS_IDLE: return;
    case LM_TLS_IDLE_EOF: why = "eof_while_idle"; break;
    case LM_TLS_IDLE_CLOSE_NOTIFY: why = "close_notify_while_idle"; break;
    case LM_TLS_IDLE_DATA: why = "data_while_idle"; break;
    case LM_TLS_IDLE_ERROR: why = "error_while_idle"; break;
    }
    close_connection(conn, why, false);
    lm_lines_flush(&g_out);
}

/* Opens the kept connection outside any sample. Returns false, its events
 * written, when it failed. */
static bool open_reused(connection *conn) {
    dns_query q;
    dns_prepare(&q);
    prepare_connection(conn);
    setup s;
    memset(&s, 0, sizeof(s));
    s.start = now_mark();
    bool ok = open_connection(conn, &q, &s);
    setup_events(conn, &s, -1);
    if (!ok) {
        R.setups_failed++;
        R.any_error = true;
        R.failures[s.f.failure]++;
        setup_failure(conn, &s, "connection_failed", -1);
        close_connection(conn, "failed", false);
    }
    lm_lines_flush(&g_out);
    return ok;
}

/* One sample on the kept connection: the sample starts just before the
 * request is written. */
static void reused_sample(connection *conn, const request *rq, exchange *x, unsigned sample, bool warmup) {
    mark start = now_mark();
    outcome o = do_exchange(conn, rq, x);
    conn->requests++;
    R.requests_made++;
    sample_started_line(sample, warmup, start.t);
    exchange_events(conn, rq, x, sample, o, start);
    sample_ended_line(sample, x->end.t);
    if (o == DONE_FAILED) close_connection(conn, "failed", false);
    else if (!x->resp.keep_alive) close_connection(conn, "server_requested", true);
}

static uint64_t g_rng = GAP_SEED;

static uint64_t next_gap_ns(void) {
    uint64_t x = (g_rng += 0x9e3779b97f4a7c15ULL);
    x = lm_mix64(x);
    double u = (double)(x >> 11) * (1.0 / 9007199254740992.0); /* [0, 1) */
    return (uint64_t)(-(double)P.gap_mean_ms * 1e6 * log1p(-u));
}

static void sleep_until(uint64_t target) {
    struct timespec ts = { (time_t)(target / 1000000000ULL), (long)(target % 1000000000ULL) };
    while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL) == EINTR) {
    }
}

/* Before anything reads the credentials: no core file, and no other process
 * of this user may read this one's memory (ptrace, /proc/<pid>/mem). */
static void protect_memory(void) {
    struct rlimit none = { 0, 0 };
    if (setrlimit(RLIMIT_CORE, &none) != 0) lm_die("setrlimit(RLIMIT_CORE): %s", strerror(errno));
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) lm_die("prctl(PR_SET_DUMPABLE): %s", strerror(errno));
}

int main(int argc, char **argv) {
    protect_memory();
    signal(SIGPIPE, SIG_IGN);
    lm_start(argc, argv);
    read_params();
    read_service();
    unsigned counted = counted_samples();
    unsigned total = counted + 1; /* request 0 is the warmup */

    read_resolver();
    unsigned char ca_sha256[32];
    sha256_file(P.ca_file, ca_sha256);
    char err[512];
    if (!lm_tls_init(P.ca_file, err, sizeof(err))) lm_die("%s", err);
    g_body_cap = (size_t)P.object_bytes + BODY_SLACK;
    g_body = malloc(g_body_cap);
    if (g_body == NULL) lm_die("cannot allocate %zu bytes for the body", g_body_cap);
    fixture_digest();
    SHA256_Init(&R.digests);
    lm_lines_init(&g_out);
    lm_lines_set_filter(may_print);

    lm_lines_begin(&g_out, "observed", lm_now_ns());
    lm_lines_object(&g_out, "values");
    lm_lines_str(&g_out, "tls_library", lm_tls_library());
    lm_lines_str(&g_out, "tls_library_source_sha256", LM_AWS_LC_SHA256);
    if (!lm_tls_describe_offer(&g_out, S.host, err, sizeof(err))) lm_die("%s", err);
    lm_lines_hex(&g_out, "ca_file_sha256", ca_sha256, 32);
    lm_lines_u64(&g_out, "ca_certificates_loaded", lm_tls_ca_loaded());
    lm_lines_u64(&g_out, "ca_certificates_rejected", lm_tls_ca_rejected());
    lm_lines_str(&g_out, "resolver", g_resolver_text);
    lm_lines_hex(&g_out, "fixture_sha256", g_fixture_sha256, 32);
    lm_lines_u64(&g_out, "body_buffer_bytes", g_body_cap);
    lm_lines_u64(&g_out, "cpu_clock_read_ns", cpu_clock_read_cost_ns());
    lm_lines_end(&g_out);
    lm_lines_flush(&g_out);

    connection conn = { 0 };
    unsigned sample = 0;
    unsigned unreachable = 0;
    const char *ended_early = NULL;
    g_run_start = monotonic_ns();
    g_budget_ns = P.budget_seconds * 1000000000ULL;
    bool first = true;

    while (sample < total) {
        if (!first) {
            uint64_t target = monotonic_ns() + next_gap_ns();
            if (target - g_run_start >= g_budget_ns) {
                ended_early = "budget";
                break;
            }
            sleep_until(target);
        }
        first = false;

        /* Everything that can be done before the sample is done now. */
        request rq;
        build_request(&rq, sample);
        exchange x;
        memset(&x, 0, sizeof(x));
        lm_http_init(&x.resp, g_body, g_body_cap, MAX_HEAD);
        bool warmup = sample == 0;
        bool reached = false, stop = false;
        if (P.connection == CONN_NEW) {
            sample_result result = new_connection_sample(&conn, &rq, &x, sample, warmup);
            if (result == SAMPLE_NOT_STARTED) {
                stop = true;
            } else {
                reached = result == SAMPLE_REACHED;
                sample++;
            }
        } else {
            if (conn.open) check_idle(&conn);
            if (conn.open || open_reused(&conn)) {
                /* Reopening may have taken a while: the budget is asked again. */
                if (budget_spent()) {
                    stop = true;
                } else {
                    reused_sample(&conn, &rq, &x, sample, warmup);
                    reached = true;
                    sample++;
                }
            }
        }
        lm_lines_flush(&g_out);
        lm_http_free(&x.resp);
        if (stop) {
            ended_early = "budget";
            break;
        }
        if (reached) {
            unreachable = 0;
        } else if (++unreachable >= UNREACHABLE_LIMIT) {
            ended_early = "unreachable";
            break;
        }
    }
    if (conn.open) {
        close_connection(&conn, "end_of_run", true);
        lm_lines_flush(&g_out);
    }

    unsigned not_made = sample < total ? total - sample : 0;
    lm_lines_begin(&g_out, "observed", lm_now_ns());
    lm_lines_object(&g_out, "values");
    lm_lines_u64(&g_out, "requests_made", R.requests_made);
    lm_lines_u64(&g_out, "requests_not_made", not_made);
    if (ended_early != NULL) lm_lines_str(&g_out, "ended_early", ended_early);
    else lm_lines_null(&g_out, "ended_early");
    lm_lines_u64(&g_out, "connections_opened", R.connections_opened);
    lm_lines_u64(&g_out, "connection_setups_failed", R.setups_failed);
    lm_lines_u64(&g_out, "responses", R.responses);
    lm_lines_u64(&g_out, "responses_2xx_verified", R.responses_2xx_verified);
    lm_lines_u64(&g_out, "requests_failed", R.requests_failed);
    if (R.have_verified_body_bytes) lm_lines_u64(&g_out, "body_bytes", R.verified_body_bytes);
    else lm_lines_null(&g_out, "body_bytes");
    lm_lines_bool(&g_out, "body_mismatch", R.body_mismatch);
    lm_lines_object(&g_out, "statuses");
    for (unsigned s = 0; s < 1000; s++) {
        if (R.statuses[s] == 0) continue;
        char code[8];
        snprintf(code, sizeof(code), "%u", s);
        lm_lines_u64(&g_out, code, R.statuses[s]);
    }
    lm_lines_close(&g_out);
    lm_lines_object(&g_out, "failures");
    for (int f = 0; f < F_COUNT; f++) {
        if (R.failures[f] > 0) lm_lines_u64(&g_out, FAILURE_NAMES[f], R.failures[f]);
    }
    lm_lines_close(&g_out);
    lm_lines_u64(&g_out, "fields_withheld", lm_lines_withheld_fields());
    lm_lines_u64(&g_out, "lines_withheld", lm_lines_withheld_lines());
    lm_lines_end(&g_out);

    unsigned char guard[32];
    SHA256_Final(guard, &R.digests);
    uint64_t checksum = 0;
    for (int i = 0; i < 8; i++) checksum = (checksum << 8) | guard[i];
    lm_lines_begin(&g_out, "verified", lm_now_ns());
    char text[24];
    snprintf(text, sizeof(text), "0x%016" PRIx64, checksum);
    lm_lines_str(&g_out, "checksum", text);
    lm_lines_end(&g_out);
    lm_lines_flush(&g_out);
    lm_finish();

    if (R.body_mismatch) return 1;
    if (R.any_error || not_made > 0) return 4;
    return 0;
}
