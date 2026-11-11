#include "lm_event.h"

#include "lm.h"

#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *const UNIVERSAL[] = { "started", "observed", "sample_started", "sample_ended", "verified", "finished" };

static void put(lm_event *e, const char *text, size_t len) {
    if (e->text == NULL) lm_die("lm_event used before lm_event_begin or after lm_event_emit");
    if (e->len + len + 1 > e->cap) {
        size_t cap = e->cap;
        while (e->len + len + 1 > cap) cap *= 2;
        char *grown = realloc(e->text, cap);
        if (grown == NULL) lm_die("lm_event: out of memory for an event of %zu bytes", cap);
        e->text = grown;
        e->cap = cap;
    }
    memcpy(e->text + e->len, text, len);
    e->len += len;
    e->text[e->len] = '\0';
}

static void put_str(lm_event *e, const char *text) { put(e, text, strlen(text)); }

/* `text` as a JSON string, quotes included. */
static void put_json_string(lm_event *e, const char *text) {
    put(e, "\"", 1);
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p == '"' || *p == '\\') {
            char escaped[2] = { '\\', (char)*p };
            put(e, escaped, 2);
        } else if (*p < 0x20) {
            char escaped[8];
            int n = snprintf(escaped, sizeof(escaped), "\\u%04x", *p);
            put(e, escaped, (size_t)n);
        } else {
            put(e, (const char *)p, 1);
        }
    }
    put(e, "\"", 1);
}

static void start(lm_event *e, const char *name, uint64_t t) {
    e->cap = 512;
    e->len = 0;
    e->text = malloc(e->cap);
    if (e->text == NULL) lm_die("lm_event: out of memory");
    e->text[0] = '\0';
    e->depth = 1;
    e->floor = 1;
    e->is_array[0] = false;
    e->empty[0] = false; /* `event` and `t` come first */
    put_str(e, "{\"event\":");
    put_json_string(e, name);
    char number[40];
    snprintf(number, sizeof(number), ",\"t\":%" PRIu64, t);
    put_str(e, number);
}

void lm_event_begin(lm_event *e, const char *name, uint64_t t) {
    if (name == NULL || name[0] == '\0') lm_die("lm_event_begin: an event needs a name");
    for (size_t i = 0; i < sizeof(UNIVERSAL) / sizeof(UNIVERSAL[0]); i++) {
        if (strcmp(name, UNIVERSAL[i]) == 0) {
            lm_die("lm_event_begin: \"%s\" is a universal event; a benchmark's own events take other names%s", name,
                   strcmp(name, "observed") == 0 ? " (use lm_observed_begin for a further observed)" : "");
        }
    }
    start(e, name, t);
}

void lm_observed_begin(lm_event *e, uint64_t t) {
    start(e, "observed", t);
    lm_event_object(e, "values");
    e->floor = 2; /* `observed` has `values` and nothing else */
}

/* Writes the separator and key of the next member of the innermost level. */
static void member(lm_event *e, const char *key) {
    if (e->text == NULL) lm_die("lm_event used before lm_event_begin or after lm_event_emit");
    int level = e->depth - 1;
    if (e->is_array[level]) {
        if (key != NULL) lm_die("lm_event: \"%s\": a member of an array has no key", key);
    } else {
        if (key == NULL) lm_die("lm_event: a member of an object needs a key");
        if (level == 0 && (strcmp(key, "event") == 0 || strcmp(key, "t") == 0)) {
            lm_die("lm_event: \"%s\" is set by lm_event_begin", key);
        }
    }
    if (!e->empty[level]) put(e, ",", 1);
    e->empty[level] = false;
    if (key != NULL) {
        put_json_string(e, key);
        put(e, ":", 1);
    }
}

void lm_event_u64(lm_event *e, const char *key, uint64_t value) {
    char number[32];
    member(e, key);
    snprintf(number, sizeof(number), "%" PRIu64, value);
    put_str(e, number);
}

void lm_event_i64(lm_event *e, const char *key, int64_t value) {
    char number[32];
    member(e, key);
    snprintf(number, sizeof(number), "%" PRId64, value);
    put_str(e, number);
}

void lm_event_str(lm_event *e, const char *key, const char *value) {
    member(e, key);
    put_json_string(e, value);
}

void lm_event_bool(lm_event *e, const char *key, bool value) {
    member(e, key);
    put_str(e, value ? "true" : "false");
}

static void open_level(lm_event *e, const char *key, bool is_array) {
    member(e, key);
    if (e->depth >= LM_EVENT_MAX_DEPTH) lm_die("lm_event: more than %d levels of nesting", LM_EVENT_MAX_DEPTH);
    e->is_array[e->depth] = is_array;
    e->empty[e->depth] = true;
    e->depth++;
    put(e, is_array ? "[" : "{", 1);
}

void lm_event_object(lm_event *e, const char *key) { open_level(e, key, false); }
void lm_event_array(lm_event *e, const char *key) { open_level(e, key, true); }

void lm_event_close(lm_event *e) {
    if (e->text == NULL) lm_die("lm_event used before lm_event_begin or after lm_event_emit");
    if (e->depth <= e->floor) lm_die("lm_event_close: nothing is open; lm_event_emit closes the event itself");
    e->depth--;
    put(e, e->is_array[e->depth] ? "]" : "}", 1);
}

void lm_event_emit(lm_event *e) {
    if (e->text == NULL) lm_die("lm_event used before lm_event_begin or after lm_event_emit");
    while (e->depth > 0) {
        e->depth--;
        put(e, e->is_array[e->depth] ? "]" : "}", 1);
    }
    put(e, "\n", 1);
    const char *text = e->text;
    size_t len = e->len;
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
    free(e->text);
    e->text = NULL;
    e->len = e->cap = 0;
}
