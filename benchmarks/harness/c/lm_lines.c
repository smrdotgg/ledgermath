#include "lm_lines.h"

#include "lm.h"

#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* ---- secrets and their forms ---- */

typedef struct {
    unsigned char *bytes; /* lower-cased: every search ignores ASCII case */
    size_t len;
} form;

static struct {
    form *forms;
    size_t count;
} g_slots[LM_SECRET_SLOTS];

/* Every form of every slot, indexed by its first (lower-cased) byte, so a
 * search looks at a position only when some form can start there. */
typedef struct {
    const form *f;
} entry;
static entry *g_index[256];
static size_t g_index_count[256];

static bool (*g_filter)(const void *data, size_t len);
static uint64_t g_withheld_fields, g_withheld_lines;

static unsigned char lower(unsigned char c) { return (c >= 'A' && c <= 'Z') ? (unsigned char)(c + 32) : c; }

static void rebuild_index(void) {
    for (int c = 0; c < 256; c++) {
        free(g_index[c]);
        g_index[c] = NULL;
        g_index_count[c] = 0;
    }
    size_t counts[256] = { 0 };
    for (int s = 0; s < LM_SECRET_SLOTS; s++) {
        for (size_t i = 0; i < g_slots[s].count; i++) counts[g_slots[s].forms[i].bytes[0]]++;
    }
    for (int c = 0; c < 256; c++) {
        if (counts[c] == 0) continue;
        g_index[c] = malloc(counts[c] * sizeof(entry));
        if (g_index[c] == NULL) lm_die("lm_secret_add: out of memory");
    }
    for (int s = 0; s < LM_SECRET_SLOTS; s++) {
        for (size_t i = 0; i < g_slots[s].count; i++) {
            const form *f = &g_slots[s].forms[i];
            g_index[f->bytes[0]][g_index_count[f->bytes[0]]++] = (entry){ f };
        }
    }
}

static bool found_in(const unsigned char *p, size_t len) {
    for (size_t i = 0; i < len; i++) {
        unsigned char c = lower(p[i]);
        for (size_t k = 0; k < g_index_count[c]; k++) {
            const form *f = g_index[c][k].f;
            if (f->len > len - i) continue;
            size_t j = 1;
            while (j < f->len && lower(p[i + j]) == f->bytes[j]) j++;
            if (j == f->len) return true;
        }
    }
    return false;
}

/* Searched twice: as given, and with every byte up to 0x20 (spaces, line
 * breaks, NULs) taken out, which finds a form split by one of them, and the
 * ASCII of a UTF-16 text. */
bool lm_secret_found(const void *data, size_t len) {
    const unsigned char *p = data;
    if (found_in(p, len)) return true;
    size_t kept = 0;
    for (size_t i = 0; i < len; i++) kept += p[i] > 0x20;
    if (kept == len) return false;
    unsigned char *squeezed = malloc(kept + 1);
    if (squeezed == NULL) lm_die("lm_secret_found: out of memory");
    for (size_t i = 0, o = 0; i < len; i++) {
        if (p[i] > 0x20) squeezed[o++] = p[i];
    }
    bool found = found_in(squeezed, kept);
    free(squeezed);
    return found;
}

/* A growing byte string, for building forms. */
typedef struct {
    unsigned char *p;
    size_t len, cap;
} text;

static void text_put(text *t, const void *data, size_t n) {
    if (t->len + n > t->cap) {
        size_t cap = t->cap ? t->cap : 64;
        while (t->len + n > cap) cap *= 2;
        unsigned char *grown = realloc(t->p, cap);
        if (grown == NULL) lm_die("lm_secret_add: out of memory");
        t->p = grown;
        t->cap = cap;
    }
    memcpy(t->p + t->len, data, n);
    t->len += n;
}

/* The lines the stream's order depends on, as templates: '#' stands for a
 * decimal number (1 to 20 digits) and '$' for sixteen hexadecimal digits. A
 * secret none of whose forms can occur inside one of these is never found in
 * such a line, so the guard never has to withhold one. `finished` is among
 * them because lm.c writes it, past the guard. */
