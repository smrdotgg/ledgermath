#ifndef LEDGERMATH_LM_SIGV4_H
#define LEDGERMATH_LM_SIGV4_H

/* AWS Signature Version 4, header signing, for the C harness. No I/O and no
 * clock: the caller gives the time as x-amz-date's value.
 *
 * Follows "Create a signed AWS API request" in the IAM User Guide: the
 * canonical request, the string to sign, the signing key derived from the
 * secret by four HMAC-SHA256 steps, and the signature. The canonical URI is
 * given already encoded, because S3 encodes a key once and never normalizes
 * it (lm_sigv4_encode_path does that encoding), unlike most services.
 *
 * Everything this produces except signed_headers and credential_scope is
 * secret or carries a secret (the canonical request holds the session token):
 * the caller registers the signature with lm_secret_add() and prints none of
 * it.
 */

#include <stddef.h>

typedef struct {
    const char *name;
    const char *value;
} lm_sigv4_header;

typedef struct {
    const char *method;            /* "GET" */
    const char *canonical_uri;     /* encoded, e.g. "/http_get/v1/4096" */
    const char *canonical_query;   /* "" when there is no query; otherwise already canonical */
    const lm_sigv4_header *headers;/* every header to sign, host and x-amz-date included */
    size_t header_count;
    const char *payload_sha256;    /* lowercase hex */
    const char *amz_date;          /* YYYYMMDDTHHMMSSZ */
    const char *region;
    const char *service;
    const char *access_key_id;
    const char *secret_access_key;
} lm_sigv4_request;

typedef struct {
    char canonical_request[8192];
    char string_to_sign[512];
    char signed_headers[1024];
    char credential_scope[128];    /* YYYYMMDD/<region>/<service>/aws4_request */
    char signature[65];
    char authorization[2048];      /* the Authorization header's value */
} lm_sigv4_result;

/* Returns NULL, or a reason the request cannot be signed (a field too long,
 * a malformed date, two headers that differ only in case are not a reason:
 * their values are joined as SigV4 says). */
const char *lm_sigv4_sign(const lm_sigv4_request *req, lm_sigv4_result *out);

/* Encodes a path as S3's canonical URI wants it: every byte but the
 * unreserved characters (A-Z a-z 0-9 - . _ ~) and '/' as %XX, upper case.
 * Returns the length, or 0 when out is too small. */
size_t lm_sigv4_encode_path(const char *path, char *out, size_t cap);

/* SHA-256 of `data` as 64 lowercase hex digits and a NUL. */
void lm_sha256_hex(const void *data, size_t len, char out[65]);

#endif /* LEDGERMATH_LM_SIGV4_H */
