/* The tests' way into the DNS, HTTP, SigV4 and event-line code that http_get
 * is built from (tests/http-get.test.ts). Built by `make test-driver`, never
 * by the box, and never part of a Run. Each command prints JSON lines, made
 * with lm_lines, on stdout.
 *
 *   http_get_test sigv4               < spec    sign a request given as "key value" lines
 *   http_get_test encode-path PATH
 *   http_get_test dns-query NAME ID             the query, as hex
 *   http_get_test dns-parse           < hex     a reply, parsed
 *   http_get_test http-parse STEP [--eof] [--direct] [--body-cap N] [--max-head N] < bytes
 *                                               feeds the bytes STEP at a time
 *   http_get_test bytes               < bytes   lm_lines_bytes of the bytes
 *   http_get_test guard SECRET        < bytes   registers SECRET, then writes the bytes as an event
 *                                               of the program's own (lm_lines_str): the guard's case
 *   http_get_test received SECRET     < bytes   registers SECRET, then writes the bytes as received
 *                                               (lm_lines_bytes), between two fields that stay
 *   http_get_test found SECRET        < bytes   registers SECRET; whether the bytes hold it in any form
 *   http_get_test secret SECRET                 whether lm_secret_add accepts SECRET
 */

#include "lm.h"
#include "lm_dns.h"
#include "lm_http.h"
#include "lm_lines.h"
#include "lm_sigv4.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static lm_lines out;

static unsigned char *read_all(size_t *len) {
    size_t cap = 1 << 16, n = 0;
    unsigned char *buf = malloc(cap);
    size_t got;
    while ((got = fread(buf + n, 1, cap - n, stdin)) > 0) {
        n += got;
        if (n == cap) buf = realloc(buf, cap *= 2);
    }
    *len = n;
    return buf;
}

static int sigv4(void) {
    size_t len;
    char *text = (char *)read_all(&len);
    text = realloc(text, len + 1);
    text[len] = '\0';
    lm_sigv4_request req = { .method = "GET", .canonical_uri = "/", .canonical_query = "", .payload_sha256 = "", .amz_date = "",
                             .region = "", .service = "", .access_key_id = "", .secret_access_key = "" };
    lm_sigv4_header headers[64];
    size_t count = 0;
    for (char *line = strtok(text, "\n"); line != NULL; line = strtok(NULL, "\n")) {
        char *space = strchr(line, ' ');
        char *value = space ? space + 1 : line + strlen(line);
        if (space) *space = '\0';
        if (strcmp(line, "method") == 0) req.method = value;
        else if (strcmp(line, "uri") == 0) req.canonical_uri = value;
        else if (strcmp(line, "query") == 0) req.canonical_query = value;
        else if (strcmp(line, "payload") == 0) req.payload_sha256 = value;
        else if (strcmp(line, "date") == 0) req.amz_date = value;
        else if (strcmp(line, "region") == 0) req.region = value;
        else if (strcmp(line, "service") == 0) req.service = value;
        else if (strcmp(line, "key_id") == 0) req.access_key_id = value;
        else if (strcmp(line, "secret") == 0) req.secret_access_key = value;
        else if (strcmp(line, "header") == 0 && count < 64) {
            char *colon = strchr(value, ':');
            if (colon == NULL) lm_die("a header without a colon");
            *colon = '\0';
            headers[count++] = (lm_sigv4_header){ value, colon + 1 };
        }
    }
    req.headers = headers;
    req.header_count = count;
    static lm_sigv4_result r;
    const char *why = lm_sigv4_sign(&req, &r);
    lm_lines_begin(&out, "sigv4", 0);
    if (why != NULL) {
        lm_lines_str(&out, "error", why);
    } else {
        lm_lines_str(&out, "canonical_request", r.canonical_request);
        lm_lines_str(&out, "string_to_sign", r.string_to_sign);
        lm_lines_str(&out, "signed_headers", r.signed_headers);
        lm_lines_str(&out, "credential_scope", r.credential_scope);
        lm_lines_str(&out, "signature", r.signature);
        lm_lines_str(&out, "authorization", r.authorization);
    }
    lm_lines_end(&out);
    lm_lines_flush(&out);
    return 0;
}