static const char *const STRUCTURAL[] = {
    "{\"event\":\"finished\",\"t\":#}\n",
    "{\"event\":\"sample_started\",\"t\":#,\"sample\":#,\"warmup\":true,\"repetitions\":#}\n",
    "{\"event\":\"sample_started\",\"t\":#,\"sample\":#,\"warmup\":false,\"repetitions\":#}\n",
    "{\"event\":\"sample_ended\",\"t\":#,\"sample\":#}\n",
    "{\"event\":\"verified\",\"t\":#,\"checksum\":\"0x$\"}\n",
    "{\"event\":\"line_withheld\",\"t\":#,\"withheld_bytes\":#}\n",
};

/* Whether `f` (lower-cased) can occur as a substring of some line the
 * template describes: a set-of-states walk, each state a position in the
 * template and, inside a number, the digits it has taken so far. */
static bool can_occur(const unsigned char *f, size_t n, const char *tmpl) {
    enum { K = 21 };
    size_t L = strlen(tmpl);
    size_t states = (L + 1) * K;
    bool *cur = calloc(states, 1), *next = calloc(states, 1);
    if (cur == NULL || next == NULL) lm_die("lm_secret_add: out of memory");
#define AT(p, k) ((p) * K + (k))
    /* A substring may start anywhere, inside a number too. */
    for (size_t p = 0; p < L; p++) {
        unsigned max = tmpl[p] == '#' ? 20 : tmpl[p] == '$' ? 16 : 0;
        for (unsigned k = 0; k <= max; k++) cur[AT(p, k)] = true;
    }
    bool alive = true;
    for (size_t i = 0; i < n && alive; i++) {
        /* A number may end once it has a digit (sixteen, for the hex one). */
        for (size_t p = 0; p < L; p++) {
            if (tmpl[p] == '#') {
                for (unsigned k = 1; k <= 20; k++) if (cur[AT(p, k)]) cur[AT(p + 1, 0)] = true;
            } else if (tmpl[p] == '$' && cur[AT(p, 16)]) {
                cur[AT(p + 1, 0)] = true;
            }
        }
        memset(next, 0, states);
        unsigned char c = f[i];
        bool digit = c >= '0' && c <= '9', hex = digit || (c >= 'a' && c <= 'f');
        alive = false;
        for (size_t p = 0; p < L; p++) {
            if (tmpl[p] == '#') {
                for (unsigned k = 0; k < 20; k++) if (cur[AT(p, k)] && digit) next[AT(p, k + 1)] = alive = true;
            } else if (tmpl[p] == '$') {
                for (unsigned k = 0; k < 16; k++) if (cur[AT(p, k)] && hex) next[AT(p, k + 1)] = alive = true;
            } else if (cur[AT(p, 0)] && lower((unsigned char)tmpl[p]) == c) {
                next[AT(p + 1, 0)] = alive = true;
            }
        }
        bool *swap = cur;
        cur = next;
        next = swap;
    }
#undef AT
    free(cur);
    free(next);
    return alive;
}

static const char HEX_UPPER[] = "0123456789ABCDEF";
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* The base64 characters that depend on the secret's bytes alone when it sits
 * `k` bytes past a multiple of three in a longer encoded text. */
static void base64_middle(text *out, const unsigned char *s, size_t n, unsigned k, bool url) {
    size_t total = k + n;
    unsigned char *buf = calloc(total, 1);
    char *enc = malloc(4 * ((total + 2) / 3) + 1);
    if (buf == NULL || enc == NULL) lm_die("lm_secret_add: out of memory");
    memcpy(buf + k, s, n);
    lm_base64(buf, total, enc);
    size_t first = (8 * k + 5) / 6, end = (8 * total) / 6;
    for (size_t i = first; i < end; i++) {
        char c = enc[i];
        if (url && c == '+') c = '-';
        if (url && c == '/') c = '_';
        text_put(out, &c, 1);
    }
    free(buf);
    free(enc);
}

static void add_form(form **forms, size_t *count, text *t) {
    if (t->len == 0) {
        free(t->p);
        *t = (text){ 0 };
        return;
    }
    for (size_t i = 0; i < t->len; i++) t->p[i] = lower(t->p[i]);
    for (size_t i = 0; i < *count; i++) {
        if ((*forms)[i].len == t->len && memcmp((*forms)[i].bytes, t->p, t->len) == 0) {
            free(t->p);
            *t = (text){ 0 };
            return;
        }
    }
    form *grown = realloc(*forms, (*count + 1) * sizeof(form));
    if (grown == NULL) lm_die("lm_secret_add: out of memory");
    *forms = grown;
    (*forms)[(*count)++] = (form){ t->p, t->len };
    *t = (text){ 0 };
}

