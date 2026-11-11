#include "lm_http.h"

#include "lm.h"

#include <stdlib.h>
#include <string.h>

enum { CHUNK_SIZE, CHUNK_DATA, CHUNK_DATA_END, CHUNK_TRAILER };

void lm_http_init(lm_http_response *r, unsigned char *body, size_t body_cap, size_t max_head) {
    memset(r, 0, sizeof(*r));
    r->head = malloc(max_head);
    if (r->head == NULL) lm_die("lm_http: out of memory for a header block of %zu bytes", max_head);
    r->max_head = max_head;
    r->body = body;
    r->body_cap = body_cap;
    r->state = LM_HTTP_HEAD;
}

void lm_http_free(lm_http_response *r) {
    free(r->head);
    free(r->trailer);
    r->head = NULL;
    r->trailer = NULL;
}

static void fail(lm_http_response *r, const char *why) {
    r->state = LM_HTTP_ERROR;
    r->error = why;
}

static bool is_tchar(unsigned char c) {
    if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
    return c != 0 && strchr("!#$%&'*+-.^_`|~", c) != NULL;
}

static unsigned char lower(unsigned char c) { return (c >= 'A' && c <= 'Z') ? (unsigned char)(c + 32) : c; }

static bool same_ci(const unsigned char *a, size_t alen, const char *b) {
    size_t blen = strlen(b);
    if (alen != blen) return false;
    for (size_t i = 0; i < alen; i++) {
        if (lower(a[i]) != lower((unsigned char)b[i])) return false;
    }
    return true;
}

const unsigned char *lm_http_get(const lm_http_response *r, const char *name, size_t *len) {
    for (unsigned i = 0; i < r->headers; i++) {
        const lm_http_header *h = &r->header[i];
        if (same_ci(r->head + h->name, h->name_len, name)) {
            *len = h->value_len;
            return r->head + h->value;
        }
    }
    return NULL;
}

/* Whether the comma-separated list holds `token`, ignoring case and whitespace. */
static bool list_has(const unsigned char *v, size_t len, const char *token) {
    size_t i = 0;
    while (i < len) {
        while (i < len && (v[i] == ' ' || v[i] == '\t' || v[i] == ',')) i++;
        size_t start = i;
        while (i < len && v[i] != ',') i++;
        size_t end = i;
        while (end > start && (v[end - 1] == ' ' || v[end - 1] == '\t')) end--;
        if (end > start && same_ci(v + start, end - start, token)) return true;
    }
    return false;
}

/* Parses Content-Length values (each possibly a comma-separated list); all
 * must be the same whole number. */
static bool content_length(const lm_http_response *r, bool *present, uint64_t *value, const char **why) {
    *present = false;
    for (unsigned i = 0; i < r->headers; i++) {
        const lm_http_header *h = &r->header[i];
        if (!same_ci(r->head + h->name, h->name_len, "content-length")) continue;
        const unsigned char *v = r->head + h->value;
        size_t len = h->value_len, at = 0;
        do {
            while (at < len && (v[at] == ' ' || v[at] == '\t')) at++;
            size_t digits = 0;
            uint64_t n = 0;
            while (at < len && v[at] >= '0' && v[at] <= '9') {
                if (n > (UINT64_C(1) << 60)) {
                    *why = "a Content-Length too large";
                    return false;
                }
                n = n * 10 + (uint64_t)(v[at] - '0');
                at++;
                digits++;
            }
            while (at < len && (v[at] == ' ' || v[at] == '\t')) at++;
            if (digits == 0 || (at < len && v[at] != ',')) {
                *why = "a Content-Length that is not a whole number";
                return false;
            }
            if (*present && n != *value) {
                *why = "Content-Length values that disagree";
                return false;
            }
            *present = true;
            *value = n;
            if (at < len) at++; /* the comma */
        } while (at < len);
    }
    return true;
}

/* One field line h[at, end), without its CRLF: name, colon, value. The value
 * is kept without the optional whitespace around it. Returns why the line is
 * refused, or NULL. The same rules serve the header lines and the trailers. */
