#ifndef LEDGERMATH_LM_HTTP_H
#define LEDGERMATH_LM_HTTP_H

/* An HTTP/1.1 response parser for the C harness (RFC 9112), fed the bytes a
 * connection delivers. No I/O and no clock.
 *
 * It keeps the status line and every header line verbatim, in order, and
 * frames the body by Transfer-Encoding: chunked, by Content-Length, or by the
 * end of the connection, writing the body (de-chunked) into a buffer the
 * caller owns. It is strict where leniency would hide something: obsolete line
 * folding, a bare CR or LF, whitespace before a header's colon, Content-Length
 * values that disagree, a transfer coding other than chunked, a header block
 * over its limit, and an interim (1xx) response are each an error, with the
 * bytes received kept.
 *
 * lm_http_feed() stops at the end of the header block, so the caller can
 * mark that moment before any body byte is handled, and then feeds the rest.
 * Trailer fields after a chunked body are kept as the header lines are, with
 * the same rules.
 *
 * For a body framed by length or by the connection's end, lm_http_direct()
 * says where the next body bytes go, so the caller can read them straight
 * into the body buffer without a copy.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define LM_HTTP_MAX_HEADERS 128
#define LM_HTTP_MAX_TRAILERS 32

typedef enum { LM_HTTP_HEAD, LM_HTTP_BODY, LM_HTTP_DONE, LM_HTTP_ERROR } lm_http_state;
typedef enum { LM_HTTP_NONE, LM_HTTP_LENGTH, LM_HTTP_CHUNKED, LM_HTTP_CLOSE } lm_http_framing;

typedef struct {
    size_t name, name_len;     /* offsets into head (or into trailer, for a trailer field) */
    size_t value, value_len;   /* the field value, without the optional whitespace around it (RFC 9110 5.5) */
} lm_http_header;

typedef struct {
    lm_http_state state;
    const char *error;          /* why, in LM_HTTP_ERROR */

    /* The header block as received, status line first, up to and including
     * the blank line that ends it. */
    unsigned char *head;
    size_t head_len;
    size_t max_head;

    unsigned version_minor;     /* HTTP/1.<n> */
    unsigned status;
    size_t status_line_len;     /* head[0, status_line_len) is the status line, without its CRLF */
    unsigned headers;
    lm_http_header header[LM_HTTP_MAX_HEADERS];

    lm_http_framing framing;
    uint64_t content_length;    /* LM_HTTP_LENGTH */
    bool keep_alive;            /* whether the connection may carry another request */

    unsigned char *body;        /* the caller's buffer */
    size_t body_cap;
    size_t body_len;            /* body bytes, de-chunked */
    uint64_t wire_bytes;        /* bytes after the header block: body, chunk framing and trailers */

    /* chunked */
    int chunk_state;
    uint64_t chunk_left;
    unsigned char line[1024];   /* a chunk-size line or a trailer line being read */
    size_t line_len;
    size_t trailer_bytes;       /* bytes of the trailer section, CRLFs included */

    /* The trailer fields, each line as received without its CRLF, one after
     * another in `trailer`; trailer_field offsets point into it. */
    unsigned char *trailer;
    size_t trailer_len;
    unsigned trailers;
    lm_http_header trailer_field[LM_HTTP_MAX_TRAILERS];
} lm_http_response;

/* `body` holds up to `body_cap` body bytes; a longer body is an error.
 * `max_head` limits the header block (and the trailers, together). The parser
 * allocates its copy of the header block; lm_http_free releases it. */
void lm_http_init(lm_http_response *r, unsigned char *body, size_t body_cap, size_t max_head);
void lm_http_free(lm_http_response *r);

/* Feeds bytes. Returns how many it consumed. In LM_HTTP_HEAD it consumes up
 * to the end of the header block and stops there, whatever state that leaves
 * (LM_HTTP_BODY, LM_HTTP_DONE for a response with no body, LM_HTTP_ERROR):
 * the caller feeds the rest again. In LM_HTTP_BODY it consumes all of them,
 * unless the response ended (LM_HTTP_DONE, and the rest came after the
 * response) or the parser stopped at an error (LM_HTTP_ERROR). */
size_t lm_http_feed(lm_http_response *r, const unsigned char *data, size_t len);

/* In LM_HTTP_BODY with a body framed by length or by the connection's end:
 * true, with where the next body bytes go and how many may go there (never
 * past the end of a length-framed body). False otherwise; then feed bytes
 * instead. Sets an error, and returns false, when the body buffer is full and
 * the body is not over. */
bool lm_http_direct(lm_http_response *r, unsigned char **where, size_t *room);
/* After reading `n` bytes to where lm_http_direct() said. */
void lm_http_direct_done(lm_http_response *r, size_t n);

/* The connection ended in an orderly way: ends a body framed by the end of
 * the connection, and is an error anywhere else. */
void lm_http_eof(lm_http_response *r);

/* The value of the first header named `name` (ignoring case), or NULL; its
 * length in *len. */
const unsigned char *lm_http_get(const lm_http_response *r, const char *name, size_t *len);

#endif /* LEDGERMATH_LM_HTTP_H */
