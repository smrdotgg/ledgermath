#include "lm_lines.h"

#include "lm.h"

#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* ---- secrets ---- */

static struct {
    unsigned char *bytes;
    size_t len;
} g_secrets[LM_SECRET_SLOTS];

void lm_secret_add(int slot, const void *secret, size_t len) {
    if (slot < 0 || slot >= LM_SECRET_SLOTS) lm_die("lm_secret_add: no slot %d", slot);
    free(g_secrets[slot].bytes);
    g_secrets[slot].bytes = NULL;
    g_secrets[slot].len = 0;
    if (len == 0) return;
    g_secrets[slot].bytes = malloc(len);
    if (g_secrets[slot].bytes == NULL) lm_die("lm_secret_add: out of memory");
    memcpy(g_secrets[slot].bytes, secret, len);
    g_secrets[slot].len = len;
}

static unsigned char lower(unsigned char c) { return (c >= 'A' && c <= 'Z') ? (unsigned char)(c + 32) : c; }

static bool holds(const unsigned char *data, size_t len, const unsigned char *needle, size_t n) {
    if (n == 0 || n > len) return false;
    unsigned char first = lower(needle[0]);
    for (size_t i = 0; i + n <= len; i++) {
        if (lower(data[i]) != first) continue;
        size_t j = 1;
        while (j < n && lower(data[i + j]) == lower(needle[j])) j++;
        if (j == n) return true;
    }
    return false;
}

bool lm_secret_found(const void *data, size_t len) {
    for (int s = 0; s < LM_SECRET_SLOTS; s++) {
        if (g_secrets[s].len > 0 && holds(data, len, g_secrets[s].bytes, g_secrets[s].len)) return true;
    }
    return false;
}

static void refuse_secret(void) {
    /* Names nothing: not the slot, not the event, not a byte of it. */
    fputs("error: a credential or signature was about to be written; nothing was written\n", stderr);
    exit(1);
}

/* ---- the buffer ---- */

void lm_lines_init(lm_lines *b) {
    memset(b, 0, sizeof(*b));
    b->cap = 4096;
    b->text = malloc(b->cap);
    if (b->text == NULL) lm_die("lm_lines: out of memory");
    b->text[0] = '\0';
}

void lm_lines_free(lm_lines *b) {
    free(b->text);
    memset(b, 0, sizeof(*b));
}

static void put(lm_lines *b, const char *text, size_t len) {
    if (b->text == NULL) lm_die("lm_lines used before lm_lines_init");
    if (b->len + len + 1 > b->cap) {
        size_t cap = b->cap;
        while (b->len + len + 1 > cap) cap *= 2;
        char *grown = realloc(b->text, cap);
        if (grown == NULL) lm_die("lm_lines: out of memory for %zu bytes", cap);
        b->text = grown;
        b->cap = cap;
    }
    memcpy(b->text + b->len, text, len);
    b->len += len;
    b->text[b->len] = '\0';
}

static void put_str(lm_lines *b, const char *text) { put(b, text, strlen(text)); }

static void put_json_string(lm_lines *b, const unsigned char *p, size_t len) {
    put(b, "\"", 1);
    size_t run = 0; /* bytes that need no escaping, written together */
    for (size_t i = 0; i < len; i++) {
        unsigned char c = p[i];
        if (c == '"' || c == '\\' || c < 0x20) {
            if (run > 0) put(b, (const char *)p + i - run, run);
            run = 0;
            char escaped[8];
            if (c == '"' || c == '\\') {
                escaped[0] = '\\';
                escaped[1] = (char)c;
                put(b, escaped, 2);
            } else {
                int n = snprintf(escaped, sizeof(escaped), "\\u%04x", c);
                put(b, escaped, (size_t)n);
            }
        } else {
            run++;
        }
    }
    if (run > 0) put(b, (const char *)p + len - run, run);
    put(b, "\"", 1);
}

void lm_lines_begin(lm_lines *b, const char *name, uint64_t t) {
    if (b->depth != 0) lm_die("lm_lines_begin: the previous line is still open");
    b->line_start = b->len;
    b->depth = 1;
    b->is_array[0] = false;
    b->empty[0] = false;
    put_str(b, "{\"event\":");
    put_json_string(b, (const unsigned char *)name, strlen(name));
    char number[40];
    snprintf(number, sizeof(number), ",\"t\":%" PRIu64, t);
    put_str(b, number);
}

static void member(lm_lines *b, const char *key) {
    if (b->depth == 0) lm_die("lm_lines: a member outside any line");
    int level = b->depth - 1;
    if (b->is_array[level]) {
        if (key != NULL) lm_die("lm_lines: \"%s\": a member of an array has no key", key);
    } else if (key == NULL) {
        lm_die("lm_lines: a member of an object needs a key");
    }
    if (!b->empty[level]) put(b, ",", 1);
    b->empty[level] = false;
    if (key != NULL) {
        put_json_string(b, (const unsigned char *)key, strlen(key));
        put(b, ":", 1);
    }
}

void lm_lines_u64(lm_lines *b, const char *key, uint64_t value) {
    char number[32];
    member(b, key);
    snprintf(number, sizeof(number), "%" PRIu64, value);
    put_str(b, number);
}

void lm_lines_i64(lm_lines *b, const char *key, int64_t value) {
    char number[32];
    member(b, key);
    snprintf(number, sizeof(number), "%" PRId64, value);
    put_str(b, number);
}