static int hex_value(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void record(lm_lines *b, const lm_dns_record *r) {
    lm_lines_object(b, NULL);
    lm_lines_str(b, "text", r->text);
    lm_lines_str(b, "owner", r->owner);
    lm_lines_u64(b, "type", r->type);
    lm_lines_u64(b, "class", r->class_);
    lm_lines_u64(b, "ttl", r->ttl);
    lm_lines_str(b, "data", r->data);
    lm_lines_close(b);
}

static int dns_parse(void) {
    size_t len;
    unsigned char *hex = read_all(&len);
    unsigned char *msg = malloc(len / 2 + 1);
    size_t n = 0;
    for (size_t i = 0; i + 1 < len; i += 2) {
        int hi = hex_value(hex[i]), lo = hex_value(hex[i + 1]);
        if (hi < 0 || lo < 0) break;
        msg[n++] = (unsigned char)(hi * 16 + lo);
    }
    static lm_dns_reply r;
    const char *why = lm_dns_parse(msg, n, &r);
    lm_lines_begin(&out, "dns", 0);
    if (why != NULL) lm_lines_str(&out, "error", why);
    lm_lines_u64(&out, "id", r.id);
    lm_lines_bool(&out, "qr", r.qr);
    lm_lines_bool(&out, "tc", r.tc);
    lm_lines_bool(&out, "rd", r.rd);
    lm_lines_bool(&out, "ra", r.ra);
    lm_lines_u64(&out, "rcode", r.rcode);
    lm_lines_u64(&out, "qdcount", r.qdcount);
    lm_lines_u64(&out, "ancount", r.ancount);
    lm_lines_str(&out, "qname", r.qname);
    lm_lines_u64(&out, "qtype", r.qtype);
    lm_lines_array(&out, "answers");
    for (unsigned i = 0; i < r.answers; i++) record(&out, &r.answer[i]);
    lm_lines_close(&out);
    lm_lines_array(&out, "authority");
    for (unsigned i = 0; i < r.authorities; i++) record(&out, &r.authority[i]);
    lm_lines_close(&out);
    lm_lines_str(&out, "canonical", r.canonical);
    lm_lines_u64(&out, "chain", r.chain);
    lm_lines_bool(&out, "has_address", r.has_address);
    if (r.has_address) {
        const unsigned char *a = (const unsigned char *)&r.address;
        char text[32];
        snprintf(text, sizeof(text), "%u.%u.%u.%u", a[0], a[1], a[2], a[3]);
        lm_lines_str(&out, "address", text);
    }
    lm_lines_end(&out);
    lm_lines_flush(&out);
    return 0;
}

static int http_parse(int argc, char **argv) {
    size_t step = (size_t)strtoul(argv[2], NULL, 10);
    bool eof = false, direct = false;
    size_t body_cap = 1 << 20, max_head = 64 * 1024;
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--eof") == 0) eof = true;
        else if (strcmp(argv[i], "--direct") == 0) direct = true;
        else if (strcmp(argv[i], "--body-cap") == 0 && i + 1 < argc) body_cap = (size_t)strtoul(argv[++i], NULL, 10);
        else if (strcmp(argv[i], "--max-head") == 0 && i + 1 < argc) max_head = (size_t)strtoul(argv[++i], NULL, 10);
    }
    size_t len;
    unsigned char *data = read_all(&len);
    unsigned char *body = malloc(body_cap + 1);
    lm_http_response r;
    lm_http_init(&r, body, body_cap, max_head);
    size_t at = 0, left_over = 0;
    while (at < len && (r.state == LM_HTTP_HEAD || r.state == LM_HTTP_BODY)) {
        size_t n = len - at < step ? len - at : step;
        unsigned char *where;
        size_t room;
        if (direct && lm_http_direct(&r, &where, &room)) {
            if (n > room) n = room;
            memcpy(where, data + at, n);
            lm_http_direct_done(&r, n);
            at += n;
            continue;
        }
        if (r.state == LM_HTTP_ERROR) break;
        size_t used = lm_http_feed(&r, data + at, n);
        at += used;
        if (used < n) break;
    }
    left_over = len - at;
    if (eof && (r.state == LM_HTTP_HEAD || r.state == LM_HTTP_BODY)) lm_http_eof(&r);
    static const char *const STATES[] = { "head", "body", "done", "error" };
    static const char *const FRAMING[] = { "none", "length", "chunked", "close" };
    lm_lines_begin(&out, "http", 0);
    lm_lines_str(&out, "state", STATES[r.state]);
    if (r.error != NULL) lm_lines_str(&out, "error", r.error);
    lm_lines_u64(&out, "head_bytes", r.head_len);
    if (r.state != LM_HTTP_HEAD && r.status_line_len > 0) {
        lm_lines_bytes(&out, "status_line", r.head, r.status_line_len);
        lm_lines_u64(&out, "status", r.status);
        lm_lines_u64(&out, "version_minor", r.version_minor);
        lm_lines_array(&out, "headers");
        for (unsigned i = 0; i < r.headers; i++) {
            lm_lines_array(&out, NULL);
            lm_lines_bytes(&out, NULL, r.head + r.header[i].name, r.header[i].name_len);
            lm_lines_bytes(&out, NULL, r.head + r.header[i].value, r.header[i].value_len);
            lm_lines_close(&out);
        }
        lm_lines_close(&out);
        lm_lines_str(&out, "framing", FRAMING[r.framing]);
        lm_lines_u64(&out, "content_length", r.content_length);
        lm_lines_bool(&out, "keep_alive", r.keep_alive);
    }
    lm_lines_u64(&out, "body_bytes", r.body_len);
    lm_lines_base64(&out, "body_base64", body, r.body_len);
    lm_lines_u64(&out, "wire_bytes", r.wire_bytes);
    lm_lines_u64(&out, "left_over", left_over);
    lm_lines_end(&out);
    lm_lines_flush(&out);
    lm_http_free(&r);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) lm_usage("a command");
    lm_lines_init(&out);
    const char *command = argv[1];
    if (strcmp(command, "sigv4") == 0) return sigv4();
    if (strcmp(command, "encode-path") == 0 && argc == 3) {
        char encoded[8192];
        if (lm_sigv4_encode_path(argv[2], encoded, sizeof(encoded)) == 0 && argv[2][0] != '\0') lm_die("too long");
        lm_lines_begin(&out, "encoded", 0);
        lm_lines_str(&out, "path", encoded);
        lm_lines_end(&out);
        lm_lines_flush(&out);
        return 0;
    }
    if (strcmp(command, "dns-query") == 0 && argc == 4) {
        uint8_t q[512];
        size_t n = lm_dns_query(q, sizeof(q), (uint16_t)strtoul(argv[3], NULL, 10), argv[2]);
        lm_lines_begin(&out, "query", 0);
        lm_lines_u64(&out, "bytes", n);
        lm_lines_hex(&out, "hex", q, n);
        lm_lines_end(&out);
        lm_lines_flush(&out);
        return 0;
    }
    if (strcmp(command, "dns-parse") == 0) return dns_parse();
    if (strcmp(command, "http-parse") == 0 && argc >= 3) return http_parse(argc, argv);
    if (strcmp(command, "bytes") == 0) {
        size_t len;
        unsigned char *data = read_all(&len);
        lm_lines_begin(&out, "bytes", 0);
        lm_lines_bytes(&out, "value", data, len);
        lm_lines_end(&out);
        lm_lines_flush(&out);
        return 0;
    }
    if (strcmp(command, "secret") == 0 && argc == 3) {
        lm_lines_begin(&out, "secret", 1);
        lm_lines_bool(&out, "accepted", lm_secret_add(0, argv[2], strlen(argv[2])));
        lm_lines_end(&out);
        lm_secret_add(0, "", 0);
        lm_lines_flush(&out);
        return 0;
    }
    if ((strcmp(command, "guard") == 0 || strcmp(command, "received") == 0 || strcmp(command, "found") == 0) && argc == 3) {
        if (!lm_secret_add(0, argv[2], strlen(argv[2]))) lm_die("the secret was refused");
        size_t len;
        unsigned char *data = read_all(&len);
        data = realloc(data, len + 1);
        data[len] = '\0';
        if (strcmp(command, "found") == 0) {
            bool found = lm_secret_found(data, len);
            lm_secret_add(0, "", 0);
            lm_lines_begin(&out, "found", 1);
            lm_lines_bool(&out, "found", found);
            lm_lines_end(&out);
            lm_lines_flush(&out);
            return 0;
        }
        lm_lines_begin(&out, "before", 1);
        lm_lines_end(&out);
        lm_lines_begin(&out, strcmp(command, "guard") == 0 ? "guarded" : "received", 2);
        lm_lines_str(&out, "kept", "before");
        if (strcmp(command, "guard") == 0) lm_lines_str(&out, "value", (const char *)data);
        else lm_lines_bytes(&out, "value", data, len);
        lm_lines_str(&out, "also", "after");
        lm_lines_end(&out);
        lm_lines_begin(&out, "after", 3);
        lm_lines_u64(&out, "fields_withheld", lm_lines_withheld_fields());
        lm_lines_u64(&out, "lines_withheld", lm_lines_withheld_lines());
        lm_lines_end(&out);
        lm_lines_flush(&out);
        return 0;
    }
    lm_usage("unknown command or arguments: %s", command);
}
