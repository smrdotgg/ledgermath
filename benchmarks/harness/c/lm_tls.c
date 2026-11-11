#include "lm_tls.h"

#include "lm.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <openssl/base.h>
#include <openssl/bio.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/pool.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#if !defined(LM_AWS_LC_VERSION)
#error "LM_AWS_LC_VERSION must be defined from benchmarks/harness/c/vendor/aws-lc.lock"
#endif

/* ---- the pinned offer ---- */

static const char kTls13Suites[] = "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256";
static const char kTls12Suites[] =
    "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:"
    "ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305";
/* AWS-LC 5.14.0's own default list (ssl/extensions.cc, kDefaultGroups), pinned. */
static const uint16_t kGroups[] = {
    SSL_GROUP_X25519_MLKEM768, SSL_GROUP_SECP256R1_MLKEM768, SSL_GROUP_SECP384R1_MLKEM1024,
    SSL_GROUP_X25519,          SSL_GROUP_SECP256R1,          SSL_GROUP_SECP384R1,
};
/* AWS-LC 5.14.0's own default list for verifying (ssl/extensions.cc, kVerifySignatureAlgorithms), pinned. */
static const uint16_t kVerifyAlgorithms[] = {
    SSL_SIGN_ECDSA_SECP256R1_SHA256, SSL_SIGN_RSA_PSS_RSAE_SHA256, SSL_SIGN_RSA_PKCS1_SHA256,
    SSL_SIGN_ECDSA_SECP384R1_SHA384, SSL_SIGN_RSA_PSS_RSAE_SHA384, SSL_SIGN_RSA_PKCS1_SHA384,
    SSL_SIGN_ECDSA_SECP521R1_SHA512, SSL_SIGN_RSA_PSS_RSAE_SHA512, SSL_SIGN_RSA_PKCS1_SHA512,
    SSL_SIGN_MLDSA44,                SSL_SIGN_MLDSA65,             SSL_SIGN_MLDSA87,
    SSL_SIGN_RSA_PKCS1_SHA1,
};
static const unsigned char kAlpn[] = "\x08http/1.1";

static SSL_CTX *g_ctx;
static int g_index = -1;
static unsigned g_loaded, g_rejected;

struct lm_tls_conn {
    SSL *ssl;
    unsigned sessions;
    unsigned tickets;
    int alert;
    int failed_ret;   /* what the failed call returned, and errno just after, for lm_tls_failure() */
    int failed_errno;
    char detail[256];
};

const char *lm_tls_library(void) { return "AWS-LC " AWSLC_VERSION_NUMBER_STRING; }
unsigned lm_tls_ca_loaded(void) { return g_loaded; }
unsigned lm_tls_ca_rejected(void) { return g_rejected; }

/* Counts a session the server offers, and whether it came as a ticket, and
 * keeps none, so nothing is ever offered back. */
static int on_new_session(SSL *ssl, SSL_SESSION *session) {
    lm_tls_conn *c = SSL_get_ex_data(ssl, g_index);
    if (c != NULL) {
        c->sessions++;
        if (SSL_SESSION_has_ticket(session)) c->tickets++;
    }
    return 0;
}

static void last_error(char *out, size_t cap) {
    uint32_t e = ERR_peek_last_error();
    if (e == 0) snprintf(out, cap, "no error queued");
    else ERR_error_string_n(e, out, cap);
    ERR_clear_error();
}