static const char *field_line(const unsigned char *h, size_t at, size_t end, lm_http_header *out) {
    if (at < end && (h[at] == ' ' || h[at] == '\t')) return "obsolete line folding (a header line starting with whitespace)";
    size_t colon = at;
    while (colon < end && h[colon] != ':') colon++;
    if (colon == end) return "a header line without a colon";
    if (colon == at) return "a header line with an empty name";
    for (size_t i = at; i < colon; i++) {
        if (!is_tchar(h[i])) return (h[i] == ' ' || h[i] == '\t') ? "whitespace in or after a header's name" : "a character not allowed in a header's name";
    }
    size_t v = colon + 1, ve = end;
    while (v < ve && (h[v] == ' ' || h[v] == '\t')) v++;
    while (ve > v && (h[ve - 1] == ' ' || h[ve - 1] == '\t')) ve--;
    for (size_t i = v; i < ve; i++) {
        if ((h[i] < 0x20 && h[i] != '\t') || h[i] == 0x7f) return "a control character in a header's value";
    }
    *out = (lm_http_header){ at, colon - at, v, ve - v };
    return NULL;
}

static void parse_head(lm_http_response *r) {
    const unsigned char *h = r->head;
    size_t len = r->head_len; /* ends with CRLF CRLF */
    /* The status line: HTTP/1.<d> SP <3 digits> [SP reason] */
    size_t eol = 0;
    while (eol + 1 < len && !(h[eol] == '\r' && h[eol + 1] == '\n')) eol++;
    r->status_line_len = eol;
    if (eol < 12 || memcmp(h, "HTTP/1.", 7) != 0 || h[7] < '0' || h[7] > '9' || h[8] != ' ' ||
        h[9] < '0' || h[9] > '9' || h[10] < '0' || h[10] > '9' || h[11] < '0' || h[11] > '9' || (eol > 12 && h[12] != ' ')) {
        fail(r, "a status line that is not HTTP/1.x with a three-digit status");
        return;
    }
    r->version_minor = (unsigned)(h[7] - '0');
    r->status = (unsigned)((h[9] - '0') * 100 + (h[10] - '0') * 10 + (h[11] - '0'));
    for (size_t i = 13; i < eol; i++) {
        if ((h[i] < 0x20 && h[i] != '\t') || h[i] == 0x7f) {
            fail(r, "a control character in the status line");
            return;
        }
    }

    size_t at = eol + 2;
    while (at + 1 < len && !(h[at] == '\r' && h[at + 1] == '\n')) {
        size_t end = at;
        while (end + 1 < len && !(h[end] == '\r' && h[end + 1] == '\n')) end++;
        lm_http_header field;
        const char *why = field_line(h, at, end, &field);
        if (why != NULL) {
            fail(r, why);
            return;
        }
        if (r->headers == LM_HTTP_MAX_HEADERS) {
            fail(r, "more header lines than the parser keeps");
            return;
        }
        r->header[r->headers++] = field;
        at = end + 2;
    }

    if (r->status >= 100 && r->status < 200) {
        fail(r, "an interim (1xx) response");
        return;
    }
    size_t connection_len = 0;
    const unsigned char *connection = lm_http_get(r, "connection", &connection_len);
    if (r->version_minor >= 1) r->keep_alive = connection == NULL || !list_has(connection, connection_len, "close");
    else r->keep_alive = connection != NULL && list_has(connection, connection_len, "keep-alive");

    if (r->status == 204 || r->status == 304) {
        r->framing = LM_HTTP_NONE;
        r->state = LM_HTTP_DONE;
        return;
    }
    bool has_te = false;
    for (unsigned i = 0; i < r->headers; i++) {
        const lm_http_header *x = &r->header[i];
        if (!same_ci(r->head + x->name, x->name_len, "transfer-encoding")) continue;
        if (has_te || !same_ci(r->head + x->value, x->value_len, "chunked")) {
            fail(r, "a transfer coding other than chunked");
            return;
        }
        has_te = true;
    }
    if (has_te) {
        /* Transfer-Encoding overrides Content-Length (RFC 9112 6.3). */
        r->framing = LM_HTTP_CHUNKED;
        r->chunk_state = CHUNK_SIZE;
        r->state = LM_HTTP_BODY;
        return;
    }
    bool present = false;
    uint64_t length = 0;
    const char *why = NULL;
    if (!content_length(r, &present, &length, &why)) {
        fail(r, why);
        return;
    }
    if (present) {
        r->framing = LM_HTTP_LENGTH;
        r->content_length = length;
        r->state = length == 0 ? LM_HTTP_DONE : LM_HTTP_BODY;
        return;
    }
    r->framing = LM_HTTP_CLOSE;
    r->keep_alive = false;
    r->state = LM_HTTP_BODY;
}

