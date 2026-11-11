#ifndef LEDGERMATH_LM_DNS_H
#define LEDGERMATH_LM_DNS_H

/* A DNS query for one name's A records, and the parse of its reply, for the
 * C harness (RFC 1035). No I/O and no clock: the caller sends the query over
 * UDP and times it. Deliberately minimal: one question, class IN, type A, RD
 * set, no EDNS (so a reply is at most 512 bytes), and nothing done about a
 * reply beyond reading it: no retry, no TCP, no search list.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define LM_DNS_MAX_RECORDS 32
#define LM_DNS_NAME_MAX 1024   /* a name in presentation form, escapes included */
#define LM_DNS_TYPE_A 1
#define LM_DNS_TYPE_CNAME 5

/* Writes a query for `name` (a host name, with or without a trailing dot)
 * into out, with ID `id`. Returns its length, or 0 when the name cannot be
 * put in a query (an empty label, a label over 63 bytes, a name over 255) or
 * out is too small. */
size_t lm_dns_query(uint8_t *out, size_t cap, uint16_t id, const char *name);

typedef struct {
    char owner[LM_DNS_NAME_MAX];   /* presentation form, with the trailing dot */
    uint16_t type;
    uint16_t class_;
    uint32_t ttl;
    char data[LM_DNS_NAME_MAX];    /* A: dotted quad; CNAME, NS, PTR: a name; AAAA: RFC 5952; others: RFC 3597 \# form */
    uint32_t a;                    /* A: the address in network order */
    char text[LM_DNS_NAME_MAX * 2 + 64]; /* the record as one line: "<owner> <ttl> <TYPE> <data>" */
} lm_dns_record;

typedef struct {
    uint16_t id;
    bool qr, aa, tc, rd, ra;
    unsigned opcode;
    unsigned rcode;
    unsigned qdcount, ancount, nscount, arcount;
    char qname[LM_DNS_NAME_MAX];
    uint16_t qtype, qclass;
    unsigned answers;              /* records read from the answer section (at most LM_DNS_MAX_RECORDS) */
    lm_dns_record answer[LM_DNS_MAX_RECORDS];
    unsigned authorities;          /* records read from the authority section */
    lm_dns_record authority[LM_DNS_MAX_RECORDS];
    /* The CNAME chain from the question's name, followed through the answer
     * section, and the first A record owned by its end. */
    char canonical[LM_DNS_NAME_MAX];
    unsigned chain;                /* CNAME records followed */
    bool has_address;
    uint32_t address;              /* network order */
} lm_dns_reply;

/* Parses a reply. Returns NULL when it is a well-formed message (whatever its
 * rcode, and even when its TC bit says it was truncated, as long as every
 * record it holds is whole), or a short reason it is not (cut short, a bad
 * compression pointer, more than LM_DNS_MAX_RECORDS records in a section). */
const char *lm_dns_parse(const uint8_t *msg, size_t len, lm_dns_reply *out);

/* Compares two names in presentation form, ignoring ASCII case and a trailing dot. */
bool lm_dns_same_name(const char *a, const char *b);

#endif /* LEDGERMATH_LM_DNS_H */