bool lm_tls_init(const char *ca_file, char *err, size_t errlen) {
    if (strcmp(AWSLC_VERSION_NUMBER_STRING, LM_AWS_LC_VERSION) != 0) {
        snprintf(err, errlen, "compiled against AWS-LC %s, but aws-lc.lock pins %s", AWSLC_VERSION_NUMBER_STRING, LM_AWS_LC_VERSION);
        return false;
    }
    g_ctx = SSL_CTX_new(TLS_client_method());
    if (g_ctx == NULL) {
        snprintf(err, errlen, "SSL_CTX_new failed");
        return false;
    }
    char why[256];
    if (!SSL_CTX_set_min_proto_version(g_ctx, TLS1_2_VERSION) || !SSL_CTX_set_max_proto_version(g_ctx, TLS1_3_VERSION) ||
        !SSL_CTX_set_ciphersuites(g_ctx, kTls13Suites) || !SSL_CTX_set_strict_cipher_list(g_ctx, kTls12Suites) ||
        !SSL_CTX_set1_group_ids(g_ctx, kGroups, sizeof(kGroups) / sizeof(kGroups[0])) ||
        !SSL_CTX_set_verify_algorithm_prefs(g_ctx, kVerifyAlgorithms, sizeof(kVerifyAlgorithms) / sizeof(kVerifyAlgorithms[0])) ||
        SSL_CTX_set_alpn_protos(g_ctx, kAlpn, sizeof(kAlpn) - 1) != 0) {
        last_error(why, sizeof(why));
        snprintf(err, errlen, "the TLS configuration was refused: %s", why);
        return false;
    }
    SSL_CTX_set_grease_enabled(g_ctx, 0);
    SSL_CTX_set_permute_extensions(g_ctx, 0);
    SSL_CTX_clear_options(g_ctx, SSL_OP_NO_TICKET);
    SSL_CTX_set_session_cache_mode(g_ctx, SSL_SESS_CACHE_CLIENT | SSL_SESS_CACHE_NO_INTERNAL);
    SSL_CTX_sess_set_new_cb(g_ctx, on_new_session);
    SSL_CTX_set_verify(g_ctx, SSL_VERIFY_PEER, NULL);
    g_index = SSL_get_ex_new_index(0, NULL, NULL, NULL, NULL);

    /* The trust store: every certificate in the bundle, counted. */
    BIO *bio = BIO_new_file(ca_file, "r");
    if (bio == NULL) {
        snprintf(err, errlen, "cannot read the CA file %s: %s", ca_file, strerror(errno));
        ERR_clear_error();
        return false;
    }
    STACK_OF(X509_INFO) *infos = PEM_X509_INFO_read_bio(bio, NULL, NULL, NULL);
    BIO_free(bio);
    if (infos == NULL) {
        last_error(why, sizeof(why));
        snprintf(err, errlen, "the CA file %s is not PEM certificates: %s", ca_file, why);
        return false;
    }
    X509_STORE *store = SSL_CTX_get_cert_store(g_ctx);
    for (size_t i = 0; i < sk_X509_INFO_num(infos); i++) {
        X509_INFO *info = sk_X509_INFO_value(infos, i);
        if (info->x509 == NULL) continue;
        if (X509_STORE_add_cert(store, info->x509)) g_loaded++;
        else g_rejected++;
    }
    sk_X509_INFO_pop_free(infos, X509_INFO_free);
    ERR_clear_error();
    if (g_loaded == 0) {
        snprintf(err, errlen, "the CA file %s holds no certificate", ca_file);
        return false;
    }
    return true;
}

lm_tls_conn *lm_tls_new(const char *host) {
    lm_tls_conn *c = calloc(1, sizeof(*c));
    if (c == NULL) return NULL;
    c->ssl = SSL_new(g_ctx);
    if (c->ssl == NULL || SSL_set_tlsext_host_name(c->ssl, host) != 1 || SSL_set1_host(c->ssl, host) != 1) {
        if (c->ssl != NULL) SSL_free(c->ssl);
        free(c);
        ERR_clear_error();
        return NULL;
    }
    /* The name is matched against the subject alternative names only: a
     * certificate with none is refused rather than matched by its common name. */
    SSL_set_hostflags(c->ssl, X509_CHECK_FLAG_NEVER_CHECK_SUBJECT);
    SSL_set_renegotiate_mode(c->ssl, ssl_renegotiate_never);
    SSL_set_ex_data(c->ssl, g_index, c);
    c->alert = -1;
    return c;
}

