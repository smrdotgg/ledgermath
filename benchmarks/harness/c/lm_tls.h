#ifndef LEDGERMATH_LM_TLS_H
#define LEDGERMATH_LM_TLS_H

/* TLS client connections over AWS-LC, for the C harness.
 *
 * The caller owns the socket: it creates and connects it, sets its timeouts
 * (SO_RCVTIMEO, SO_SNDTIMEO), and hands it over for the handshake. Nothing
 * here reads a clock or retries; the library reads and writes the blocking
 * socket itself, and a call that the socket's timeout ends returns
 * LM_TLS_TIMEOUT.
 *
 * What the client offers is pinned here, call by call, rather than left to
 * the library's defaults, so a new AWS-LC release cannot change it silently:
 * TLS 1.2 to 1.3, the TLS 1.3 and TLS 1.2 cipher suites in a fixed order, the
 * key-exchange groups, the signature algorithms accepted, ALPN http/1.1, no
 * GREASE, no extension permutation, no OCSP or SCT request, no session offered
 * (no client session cache), renegotiation refused. lm_tls_client_hello()
 * makes the ClientHello these settings produce without any network, so the
 * Run records what was offered as well as what was configured.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "lm_lines.h"

enum {
    LM_TLS_OK = 0,
    LM_TLS_TIMEOUT = 1,     /* the socket's timeout ended a read or write */
    LM_TLS_RESET = 2,       /* ECONNRESET or EPIPE */
    LM_TLS_EOF = 3,         /* the peer closed TCP without close_notify */
    LM_TLS_PROTOCOL = 4,    /* a TLS error found on our side: a bad record, a malformed message, nothing in common */
    LM_TLS_VERIFY = 5,      /* the certificate check ran on the server's chain and failed */
    LM_TLS_SYSTEM = 6,      /* another errno */
    LM_TLS_ALERT = 7,       /* the server sent a fatal alert (lm_tls_alert says which) */
};

typedef struct lm_tls_conn lm_tls_conn;

/* Makes the client configuration and loads the CA bundle (PEM) at ca_file
 * into its trust store. Returns false with a reason in err. */
bool lm_tls_init(const char *ca_file, char *err, size_t errlen);

/* "AWS-LC 5.14.0", from the headers the binary was compiled with. */
const char *lm_tls_library(void);
unsigned lm_tls_ca_loaded(void);
unsigned lm_tls_ca_rejected(void);

/* Writes, as members of the open object of `b`, what the configuration
 * offers (`tls_offer`, as configured) and the ClientHello it produces for
 * `host` with no network (`client_hello`: its size, version, cipher suites,
 * extensions in order, groups, key shares, signature algorithms, versions,
 * ALPN). Does one throwaway handshake start, which also does the library's
 * one-time work (seeding its random number generator, first allocations)
 * before any sample. Returns false with a reason in err. */
bool lm_tls_describe_offer(lm_lines *b, const char *host, char *err, size_t errlen);

/* Before a sample: a connection object for `host` (SNI and the name to
 * verify). The name is checked against the certificate's subject alternative
 * names only, never its common name. */
lm_tls_conn *lm_tls_new(const char *host);
void lm_tls_free(lm_tls_conn *c);

/* The measured calls. Each returns LM_TLS_OK or an error above. */
int lm_tls_handshake(lm_tls_conn *c, int fd);
int lm_tls_write(lm_tls_conn *c, const void *buf, size_t len);
/* > 0: bytes read; 0: the peer sent close_notify; < 0: minus an error above. */
long lm_tls_read(lm_tls_conn *c, void *buf, size_t len);

/* Between requests on an idle connection: whether the server has closed it
 * or sent anything. Reads, without blocking, whatever is waiting: post-
 * handshake messages are taken (a session ticket is counted), and any
 * application data or close is reported. */
typedef enum { LM_TLS_IDLE = 0, LM_TLS_IDLE_EOF, LM_TLS_IDLE_CLOSE_NOTIFY, LM_TLS_IDLE_DATA, LM_TLS_IDLE_ERROR } lm_tls_idle;
lm_tls_idle lm_tls_check_idle(lm_tls_conn *c, int fd);

/* Sends close_notify (best effort, never waits for the peer's). */
void lm_tls_shutdown(lm_tls_conn *c);

/* After the handshake. */
const char *lm_tls_version(lm_tls_conn *c);
const char *lm_tls_cipher(lm_tls_conn *c);
const char *lm_tls_group(lm_tls_conn *c);
const char *lm_tls_peer_signature(lm_tls_conn *c);
void lm_tls_alpn(lm_tls_conn *c, char *out, size_t cap);
bool lm_tls_hello_retry(lm_tls_conn *c);
bool lm_tls_resumed(lm_tls_conn *c);
/* Sessions the server offered (the library's new-session callback), and of
 * those, how many came as a ticket (a NewSessionTicket message). Under TLS
 * 1.3 every session is a ticket; under TLS 1.2 a session may be offered by
 * its Session ID alone. */
unsigned lm_tls_sessions(lm_tls_conn *c);
unsigned lm_tls_tickets(lm_tls_conn *c);
/* The certificates the server sent, leaf first, exactly as sent, all of
 * them; also after a handshake that failed once the server's Certificate
 * message was read (so a refused chain can be recorded). */
size_t lm_tls_peer_chain_count(lm_tls_conn *c);
void lm_tls_peer_cert(lm_tls_conn *c, size_t i, const unsigned char **der, size_t *len);
/* Application data already decrypted and not yet read: bytes that arrived in
 * the same record as the last ones read. */
size_t lm_tls_pending(lm_tls_conn *c);
/* Why the last call failed, in the library's or the kernel's words. */
const char *lm_tls_error_detail(lm_tls_conn *c);
/* After LM_TLS_ALERT: the alert's description code (RFC 8446 6) and the
 * library's name for it; -1 and "" otherwise. */
int lm_tls_alert(lm_tls_conn *c);
const char *lm_tls_alert_name(lm_tls_conn *c);
/* The certificate verification result, "ok" or the library's words. */
const char *lm_tls_verify_result(lm_tls_conn *c);

#endif /* LEDGERMATH_LM_TLS_H */