static void clear_slot(int slot) {
    for (size_t i = 0; i < g_slots[slot].count; i++) {
        memset(g_slots[slot].forms[i].bytes, 0, g_slots[slot].forms[i].len);
        free(g_slots[slot].forms[i].bytes);
    }
    free(g_slots[slot].forms);
    g_slots[slot].forms = NULL;
    g_slots[slot].count = 0;
}

static void free_forms(form *forms, size_t count) {
    for (size_t i = 0; i < count; i++) {
        memset(forms[i].bytes, 0, forms[i].len);
        free(forms[i].bytes);
    }
    free(forms);
}

bool lm_secret_add(int slot, const void *secret, size_t len) {
    if (slot < 0 || slot >= LM_SECRET_SLOTS) lm_die("lm_secret_add: no slot %d", slot);
    const unsigned char *s = secret;
    form *forms = NULL;
    size_t count = 0;
    if (len > 0) {
        text t = { 0 };
        text_put(&t, s, len);
        add_form(&forms, &count, &t);
        /* percent-encoded, the reserved bytes only, then every byte */
        for (int all = 0; all < 2; all++) {
            for (size_t i = 0; i < len; i++) {
                unsigned char c = s[i];
                bool unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~';
                if (unreserved && !all) {
                    text_put(&t, &c, 1);
                } else {
                    char e[3] = { '%', HEX_UPPER[c >> 4], HEX_UPPER[c & 15] };
                    text_put(&t, e, 3);
                }
            }
            add_form(&forms, &count, &t);
        }
        /* base64 and base64url, at the three alignments */
        for (int url = 0; url < 2; url++) {
            for (unsigned k = 0; k < 3; k++) {
                base64_middle(&t, s, len, k, url);
                add_form(&forms, &count, &t);
            }
        }
        /* hexadecimal, bare and with each separator */
        static const char SEPARATORS[] = { 0, ' ', ':', '-' };
        for (size_t sep = 0; sep < sizeof(SEPARATORS); sep++) {
            for (size_t i = 0; i < len; i++) {
                if (i > 0 && SEPARATORS[sep] != 0) text_put(&t, &SEPARATORS[sep], 1);
                char e[2] = { HEX_UPPER[s[i] >> 4], HEX_UPPER[s[i] & 15] };
                text_put(&t, e, 2);
            }
            add_form(&forms, &count, &t);
        }
        for (size_t i = 0; i < count; i++) {
            for (size_t k = 0; k < sizeof(STRUCTURAL) / sizeof(STRUCTURAL[0]); k++) {
                if (can_occur(forms[i].bytes, forms[i].len, STRUCTURAL[k])) {
                    free_forms(forms, count);
                    return false;
                }
            }
        }
    }
    clear_slot(slot);
    g_slots[slot].forms = forms;
    g_slots[slot].count = count;
    rebuild_index();
    return true;
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

void lm_lines_set_filter(bool (*may_print)(const void *data, size_t len)) { g_filter = may_print; }
uint64_t lm_lines_withheld_fields(void) { return g_withheld_fields; }
uint64_t lm_lines_withheld_lines(void) { return g_withheld_lines; }

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
 * surrogates, nothing above U+10FFFF) holding no NUL byte. */