void lm_tls_free(lm_tls_conn *c) {
    if (c == NULL) return;
    SSL_free(c->ssl);
    free(c);
}

/* What a failed call means. `ret` is what it returned, `saved` errno just
 * after. The library's own error comes first: it says whether the server sent
 * an alert, whether the certificate check ran and failed, or what else went
 * wrong. Only with nothing queued is errno consulted. The verification result
 * alone says nothing: it reads as an error until a chain has been checked. */
static int classify(lm_tls_conn *c, int ret, int saved) {
    c->alert = -1;
    int e = SSL_get_error(c->ssl, ret);
    if (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) {
        /* On a blocking socket only its timeout makes a call want to be retried. */
        snprintf(c->detail, sizeof(c->detail), "nothing could be %s within the socket's timeout", e == SSL_ERROR_WANT_READ ? "read" : "written");
        ERR_clear_error();
        return LM_TLS_TIMEOUT;
    }
    if (ERR_peek_error() != 0) {
        /* The queue, oldest first; the decision looks at every entry. */
        uint32_t codes[16];
        size_t n = 0;
        uint32_t code;
        while ((code = ERR_get_error()) != 0) {
            if (n < sizeof(codes) / sizeof(codes[0])) codes[n++] = code;
        }
        for (size_t i = 0; i < n; i++) {
            if (ERR_GET_LIB(codes[i]) != ERR_LIB_SSL) continue;
            int reason = ERR_GET_REASON(codes[i]);
            if (reason >= SSL_AD_REASON_OFFSET && reason < SSL_AD_REASON_OFFSET + 256) {
                c->alert = reason - SSL_AD_REASON_OFFSET;
                ERR_error_string_n(codes[i], c->detail, sizeof(c->detail));
                return LM_TLS_ALERT;
            }
            if (reason == SSL_R_CERTIFICATE_VERIFY_FAILED) {
                long verify = SSL_get_verify_result(c->ssl);
                snprintf(c->detail, sizeof(c->detail), "%s", X509_verify_cert_error_string(verify));
                return LM_TLS_VERIFY;
            }
        }
        ERR_error_string_n(codes[n - 1], c->detail, sizeof(c->detail));
        for (size_t i = 0; i < n; i++) {
            if (ERR_GET_LIB(codes[i]) == ERR_LIB_SSL && ERR_GET_REASON(codes[i]) == SSL_R_UNEXPECTED_EOF_WHILE_READING) return LM_TLS_EOF;
        }
        if (strstr(c->detail, "UNEXPECTED_EOF") != NULL) return LM_TLS_EOF;
        return LM_TLS_PROTOCOL;
    }
    if (e == SSL_ERROR_SYSCALL) {
        if (saved == 0) {
            snprintf(c->detail, sizeof(c->detail), "the peer closed TCP without close_notify");
            return LM_TLS_EOF;
        }
        if (saved == EAGAIN || saved == EWOULDBLOCK) {
            snprintf(c->detail, sizeof(c->detail), "nothing could be read or written within the socket's timeout");
            return LM_TLS_TIMEOUT;
        }
        snprintf(c->detail, sizeof(c->detail), "%s", strerror(saved));
        if (saved == ECONNRESET || saved == EPIPE) return LM_TLS_RESET;
        return LM_TLS_SYSTEM;
    }
    snprintf(c->detail, sizeof(c->detail), "SSL_get_error %d, nothing queued", e);
    return LM_TLS_PROTOCOL;
}

/* A measured call failed: keep what it returned and errno, and nothing more,
 * so the caller can read its clock before lm_tls_failure() looks into it. */
static int deferred(lm_tls_conn *c, int ret, int saved) {
    c->failed_ret = ret;
    c->failed_errno = saved;
    return LM_TLS_FAILED;
}

