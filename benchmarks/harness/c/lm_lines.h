#ifndef LEDGERMATH_LM_LINES_H
#define LEDGERMATH_LM_LINES_H

/* Event lines gathered in a buffer and written together, for the C harness,
 * with a guard that keeps registered secrets off stdout.
 *
 * lm_event.h writes each event the moment it is built. A Service benchmark
 * writes a whole request's events after the request ends (the contract writes
 * a sample's events after the sample), so this builds any number of lines in
 * one buffer and writes them with lm_lines_flush():
 *
 *     lm_lines b;
 *     lm_lines_init(&b);
 *     lm_lines_begin(&b, "sample_started", t0);
 *     lm_lines_u64(&b, "sample", 3);
 *     lm_lines_end(&b);
 *     ...
 *     lm_lines_flush(&b);              // one write(2) per call, then more for any part not written
 *
 * Unlike lm_event.h, any event name is accepted, the six universal ones
 * included: the caller writes its own samples, as lm_fixed.c does, and keeps
 * to the contract (docs/dev-log.md section 2) itself.
 *
 * Secrets. lm_secret_add() registers a byte string (a credential, a
 * signature) that must never reach stdout, together with its common encodings
 * (below). Every search ignores ASCII case, and is made twice: on the bytes
 * as given, and on them with every byte up to 0x20 taken out (so a form split
 * by spaces, line breaks or NULs, or written as UTF-16, is found too).
 *
 * Bytes received from elsewhere go through lm_lines_bytes() or
 * lm_lines_base64(), which make one decision per field, on the bytes and on
 * the exact text that would be written for them: the field is written only
 * if neither holds a registered secret (in any registered form) and the
 * caller's filter (lm_lines_set_filter) accepts both. Otherwise the field is
 * written as {"withheld_bytes": n} and the line goes on.
 *
 * The guard. lm_lines_flush() searches each line once more before writing
 * it. A line that still holds a secret (one put together from several
 * fields, or a mistake in a caller) is not written; in its place goes
 *     {"event":"line_withheld","t":<its t>,"withheld_event":<its name>,"withheld_bytes":<its length>}
 * and the stream goes on. lm_secret_add() refuses a secret any of whose forms
 * could appear inside a sample_started, sample_ended, verified, line_withheld
 * or finished line, so those lines, which the stream's order depends on, are
 * never the ones withheld (and `finished`, which lm.c writes past the guard,
 * never holds one).
 *
 * Single-threaded: call from the thread that owns stdout, never inside a
 * measured interval (these allocate and write).
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define LM_LINES_MAX_DEPTH 8

typedef struct {
    char *text;
    size_t len;
    size_t cap;
    size_t line_start;                  /* where the open line began */
    int depth;                          /* open levels of the current line, the line's object included; 0 between lines */
    bool is_array[LM_LINES_MAX_DEPTH];
    bool empty[LM_LINES_MAX_DEPTH];
} lm_lines;

void lm_lines_init(lm_lines *b);
void lm_lines_free(lm_lines *b);

/* Starts a line: {"event":<name>,"t":<t> */
void lm_lines_begin(lm_lines *b, const char *name, uint64_t t);
/* Closes whatever is open in the line, then the line itself, and adds the newline. */
void lm_lines_end(lm_lines *b);

/* Members. `key` is NULL inside an array and required inside an object. */
void lm_lines_u64(lm_lines *b, const char *key, uint64_t value);
void lm_lines_i64(lm_lines *b, const char *key, int64_t value);
void lm_lines_bool(lm_lines *b, const char *key, bool value);
void lm_lines_null(lm_lines *b, const char *key);
/* A string the program made itself (names, addresses, numbers as text): any
 * bytes, written as a JSON string; bytes 0x80 and above pass through, so it
 * must be UTF-8. */
void lm_lines_str(lm_lines *b, const char *key, const char *value);
/* Bytes received from elsewhere, verbatim: a JSON string when they are valid
 * UTF-8 holding no NUL byte, otherwise {"base64":"..."}; or
 * {"withheld_bytes":n} when the decision above refuses them. */
void lm_lines_bytes(lm_lines *b, const char *key, const void *data, size_t len);
/* Received bytes as base64, in a JSON string (a certificate's DER), or
 * {"withheld_bytes":n} when the decision above refuses them. */
void lm_lines_base64(lm_lines *b, const char *key, const void *data, size_t len);
/* Bytes as lowercase hex, in a JSON string (a digest). */
void lm_lines_hex(lm_lines *b, const char *key, const void *data, size_t len);

void lm_lines_object(lm_lines *b, const char *key);
void lm_lines_array(lm_lines *b, const char *key);
void lm_lines_close(lm_lines *b);

/* Writes every complete line to stdout, each line that holds a registered
 * secret replaced as above, and empties the buffer. Exits 1 if a line is
 * still open, 3 if stdout cannot be written (as lm.c does). */
void lm_lines_flush(lm_lines *b);

/* The caller's own rule for received bytes, beside the secret search: return
 * false to have them withheld. It is applied to the bytes and to the text
 * written for them. NULL (the default) accepts everything. */
void lm_lines_set_filter(bool (*may_print)(const void *data, size_t len));

/* How many fields lm_lines_bytes() and lm_lines_base64() withheld, and how
 * many lines the guard replaced, since the program started. */
uint64_t lm_lines_withheld_fields(void);
uint64_t lm_lines_withheld_lines(void);

/* Registers a secret, copied, with these forms of it, each searched for
 * ignoring ASCII case:
 *   - the bytes themselves;
 *   - percent-encoded: every byte but A-Z a-z 0-9 - . _ ~ as %XX, and every
 *     byte as %XX;
 *   - base64 and base64url, at each of the three alignments it can take
 *     inside a longer encoded text (the characters that depend on its own
 *     bytes alone);
 *   - hexadecimal, with no separator and with a space, a colon or a hyphen
 *     between bytes.
 * `slot` names it, so registering again under the same slot replaces it (a
 * request's signature replaces the previous one). An empty secret clears the
 * slot. Returns false, registering nothing, when a form of the secret could
 * appear inside a sample_started, sample_ended, verified, line_withheld or
 * finished line (a secret made only of digits, say). Slots 0 to
 * LM_SECRET_SLOTS - 1. */
#define LM_SECRET_SLOTS 8
bool lm_secret_add(int slot, const void *secret, size_t len);
/* Whether `data` holds any registered secret, in any registered form,
 * ignoring ASCII case, as given or with the bytes up to 0x20 taken out. */
bool lm_secret_found(const void *data, size_t len);

/* Base64 of `data` into `out` (which must hold 4 * ((len + 2) / 3) + 1
 * bytes), NUL-terminated; returns the length written. */
size_t lm_base64(const void *data, size_t len, char *out);

#endif /* LEDGERMATH_LM_LINES_H */