static bool printable_utf8(const unsigned char *p, size_t len) {
    size_t i = 0;
    while (i < len) {
        unsigned char c = p[i];
        if (c == 0) return false;
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
    const unsigned char *p = data;
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)p[i] << 16;
        if (i + 1 < len) v |= (uint32_t)p[i + 1] << 8;
        if (i + 2 < len) v |= p[i + 2];
        out[o++] = B64[(v >> 18) & 63];
        out[o++] = B64[(v >> 12) & 63];
        out[o++] = i + 1 < len ? B64[(v >> 6) & 63] : '=';
        out[o++] = i + 2 < len ? B64[v & 63] : '=';
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

/* The one decision for received bytes: refused when the bytes, or the text
 * written for them, hold a registered secret or fail the caller's filter. */
static bool refused(const void *data, size_t len) {
    return lm_secret_found(data, len) || (g_filter != NULL && !g_filter(data, len));
}

/* After the text for a received field has been put at `start`: keeps it, or
 * replaces it with the withheld marker. */
static void decide(lm_lines *b, size_t start, const void *data, size_t len) {
    if (!refused(data, len) && !refused(b->text + start, b->len - start)) return;
    b->len = start;
    b->text[start] = '\0';
    char marker[48];
    snprintf(marker, sizeof(marker), "{\"withheld_bytes\":%zu}", len);
    put_str(b, marker);
    g_withheld_fields++;
}

void lm_lines_bytes(lm_lines *b, const char *key, const void *data, size_t len) {
    member(b, key);
    size_t start = b->len;
    if (printable_utf8(data, len)) {
        put_json_string(b, data, len);
    } else {
        put_str(b, "{\"base64\":");
        put_base64_string(b, data, len);
        put(b, "}", 1);
    }
    decide(b, start, data, len);
}

void lm_lines_base64(lm_lines *b, const char *key, const void *data, size_t len) {
    member(b, key);
    size_t start = b->len;
    put_base64_string(b, data, len);
    decide(b, start, data, len);
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

static void write_all(const char *text, size_t len) {
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
}

/* The line that goes in place of one the guard withholds: its event's name
 * and its t, read back from the line's start (which lm_lines_begin wrote),
 * and its length. Falls back to leaving the name out should the name itself
 * hold a secret; that form cannot (lm_secret_add). */
static void withheld_line(const char *line, size_t len, char *out, size_t cap) {
    char name[64] = "";
    uint64_t t = 0;
    bool have_t = false;
    static const char prefix[] = "{\"event\":\"";
    if (len > sizeof(prefix) - 1 && memcmp(line, prefix, sizeof(prefix) - 1) == 0) {
        const char *at = line + sizeof(prefix) - 1, *end = line + len;
        const char *quote = memchr(at, '"', (size_t)(end - at));
        if (quote != NULL && (size_t)(quote - at) < sizeof(name)) {
            bool plain = true;
            for (const char *c = at; c < quote; c++) plain = plain && *c >= 0x21 && *c <= 0x7e && *c != '\\';
            if (plain) {
                memcpy(name, at, (size_t)(quote - at));
                name[quote - at] = '\0';
            }
            static const char tkey[] = "\",\"t\":";
            at = quote;
            if ((size_t)(end - at) > sizeof(tkey) - 1 && memcmp(at, tkey, sizeof(tkey) - 1) == 0) {
                at += sizeof(tkey) - 1;
                while (at < end && *at >= '0' && *at <= '9' && t <= UINT64_MAX / 10) {
                    t = t * 10 + (uint64_t)(*at - '0');
                    have_t = true;
                    at++;
                }
            }
        }
    }
    if (!have_t) t = lm_now_ns();
    if (name[0] != '\0') {
        snprintf(out, cap, "{\"event\":\"line_withheld\",\"t\":%" PRIu64 ",\"withheld_event\":\"%s\",\"withheld_bytes\":%zu}\n", t, name, len);
        if (!lm_secret_found(out, strlen(out))) return;
    }
    snprintf(out, cap, "{\"event\":\"line_withheld\",\"t\":%" PRIu64 ",\"withheld_bytes\":%zu}\n", t, len);
}

void lm_lines_flush(lm_lines *b) {
    if (b->depth != 0) lm_die("lm_lines_flush: a line is still open");
    const char *text = b->text;
    size_t len = b->len, from = 0, at = 0;
    while (at < len) {
        const char *nl = memchr(text + at, '\n', len - at);
        size_t end = nl != NULL ? (size_t)(nl - text) + 1 : len;
        if (lm_secret_found(text + at, end - at)) {
            write_all(text + from, at - from);
            char replacement[256];
            withheld_line(text + at, end - at, replacement, sizeof(replacement));
            if (!lm_secret_found(replacement, strlen(replacement))) write_all(replacement, strlen(replacement));
            g_withheld_lines++;
            from = end;
        }
        at = end;
    }
    write_all(text + from, len - from);
    b->len = 0;
    b->line_start = 0;
    b->text[0] = '\0';
}