int lm_tls_failure(lm_tls_conn *c) { return classify(c, c->failed_ret, c->failed_errno); }

int lm_tls_handshake(lm_tls_conn *c, int fd) {
    if (SSL_set_fd(c->ssl, fd) != 1) {
        last_error(c->detail, sizeof(c->detail));
        return LM_TLS_SYSTEM;
    }
    errno = 0;
    int r = SSL_connect(c->ssl);
    if (r == 1) return LM_TLS_OK;
    return deferred(c, r, errno);
}

int lm_tls_write(lm_tls_conn *c, const void *buf, size_t len) {
    if (len > 0x40000000) return LM_TLS_SYSTEM;
    errno = 0;
    int r = SSL_write(c->ssl, buf, (int)len);
    if (r == (int)len) return LM_TLS_OK;
    return deferred(c, r, errno);
}

long lm_tls_read(lm_tls_conn *c, void *buf, size_t len) {
    if (len > 0x40000000) len = 0x40000000;
    errno = 0;
    int r = SSL_read(c->ssl, buf, (int)len);
    if (r > 0) return r;
    int saved = errno;
    if (SSL_get_error(c->ssl, r) == SSL_ERROR_ZERO_RETURN) return 0;
    return -deferred(c, r, saved);
}

lm_tls_idle lm_tls_check_idle(lm_tls_conn *c, int fd) {
    unsigned char peek;
    ssize_t n = recv(fd, &peek, 1, MSG_PEEK | MSG_DONTWAIT);
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return SSL_pending(c->ssl) > 0 ? LM_TLS_IDLE_DATA : LM_TLS_IDLE;
    if (n == 0) return LM_TLS_IDLE_EOF;
    if (n < 0) {
        snprintf(c->detail, sizeof(c->detail), "%s", strerror(errno));
        return LM_TLS_IDLE_ERROR;
    }
    /* Bytes are waiting: let the library read them without blocking. */
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) return LM_TLS_IDLE_ERROR;
    unsigned char byte;
    lm_tls_idle result = LM_TLS_IDLE;
    for (;;) {
        errno = 0;
        int r = SSL_read(c->ssl, &byte, 1);
        if (r > 0) {
            result = LM_TLS_IDLE_DATA;
            break;
        }
        int e = SSL_get_error(c->ssl, r);
        if (e == SSL_ERROR_WANT_READ) break; /* everything waiting was handshake messages, now taken */
        if (e == SSL_ERROR_ZERO_RETURN) {
            result = LM_TLS_IDLE_CLOSE_NOTIFY;
            break;
        }
        int kind = classify(c, r, errno);
        result = kind == LM_TLS_EOF ? LM_TLS_IDLE_EOF : LM_TLS_IDLE_ERROR;
        break;
    }
    if (fcntl(fd, F_SETFL, flags) != 0) return LM_TLS_IDLE_ERROR;
    return result;
}

void lm_tls_shutdown(lm_tls_conn *c) {
    SSL_set_quiet_shutdown(c->ssl, 0);
    SSL_shutdown(c->ssl);
    ERR_clear_error();
}

const char *lm_tls_version(lm_tls_conn *c) { return SSL_get_version(c->ssl); }

const char *lm_tls_cipher(lm_tls_conn *c) {
    const SSL_CIPHER *cipher = SSL_get_current_cipher(c->ssl);
    return cipher != NULL ? SSL_CIPHER_standard_name(cipher) : "";
}

const char *lm_tls_group(lm_tls_conn *c) {
    const char *name = SSL_get_group_name(SSL_get_group_id(c->ssl));
    return name != NULL ? name : "";
}

const char *lm_tls_peer_signature(lm_tls_conn *c) {
    const char *name = SSL_get_signature_algorithm_name(SSL_get_peer_signature_algorithm(c->ssl), 1);
    return name != NULL ? name : "";
}

