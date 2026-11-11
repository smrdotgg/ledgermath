#include "lm_sigv4.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/crypto.h>
#include <openssl/digest.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>

static void hex(const unsigned char *p, size_t n, char *out) {
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        out[2 * i] = digits[p[i] >> 4];
        out[2 * i + 1] = digits[p[i] & 15];
    }
    out[2 * n] = '\0';
}

void lm_sha256_hex(const void *data, size_t len, char out[65]) {
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(data, len, digest);
    hex(digest, sizeof(digest), out);
}

size_t lm_sigv4_encode_path(const char *path, char *out, size_t cap) {
    static const char digits[] = "0123456789ABCDEF";
    size_t o = 0;
    for (const unsigned char *p = (const unsigned char *)path; *p; p++) {
        unsigned char c = *p;
        bool keep = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' ||
                    c == '_' || c == '~' || c == '/';
        if (o + (keep ? 1 : 3) >= cap) return 0;
        if (keep) {
            out[o++] = (char)c;
        } else {
            out[o++] = '%';
            out[o++] = digits[c >> 4];
            out[o++] = digits[c & 15];
        }
    }
    out[o] = '\0';
    return o;
}

typedef struct {
    char *text;
    size_t len;
    size_t cap;
    bool overflow;
} sink;

static void add(sink *s, const char *text, size_t n) {
    if (s->overflow || s->len + n >= s->cap) {
        s->overflow = true;
        return;
    }
    memcpy(s->text + s->len, text, n);
    s->len += n;
    s->text[s->len] = '\0';
}

static void adds(sink *s, const char *text) { add(s, text, strlen(text)); }

/* A header value as SigV4 canonicalizes it: no whitespace at either end, and
 * every run of spaces inside it as one space. */
static void add_trimmed(sink *s, const char *value) {
    const char *p = value;
    const char *end = value + strlen(value);
    while (p < end && (*p == ' ' || *p == '\t')) p++;
    while (end > p && (end[-1] == ' ' || end[-1] == '\t')) end--;
    bool space = false;
    for (; p < end; p++) {
        if (*p == ' ' || *p == '\t') {
            space = true;
            continue;
        }
        if (space) add(s, " ", 1);
        space = false;
        add(s, p, 1);
    }
}

typedef struct {
    char name[128];
    size_t index;
} named;

static int by_name(const void *a, const void *b) {
    const named *x = a, *y = b;
    int c = strcmp(x->name, y->name);
    if (c != 0) return c;
    return (x->index > y->index) - (x->index < y->index); /* keep the order given for one name */
}

static bool hmac(const void *key, size_t key_len, const char *data, unsigned char out[32]) {
    unsigned int n = 0;
    return HMAC(EVP_sha256(), key, key_len, (const unsigned char *)data, strlen(data), out, &n) != NULL && n == 32;
}

const char *lm_sigv4_sign(const lm_sigv4_request *req, lm_sigv4_result *out) {
    memset(out, 0, sizeof(*out));
    if (strlen(req->amz_date) != 16 || req->amz_date[8] != 'T' || req->amz_date[15] != 'Z') return "x-amz-date is not YYYYMMDDTHHMMSSZ";
    if (req->header_count == 0 || req->header_count > 64) return "between 1 and 64 headers are signed";

    named *names = calloc(req->header_count, sizeof(named));
    if (names == NULL) return "out of memory";
    for (size_t i = 0; i < req->header_count; i++) {
        size_t n = strlen(req->headers[i].name);
        if (n == 0 || n >= sizeof(names[i].name)) {
            free(names);
            return "a header name is empty or too long";
        }
        for (size_t k = 0; k < n; k++) {
            char c = req->headers[i].name[k];
            names[i].name[k] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c;
        }
        names[i].index = i;
    }
    qsort(names, req->header_count, sizeof(named), by_name);

    sink headers = { out->canonical_request, 0, sizeof(out->canonical_request), false };
    sink signed_headers = { out->signed_headers, 0, sizeof(out->signed_headers), false };
    adds(&headers, req->method);
    adds(&headers, "\n");
    adds(&headers, req->canonical_uri);
    adds(&headers, "\n");
    adds(&headers, req->canonical_query);
    adds(&headers, "\n");
    for (size_t i = 0; i < req->header_count; i++) {
        bool first_of_name = i == 0 || strcmp(names[i].name, names[i - 1].name) != 0;
        if (first_of_name) {
            if (i > 0) adds(&headers, "\n");
            adds(&headers, names[i].name);
            adds(&headers, ":");
            if (signed_headers.len > 0) adds(&signed_headers, ";");
            adds(&signed_headers, names[i].name);
        } else {
            adds(&headers, ",");
        }
        add_trimmed(&headers, req->headers[names[i].index].value);
    }
    free(names);
    adds(&headers, "\n\n");
    adds(&headers, out->signed_headers);
    adds(&headers, "\n");
    adds(&headers, req->payload_sha256);
    if (headers.overflow || signed_headers.overflow) return "the canonical request is too long";

    char date[9];
    memcpy(date, req->amz_date, 8);
    date[8] = '\0';
    int n = snprintf(out->credential_scope, sizeof(out->credential_scope), "%s/%s/%s/aws4_request", date, req->region, req->service);
    if (n < 0 || (size_t)n >= sizeof(out->credential_scope)) return "the credential scope is too long";

    char request_hash[65];
    lm_sha256_hex(out->canonical_request, strlen(out->canonical_request), request_hash);
    n = snprintf(out->string_to_sign, sizeof(out->string_to_sign), "AWS4-HMAC-SHA256\n%s\n%s\n%s", req->amz_date, out->credential_scope,
                 request_hash);
    if (n < 0 || (size_t)n >= sizeof(out->string_to_sign)) return "the string to sign is too long";

    /* The signing key: HMAC("AWS4" + secret, date), then the region, the service and "aws4_request". */
    size_t secret_len = strlen(req->secret_access_key);
    char *first_key = malloc(secret_len + 5);
    if (first_key == NULL) return "out of memory";
    memcpy(first_key, "AWS4", 4);
    memcpy(first_key + 4, req->secret_access_key, secret_len + 1);
    unsigned char k_date[32], k_region[32], k_service[32], k_signing[32], signature[32];
    bool ok = hmac(first_key, secret_len + 4, date, k_date) && hmac(k_date, 32, req->region, k_region) &&
              hmac(k_region, 32, req->service, k_service) && hmac(k_service, 32, "aws4_request", k_signing) &&
              hmac(k_signing, 32, out->string_to_sign, signature);
    OPENSSL_cleanse(first_key, secret_len + 4);
    free(first_key);
    OPENSSL_cleanse(k_date, sizeof(k_date));
    OPENSSL_cleanse(k_region, sizeof(k_region));
    OPENSSL_cleanse(k_service, sizeof(k_service));
    OPENSSL_cleanse(k_signing, sizeof(k_signing));
    if (!ok) return "HMAC-SHA256 failed";
    hex(signature, sizeof(signature), out->signature);

    n = snprintf(out->authorization, sizeof(out->authorization), "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
                 req->access_key_id, out->credential_scope, out->signed_headers, out->signature);
    if (n < 0 || (size_t)n >= sizeof(out->authorization)) return "the Authorization header is too long";
    return NULL;
}