/* Appends to the header block until its blank line; returns the bytes consumed. */
static size_t feed_head(lm_http_response *r, const unsigned char *data, size_t len) {
    size_t used = 0;
    while (used < len) {
        if (r->head_len == r->max_head) {
            fail(r, "a header block larger than the limit");
            return used;
        }
        unsigned char c = data[used++];
        size_t i = r->head_len;
        r->head[r->head_len++] = c;
        if (c == '\n' && (i == 0 || r->head[i - 1] != '\r')) {
            fail(r, "a bare LF in the header block");
            return used;
        }
        if (i > 0 && r->head[i - 1] == '\r' && c != '\n') {
            fail(r, "a bare CR in the header block");
            return used;
        }
        if (c == '\n' && i >= 3 && r->head[i - 1] == '\r' && r->head[i - 2] == '\n' && r->head[i - 3] == '\r') {
            parse_head(r);
            return used;
        }
    }
    return used;
}

/* Keeps body bytes; returns how many. When they do not all fit, the buffer
 * is filled first and then it is an error, so the body kept is the same
 * however the bytes were split into reads. */
static size_t keep_body(lm_http_response *r, const unsigned char *data, size_t n) {
    size_t room = r->body_cap - r->body_len;
    size_t kept = n < room ? n : room;
    memcpy(r->body + r->body_len, data, kept);
    r->body_len += kept;
    if (kept < n) fail(r, "a body larger than the buffer for it");
    return kept;
}

/* One byte of a chunk-size line, a chunk's CRLF, or a trailer line. Returns
 * true when the line is complete (in r->line, without its CRLF). */
static bool line_byte(lm_http_response *r, unsigned char c) {
    if (r->line_len > 0 && r->line[r->line_len - 1] == '\r') {
        if (c != '\n') {
            fail(r, "a bare CR in the chunked framing");
            return false;
        }
        r->line_len--;
        return true;
    }
    if (c == '\n') {
        fail(r, "a bare LF in the chunked framing");
        return false;
    }
    if (r->line_len == sizeof(r->line)) {
        fail(r, "a line of the chunked framing longer than 1024 bytes");
        return false;
    }
    r->line[r->line_len++] = c;
    return false;
}

/* A trailer line, without its CRLF: checked as a header line is, then kept. */
static bool keep_trailer(lm_http_response *r, const unsigned char *line, size_t n) {
    if (line[0] == ' ' || line[0] == '\t') {
        fail(r, "obsolete line folding in the trailers");
        return false;
    }
    if (r->trailer == NULL) {
        r->trailer = malloc(r->max_head);
        if (r->trailer == NULL) lm_die("lm_http: out of memory for trailers of %zu bytes", r->max_head);
    }
    if (r->trailers == LM_HTTP_MAX_TRAILERS) {
        fail(r, "more trailer lines than the parser keeps");
        return false;
    }
    /* trailer_bytes, already within max_head, counts every byte of these lines. */
    memcpy(r->trailer + r->trailer_len, line, n);
    lm_http_header field;
    const char *why = field_line(r->trailer, r->trailer_len, r->trailer_len + n, &field);
    if (why != NULL) {
        fail(r, why);
        return false;
    }
    r->trailer_field[r->trailers++] = field;
    r->trailer_len += n;
    return true;
}