void lm_tls_alpn(lm_tls_conn *c, char *out, size_t cap) {
    const uint8_t *p = NULL;
    unsigned n = 0;
    SSL_get0_alpn_selected(c->ssl, &p, &n);
    if (n >= cap) n = (unsigned)cap - 1;
    if (n > 0) memcpy(out, p, n);
    out[n] = '\0';
}

bool lm_tls_hello_retry(lm_tls_conn *c) { return SSL_used_hello_retry_request(c->ssl) != 0; }
bool lm_tls_resumed(lm_tls_conn *c) { return SSL_session_reused(c->ssl) != 0; }
unsigned lm_tls_sessions(lm_tls_conn *c) { return c->sessions; }
unsigned lm_tls_tickets(lm_tls_conn *c) { return c->tickets; }
size_t lm_tls_pending(lm_tls_conn *c) { return (size_t)SSL_pending(c->ssl); }
const char *lm_tls_error_detail(lm_tls_conn *c) { return c->detail; }
int lm_tls_alert(lm_tls_conn *c) { return c->alert; }
const char *lm_tls_alert_name(lm_tls_conn *c) { return c->alert >= 0 ? SSL_alert_desc_string_long(c->alert) : ""; }

const char *lm_tls_verify_result(lm_tls_conn *c) {
    long v = SSL_get_verify_result(c->ssl);
    return v == X509_V_OK ? "ok" : X509_verify_cert_error_string(v);
}

/* The chain the server sent: the established session's, or during and after
 * a failed handshake the session being made, once the Certificate message has
 * been read. */
static const STACK_OF(CRYPTO_BUFFER) *peer_chain(lm_tls_conn *c) {
    if (SSL_get_session(c->ssl) == NULL) return NULL;
    return SSL_get0_peer_certificates(c->ssl);
}

size_t lm_tls_peer_chain_count(lm_tls_conn *c) {
    const STACK_OF(CRYPTO_BUFFER) *chain = peer_chain(c);
    return chain != NULL ? sk_CRYPTO_BUFFER_num(chain) : 0;
}

void lm_tls_peer_cert(lm_tls_conn *c, size_t i, const unsigned char **der, size_t *len) {
    const CRYPTO_BUFFER *buffer = sk_CRYPTO_BUFFER_value(peer_chain(c), i);
    *der = CRYPTO_BUFFER_data(buffer);
    *len = CRYPTO_BUFFER_len(buffer);
}

/* ---- the ClientHello, made and read back with no network ---- */

static const char *extension_name(uint16_t type) {
    switch (type) {
    case 0: return "server_name";
    case 5: return "status_request";
    case 10: return "supported_groups";
    case 11: return "ec_point_formats";
    case 13: return "signature_algorithms";
    case 16: return "application_layer_protocol_negotiation";
    case 18: return "signed_certificate_timestamp";
    case 21: return "padding";
    case 22: return "encrypt_then_mac";
    case 23: return "extended_master_secret";
    case 27: return "compress_certificate";
    case 35: return "session_ticket";
    case 41: return "pre_shared_key";
    case 42: return "early_data";
    case 43: return "supported_versions";
    case 45: return "psk_key_exchange_modes";
    case 49: return "post_handshake_auth";
    case 50: return "signature_algorithms_cert";
    case 51: return "key_share";
    case 65281: return "renegotiation_info";
    default: return NULL;
    }
}

static void code_or_name(lm_lines *b, const char *name, uint16_t code) {
    if (name != NULL) {
        lm_lines_str(b, NULL, name);
    } else {
        char text[16];
        snprintf(text, sizeof(text), "0x%04x", code);
        lm_lines_str(b, NULL, text);
    }
}

static const char *version_name(uint16_t v) {
    switch (v) {
    case 0x0304: return "TLSv1.3";
    case 0x0303: return "TLSv1.2";
    case 0x0302: return "TLSv1.1";
    case 0x0301: return "TLSv1";
    default: return NULL;
    }
}

