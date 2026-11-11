#ifndef LEDGERMATH_LM_DNS_H
#define LEDGERMATH_LM_DNS_H

/* A DNS query for one name's A records, and the parse of its reply, for the
 * C harness (RFC 1035). No I/O and no clock: the caller sends the query over
 * UDP and times it. Deliberately minimal: one question, class IN, type A, RD
 * set, no EDNS (so a reply is at most 512 bytes), and nothing done about a
 * reply beyond reading it: no retry, no TCP, no search list.
 *
 * The parse is split in two so the caller can time the first part alone.
 * lm_dns_parse() checks the whole message (every record of every section,
 * every name and pointer) and finds the address, keeping each record as
 * offsets into the message; it formats nothing. lm_dns_record_text() and
 * lm_dns_name_text() turn what it found into presentation form afterwards,
 * from the same message bytes.
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
    size_t owner_at;               /* where the owner name starts in the message */
    uint16_t type;
    uint16_t class_;
    uint32_t ttl;
    size_t rdata_at;
    uint16_t rdlength;
    uint32_t a;                    /* A: the address in network order */
} lm_dns_record;

typedef struct {
    uint16_t id;
    bool qr, aa, tc, rd, ra;
    unsigned opcode;
    unsigned rcode;
    unsigned qdcount, ancount, nscount, arcount;
    bool has_question;
    size_t qname_at;
    uint16_t qtype, qclass;
    unsigned answers;              /* records read from each section (at most LM_DNS_MAX_RECORDS) */
    lm_dns_record answer[LM_DNS_MAX_RECORDS];
    unsigned authorities;
    lm_dns_record authority[LM_DNS_MAX_RECORDS];
    unsigned additionals;
    lm_dns_record additional[LM_DNS_MAX_RECORDS];
    size_t end;                    /* where the last record ended (0 when the reply did not parse); bytes after it are in no record */
    /* The CNAME chain from the question's name, followed through the answer
     * section, and the first A record owned by its end. */
    size_t canonical_at;           /* where the chain's last name starts */
    unsigned chain;                /* CNAME records followed */
    bool has_address;
    uint32_t address;              /* network order */
} lm_dns_reply;

/* Parses a reply. Returns NULL when it is a well-formed message (whatever its
 * rcode, and even when its TC bit says it was truncated, as long as every
 * record it holds is whole), or a short reason it is not (cut short, a bad
 * compression pointer, more than LM_DNS_MAX_RECORDS records in a section).
 * The message must outlive `out`: the formatting below reads it again. */
const char *lm_dns_parse(const uint8_t *msg, size_t len, lm_dns_reply *out);

/* Whether the name at `at` (checked by lm_dns_parse) is `text`, ignoring
 * ASCII case and a trailing dot. */
bool lm_dns_name_is(const uint8_t *msg, size_t len, size_t at, const char *text);

/* The name at `at` in presentation form, with the trailing dot, into out
 * (LM_DNS_NAME_MAX bytes). */
void lm_dns_name_text(const uint8_t *msg, size_t len, size_t at, char *out);

/* A record as one line, "<owner> <ttl> [CLASS<n> ]<TYPE> <data>": A as a
 * dotted quad, AAAA as RFC 5952, CNAME, NS and PTR as a name, SOA as its two
 * names and five numbers, anything else in RFC 3597's \# form. Returns a
 * string the caller frees. */
char *lm_dns_record_text(const uint8_t *msg, size_t len, const lm_dns_record *rec);

#endif /* LEDGERMATH_LM_DNS_H */