void lm_lines_bool(lm_lines *b, const char *key, bool value) {
    member(b, key);
    put_str(b, value ? "true" : "false");
}

void lm_lines_null(lm_lines *b, const char *key) {
    member(b, key);
    put_str(b, "null");
}

void lm_lines_str(lm_lines *b, const char *key, const char *value) {
    member(b, key);
    put_json_string(b, (const unsigned char *)value, strlen(value));
}

/* Whether `p` is well-formed UTF-8 (RFC 3629: no overlong forms, no
 * surrogates, nothing above U+10FFFF). */
static bool valid_utf8(const unsigned char *p, size_t len) {
    size_t i = 0;
    while (i < len) {
        unsigned char c = p[i];
        if (c < 0x80) {
            i++;
            continue;
        }
        size_t n;
        uint32_t cp;
        if (c >= 0xc2 && c <= 0xdf) { n = 1; cp = c & 0x1f; }
        else if (c >= 0xe0 && c <= 0xef) { n = 2; cp = c & 0x0f; }
        else if (c >= 0xf0 && c <= 0xf4) { n = 3; cp = c & 0x07; }
        else return false;
        if (len - i <= n) return false; /* fewer than n continuation bytes left */
        for (size_t k = 1; k <= n; k++) {
            if ((p[i + k] & 0xc0) != 0x80) return false;
            cp = (cp << 6) | (p[i + k] & 0x3f);
        }
        if ((n == 2 && cp < 0x800) || (n == 3 && cp < 0x10000) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
        i += n + 1;
    }
    return true;
}

size_t lm_base64(const void *data, size_t len, char *out) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const unsigned char *p = data;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)p[i] << 16;
        if (i + 1 < len) v |= (uint32_t)p[i + 1] << 8;
        if (i + 2 < len) v |= p[i + 2];
        out[o++] = alphabet[(v >> 18) & 63];
        out[o++] = alphabet[(v >> 12) & 63];
        out[o++] = i + 1 < len ? alphabet[(v >> 6) & 63] : '=';
        out[o++] = i + 2 < len ? alphabet[v & 63] : '=';
    }
    out[o] = '\0';
    return o;
}

static void put_base64_string(lm_lines *b, const void *data, size_t len) {
    char *encoded = malloc(4 * ((len + 2) / 3) + 1);
    if (encoded == NULL) lm_die("lm_lines: out of memory");
    size_t n = lm_base64(data, len, encoded);
    put(b, "\"", 1);
    put(b, encoded, n);
    put(b, "\"", 1);
    free(encoded);
}

void lm_lines_bytes(lm_lines *b, const char *key, const void *data, size_t len) {
    if (lm_secret_found(data, len)) refuse_secret();
    member(b, key);
    if (valid_utf8(data, len)) {
        put_json_string(b, data, len);
    } else {
        put_str(b, "{\"base64\":");
        put_base64_string(b, data, len);
        put(b, "}", 1);
    }
}

void lm_lines_base64(lm_lines *b, const char *key, const void *data, size_t len) {
    if (lm_secret_found(data, len)) refuse_secret();
    member(b, key);
    put_base64_string(b, data, len);
}

void lm_lines_hex(lm_lines *b, const char *key, const void *data, size_t len) {
    static const char digits[] = "0123456789abcdef";
    const unsigned char *p = data;
    member(b, key);
    put(b, "\"", 1);
    for (size_t i = 0; i < len; i++) {
        char pair[2] = { digits[p[i] >> 4], digits[p[i] & 15] };
        put(b, pair, 2);
    }
    put(b, "\"", 1);
}

static void open_level(lm_lines *b, const char *key, bool is_array) {
    member(b, key);
    if (b->depth >= LM_LINES_MAX_DEPTH) lm_die("lm_lines: more than %d levels of nesting", LM_LINES_MAX_DEPTH);
    b->is_array[b->depth] = is_array;
    b->empty[b->depth] = true;
    b->depth++;
    put(b, is_array ? "[" : "{", 1);
}

void lm_lines_object(lm_lines *b, const char *key) { open_level(b, key, false); }
void lm_lines_array(lm_lines *b, const char *key) { open_level(b, key, true); }

void lm_lines_close(lm_lines *b) {
    if (b->depth <= 1) lm_die("lm_lines_close: nothing is open; lm_lines_end closes the line itself");
    b->depth--;
    put(b, b->is_array[b->depth] ? "]" : "}", 1);
}

void lm_lines_end(lm_lines *b) {
    if (b->depth == 0) lm_die("lm_lines_end: no line is open");
    while (b->depth > 0) {
        b->depth--;
        put(b, b->is_array[b->depth] ? "]" : "}", 1);
    }
    put(b, "\n", 1);
}

void lm_lines_flush(lm_lines *b) {
    if (b->depth != 0) lm_die("lm_lines_flush: a line is still open");
    if (lm_secret_found(b->text, b->len)) refuse_secret();
    const char *text = b->text;
    size_t len = b->len;
    while (len > 0) {
        ssize_t n = write(STDOUT_FILENO, text, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            fprintf(stderr, "error: write to stdout: %s\n", strerror(errno));
            _exit(3);
        }
        text += n;
        len -= (size_t)n;
    }
    b->len = 0;
    b->line_start = 0;
    b->text[0] = '\0';
}