/* Reads the ClientHello's body (after the handshake header) into `b`. */
static bool describe_client_hello(lm_lines *b, const uint8_t *body, size_t len, size_t record_bytes) {
    CBS hello, random, session_id, suites, compression, extensions;
    uint16_t legacy_version;
    CBS_init(&hello, body, len);
    if (!CBS_get_u16(&hello, &legacy_version) || !CBS_get_bytes(&hello, &random, 32) || !CBS_get_u8_length_prefixed(&hello, &session_id) ||
        !CBS_get_u16_length_prefixed(&hello, &suites) || !CBS_get_u8_length_prefixed(&hello, &compression) ||
        !CBS_get_u16_length_prefixed(&hello, &extensions)) {
        return false;
    }
    lm_lines_object(b, "client_hello");
    lm_lines_u64(b, "record_bytes", record_bytes);
    lm_lines_u64(b, "handshake_bytes", len + 4);
    lm_lines_str(b, "legacy_version", version_name(legacy_version) ? version_name(legacy_version) : "?");
    lm_lines_u64(b, "session_id_bytes", CBS_len(&session_id));
    lm_lines_array(b, "cipher_suites");
    while (CBS_len(&suites) >= 2) {
        uint16_t id;
        CBS_get_u16(&suites, &id);
        const SSL_CIPHER *cipher = SSL_get_cipher_by_value(id);
        code_or_name(b, cipher != NULL ? SSL_CIPHER_standard_name(cipher) : NULL, id);
    }
    lm_lines_close(b);
    lm_lines_array(b, "compression_methods");
    while (CBS_len(&compression) >= 1) {
        uint8_t m;
        CBS_get_u8(&compression, &m);
        lm_lines_u64(b, NULL, m);
    }
    lm_lines_close(b);

    /* The extensions in order, then the contents of the ones that say what is offered. */
    CBS walk = extensions;
    lm_lines_array(b, "extensions");
    while (CBS_len(&walk) >= 4) {
        uint16_t type;
        CBS data;
        if (!CBS_get_u16(&walk, &type) || !CBS_get_u16_length_prefixed(&walk, &data)) return false;
        code_or_name(b, extension_name(type), type);
    }
    lm_lines_close(b);
    walk = extensions;
    while (CBS_len(&walk) >= 4) {
        uint16_t type;
        CBS data, list;
        if (!CBS_get_u16(&walk, &type) || !CBS_get_u16_length_prefixed(&walk, &data)) return false;
        if (type == 0 && CBS_get_u16_length_prefixed(&data, &list)) {
            uint8_t name_type;
            CBS name;
            if (CBS_get_u8(&list, &name_type) && CBS_get_u16_length_prefixed(&list, &name)) {
                lm_lines_bytes(b, "server_name", CBS_data(&name), CBS_len(&name));
            }
        } else if (type == 10 && CBS_get_u16_length_prefixed(&data, &list)) {
            lm_lines_array(b, "supported_groups");
            while (CBS_len(&list) >= 2) {
                uint16_t g;
                CBS_get_u16(&list, &g);
                code_or_name(b, SSL_get_group_name(g), g);
            }
            lm_lines_close(b);
        } else if (type == 51 && CBS_get_u16_length_prefixed(&data, &list)) {
            lm_lines_array(b, "key_shares");
            while (CBS_len(&list) >= 4) {
                uint16_t g;
                CBS key;
                if (!CBS_get_u16(&list, &g) || !CBS_get_u16_length_prefixed(&list, &key)) break;
                lm_lines_object(b, NULL);
                lm_lines_str(b, "group", SSL_get_group_name(g) ? SSL_get_group_name(g) : "?");
                lm_lines_u64(b, "key_exchange_bytes", CBS_len(&key));
                lm_lines_close(b);
            }
            lm_lines_close(b);
        } else if (type == 13 && CBS_get_u16_length_prefixed(&data, &list)) {
            lm_lines_array(b, "signature_algorithms");
            while (CBS_len(&list) >= 2) {
                uint16_t s;
                CBS_get_u16(&list, &s);
                code_or_name(b, SSL_get_signature_algorithm_name(s, 1), s);
            }
            lm_lines_close(b);
        } else if (type == 43 && CBS_get_u8_length_prefixed(&data, &list)) {
            lm_lines_array(b, "supported_versions");
            while (CBS_len(&list) >= 2) {
                uint16_t v;
                CBS_get_u16(&list, &v);
                code_or_name(b, version_name(v), v);
            }
            lm_lines_close(b);
        } else if (type == 16 && CBS_get_u16_length_prefixed(&data, &list)) {
            lm_lines_array(b, "alpn");
            CBS protocol;
            while (CBS_get_u8_length_prefixed(&list, &protocol)) lm_lines_bytes(b, NULL, CBS_data(&protocol), CBS_len(&protocol));
            lm_lines_close(b);
        } else if (type == 45 && CBS_get_u8_length_prefixed(&data, &list)) {
            lm_lines_array(b, "psk_key_exchange_modes");
            uint8_t mode;
            while (CBS_get_u8(&list, &mode)) lm_lines_u64(b, NULL, mode);
            lm_lines_close(b);
        }
    }
    lm_lines_close(b);
    return true;
}