static size_t feed_chunked(lm_http_response *r, const unsigned char *data, size_t len) {
    size_t used = 0;
    while (used < len && r->state == LM_HTTP_BODY) {
        if (r->chunk_state == CHUNK_DATA) {
            size_t n = len - used;
            if (n > r->chunk_left) n = (size_t)r->chunk_left;
            size_t kept = keep_body(r, data + used, n);
            used += kept;
            r->chunk_left -= kept;
            if (kept < n) return used;
            if (r->chunk_left == 0) {
                r->chunk_state = CHUNK_DATA_END;
                r->line_len = 0;
            }
            continue;
        }
        unsigned char c = data[used++];
        if (r->chunk_state == CHUNK_TRAILER) {
            r->trailer_bytes++;
            if (r->head_len + r->trailer_bytes > r->max_head) {
                fail(r, "trailers larger than the limit");
                return used;
            }
        }
        if (!line_byte(r, c)) {
            if (r->state == LM_HTTP_ERROR) return used;
            continue;
        }
        const unsigned char *line = r->line;
        size_t n = r->line_len;
        r->line_len = 0;
        if (r->chunk_state == CHUNK_SIZE) {
            size_t i = 0;
            uint64_t size = 0;
            while (i < n) {
                unsigned char x = line[i];
                int digit = (x >= '0' && x <= '9') ? x - '0' : (lower(x) >= 'a' && lower(x) <= 'f') ? lower(x) - 'a' + 10 : -1;
                if (digit < 0) break;
                if (size > (UINT64_C(1) << 56)) {
                    fail(r, "a chunk size too large");
                    return used;
                }
                size = size * 16 + (uint64_t)digit;
                i++;
            }
            if (i == 0) {
                fail(r, "a chunk-size line that does not start with a hexadecimal size");
                return used;
            }
            while (i < n && (line[i] == ' ' || line[i] == '\t')) i++;
            if (i < n && line[i] != ';') {
                fail(r, "a chunk-size line with something other than an extension after the size");
                return used;
            }
            if (size == 0) {
                r->chunk_state = CHUNK_TRAILER;
            } else {
                r->chunk_left = size;
                r->chunk_state = CHUNK_DATA;
            }
        } else if (r->chunk_state == CHUNK_DATA_END) {
            if (n != 0) {
                fail(r, "a chunk not followed by CRLF");
                return used;
            }
            r->chunk_state = CHUNK_SIZE;
        } else { /* CHUNK_TRAILER */
            if (n == 0) {
                r->state = LM_HTTP_DONE;
            } else if (!keep_trailer(r, line, n)) {
                return used;
            }
        }
    }
    return used;
}

size_t lm_http_feed(lm_http_response *r, const unsigned char *data, size_t len) {
    if (r->state == LM_HTTP_HEAD) return feed_head(r, data, len);
    if (r->state != LM_HTTP_BODY || len == 0) return 0;
    size_t used = 0;
    if (r->framing == LM_HTTP_CHUNKED) {
        used = feed_chunked(r, data, len);
    } else if (r->framing == LM_HTTP_LENGTH) {
        size_t n = len;
        uint64_t left = r->content_length - r->body_len;
        if (n > left) n = (size_t)left;
        used = keep_body(r, data, n);
        if (r->state != LM_HTTP_ERROR && r->body_len == r->content_length) r->state = LM_HTTP_DONE;
    } else { /* LM_HTTP_CLOSE */
        used = keep_body(r, data, len);
    }
    r->wire_bytes += used;
    return used;
}

bool lm_http_direct(lm_http_response *r, unsigned char **where, size_t *room) {
    if (r->state != LM_HTTP_BODY || (r->framing != LM_HTTP_LENGTH && r->framing != LM_HTTP_CLOSE)) return false;
    size_t free_bytes = r->body_cap - r->body_len;
    size_t n = free_bytes;
    if (r->framing == LM_HTTP_LENGTH) {
        uint64_t left = r->content_length - r->body_len;
        if (left < n) n = (size_t)left;
    }
    if (n == 0) {
        /* A length-framed body that has not ended needs more room than there
         * is. A body framed by the connection's end may end right here: only
         * a further body byte, fed with lm_http_feed(), says it does not. */
        if (r->framing == LM_HTTP_LENGTH) fail(r, "a body larger than the buffer for it");
        return false;
    }
    *where = r->body + r->body_len;
    *room = n;
    return true;
}

void lm_http_direct_done(lm_http_response *r, size_t n) {
    r->body_len += n;
    r->wire_bytes += n;
    if (r->framing == LM_HTTP_LENGTH && r->body_len == r->content_length) r->state = LM_HTTP_DONE;
}

void lm_http_eof(lm_http_response *r) {
    if (r->state == LM_HTTP_BODY && r->framing == LM_HTTP_CLOSE) {
        r->state = LM_HTTP_DONE;
        return;
    }
    if (r->state == LM_HTTP_HEAD) fail(r, r->head_len == 0 ? "the connection ended before any byte of a response" : "the connection ended inside the header block");
    else if (r->state == LM_HTTP_BODY) fail(r, "the connection ended before the body was complete");
}