bool lm_tls_describe_offer(lm_lines *b, const char *host, char *err, size_t errlen) {
    SSL *ssl = SSL_new(g_ctx);
    BIO *rbio = BIO_new(BIO_s_mem());
    BIO *wbio = BIO_new(BIO_s_mem());
    bool ok = false;
    if (ssl == NULL || rbio == NULL || wbio == NULL || SSL_set_tlsext_host_name(ssl, host) != 1) {
        snprintf(err, errlen, "cannot make a TLS object to read the ClientHello");
        goto done;
    }
    SSL_set_bio(ssl, rbio, wbio);
    rbio = wbio = NULL; /* owned by ssl now */
    SSL_set_connect_state(ssl);
    int r = SSL_do_handshake(ssl);
    if (r == 1 || SSL_get_error(ssl, r) != SSL_ERROR_WANT_READ) {
        snprintf(err, errlen, "the handshake did not stop to wait for the server");
        goto done;
    }
    const uint8_t *out = NULL;
    size_t out_len = 0;
    if (!BIO_mem_contents(SSL_get_wbio(ssl), &out, &out_len)) {
        snprintf(err, errlen, "cannot read the ClientHello back");
        goto done;
    }
    /* One or more handshake records; the ClientHello is the first message. */
    uint8_t *message = malloc(out_len);
    size_t message_len = 0;
    CBS records;
    CBS_init(&records, out, out_len);
    while (message != NULL && CBS_len(&records) >= 5) {
        uint8_t type;
        uint16_t version;
        CBS fragment;
        if (!CBS_get_u8(&records, &type) || !CBS_get_u16(&records, &version) || !CBS_get_u16_length_prefixed(&records, &fragment) || type != 22) break;
        memcpy(message + message_len, CBS_data(&fragment), CBS_len(&fragment));
        message_len += CBS_len(&fragment);
    }
    CBS handshake, body;
    uint8_t msg_type;
    CBS_init(&handshake, message, message_len);
    if (message != NULL && CBS_get_u8(&handshake, &msg_type) && msg_type == 1 && CBS_get_u24_length_prefixed(&handshake, &body) &&
        describe_client_hello(b, CBS_data(&body), CBS_len(&body), out_len)) {
        ok = true;
    } else {
        snprintf(err, errlen, "the ClientHello could not be read back");
    }
    free(message);
done:
    BIO_free(rbio);
    BIO_free(wbio);
    SSL_free(ssl);
    ERR_clear_error();
    return ok;
}
