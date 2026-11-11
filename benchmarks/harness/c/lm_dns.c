#include "lm_dns.h"

#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>

size_t lm_dns_query(uint8_t *out, size_t cap, uint16_t id, const char *name) {
    size_t name_len = strlen(name);
    if (name_len > 0 && name[name_len - 1] == '.') name_len--;
    if (name_len == 0 || name_len > 253) return 0;
    size_t need = 12 + name_len + 2 + 4;
    if (cap < need) return 0;
    out[0] = (uint8_t)(id >> 8);
    out[1] = (uint8_t)id;
    out[2] = 0x01;                     /* QR 0, opcode 0, AA 0, TC 0, RD 1 */
    out[3] = 0x00;                     /* RA 0, Z 0, rcode 0 */
    out[4] = 0; out[5] = 1;            /* one question */
    memset(out + 6, 0, 6);             /* no answers, authorities or additional records: no EDNS */
    size_t o = 12;
    size_t start = 0;
    while (start <= name_len) {
        size_t end = start;
        while (end < name_len && name[end] != '.') end++;
        size_t label = end - start;
        if (label == 0 || label > 63) return 0;
        out[o++] = (uint8_t)label;
        memcpy(out + o, name + start, label);
        o += label;
        start = end + 1;
    }
    out[o++] = 0;
    out[o++] = 0; out[o++] = LM_DNS_TYPE_A;
    out[o++] = 0; out[o++] = 1;        /* class IN */
    return o;
}

/* ---- reading ---- */

typedef struct {
    const uint8_t *msg;
    size_t len;
    size_t at;
    const char *error;
} reader;

static bool need(reader *r, size_t n) {
    if (r->error != NULL) return false;
    if (r->at > r->len || r->len - r->at < n) {
        r->error = "the reply is cut short";
        return false;
    }
    return true;
}

static uint16_t u16(reader *r) {
    if (!need(r, 2)) return 0;
    uint16_t v = (uint16_t)((r->msg[r->at] << 8) | r->msg[r->at + 1]);
    r->at += 2;
    return v;
}

static uint32_t u32(reader *r) {
    uint32_t hi = u16(r);
    uint32_t lo = u16(r);
    return (hi << 16) | lo;
}

static void append(char *out, size_t *o, const char *text) {
    size_t n = strlen(text);
    if (*o + n >= LM_DNS_NAME_MAX) n = LM_DNS_NAME_MAX - 1 - *o;
    memcpy(out + *o, text, n);
    *o += n;
    out[*o] = '\0';
}

/* Reads a possibly compressed name at `at` into presentation form. Returns
 * the offset just past the name where it began (pointers are followed, but
 * the reader continues after the first one), or 0 with r->error set. Every
 * pointer must point before the label that holds it, so a loop is impossible. */
static size_t read_name(reader *r, size_t at, char *out) {
    size_t o = 0;
    size_t after = 0;
    size_t total = 0;
    size_t lowest = at; /* a pointer must point below every label read so far */
    out[0] = '\0';
    for (;;) {
        if (at >= r->len) {
            r->error = "a name runs past the end of the reply";
            return 0;
        }
        uint8_t length = r->msg[at];
        if ((length & 0xc0) == 0xc0) {
            if (at + 1 >= r->len) {
                r->error = "a compression pointer runs past the end of the reply";
                return 0;
            }
            size_t target = ((size_t)(length & 0x3f) << 8) | r->msg[at + 1];
            if (after == 0) after = at + 2;
            if (target >= lowest) {
                r->error = "a compression pointer does not point backwards";
                return 0;
            }
            lowest = target;
            at = target;
            continue;
        }
        if ((length & 0xc0) != 0) {
            r->error = "a label has an unknown type";
            return 0;
        }
        if (length == 0) {
            if (after == 0) after = at + 1;
            if (o == 0) append(out, &o, ".");
            return after;
        }
        if (at + 1 + length > r->len) {
            r->error = "a label runs past the end of the reply";
            return 0;
        }
        total += length + 1;
        if (total > 255) {
            r->error = "a name is longer than 255 bytes";
            return 0;
        }
        for (size_t i = 0; i < length; i++) {
            unsigned char c = r->msg[at + 1 + i];
            char piece[8];
            if (c == '.' || c == '\\' || c == '"' || c == '(' || c == ')' || c == ';' || c == '@' || c == '$') {
                piece[0] = '\\';
                piece[1] = (char)c;
                piece[2] = '\0';
            } else if (c > 0x20 && c < 0x7f) {
                piece[0] = (char)c;
                piece[1] = '\0';
            } else {
                snprintf(piece, sizeof(piece), "\\%03u", c);
            }
            append(out, &o, piece);
        }
        append(out, &o, ".");
        if (at < lowest) lowest = at;
        at += 1 + length;
    }
}

static const char *type_name(uint16_t type, char *scratch, size_t size) {
    switch (type) {
    case 1: return "A";
    case 2: return "NS";
    case 5: return "CNAME";
    case 6: return "SOA";
    case 12: return "PTR";
    case 15: return "MX";
    case 16: return "TXT";
    case 28: return "AAAA";
    default: snprintf(scratch, size, "TYPE%u", type); return scratch;
    }
}

static bool read_record(reader *r, lm_dns_record *rec) {
    size_t next = read_name(r, r->at, rec->owner);
    if (next == 0) return false;
    r->at = next;
    rec->type = u16(r);
    rec->class_ = u16(r);
    rec->ttl = u32(r);
    uint16_t rdlength = u16(r);
    if (!need(r, rdlength)) return false;
    size_t rdata = r->at;
    rec->a = 0;
    rec->data[0] = '\0';
    if (rec->type == LM_DNS_TYPE_A && rdlength == 4) {
        memcpy(&rec->a, r->msg + rdata, 4);
        inet_ntop(AF_INET, r->msg + rdata, rec->data, sizeof(rec->data));
    } else if (rec->type == 28 && rdlength == 16) {
        inet_ntop(AF_INET6, r->msg + rdata, rec->data, sizeof(rec->data));
    } else if (rec->type == LM_DNS_TYPE_CNAME || rec->type == 2 || rec->type == 12) {
        reader inner = *r;
        inner.len = rdata + rdlength; /* the name may point anywhere before, but not past its rdata */
        size_t end = read_name(&inner, rdata, rec->data);
        if (end == 0) {
            r->error = inner.error;
            return false;
        }
        if (end != rdata + rdlength) {
            r->error = "a record's name does not fill its rdata";
            return false;
        }
    } else if (rec->type == 6) {
        /* SOA: MNAME RNAME SERIAL REFRESH RETRY EXPIRE MINIMUM (RFC 1035 3.3.13). */
        reader inner = *r;
        inner.len = rdata + rdlength;
        char mname[LM_DNS_NAME_MAX], rname[LM_DNS_NAME_MAX];
        size_t at = read_name(&inner, rdata, mname);
        if (at != 0) at = read_name(&inner, at, rname);
        if (at == 0 || at + 20 != rdata + rdlength) {
            r->error = inner.error != NULL ? inner.error : "an SOA record's data is not two names and five numbers";
            return false;
        }
        inner.at = at;
        uint32_t serial = u32(&inner), refresh = u32(&inner), retry = u32(&inner), expire = u32(&inner), minimum = u32(&inner);
        snprintf(rec->data, sizeof(rec->data), "%.400s %.400s %u %u %u %u %u", mname, rname, serial, refresh, retry, expire, minimum);
    } else {
        /* RFC 3597's form for data this parser does not interpret. */
        size_t o = (size_t)snprintf(rec->data, sizeof(rec->data), "\\# %u", rdlength);
        if (rdlength > 0) rec->data[o++] = ' ';
        for (size_t i = 0; i < rdlength && o + 3 < sizeof(rec->data); i++) {
            o += (size_t)snprintf(rec->data + o, sizeof(rec->data) - o, "%02x", r->msg[rdata + i]);
        }
    }
    r->at = rdata + rdlength;
    char scratch[16];
    char klass[24] = "";
    if (rec->class_ != 1) snprintf(klass, sizeof(klass), "CLASS%u ", rec->class_);
    snprintf(rec->text, sizeof(rec->text), "%s %u %s%s %s", rec->owner, rec->ttl, klass, type_name(rec->type, scratch, sizeof(scratch)), rec->data);
    return r->error == NULL;
}

bool lm_dns_same_name(const char *a, const char *b) {
    size_t la = strlen(a), lb = strlen(b);
    if (la > 1 && a[la - 1] == '.') la--;
    if (lb > 1 && b[lb - 1] == '.') lb--;
    if (la != lb) return false;
    for (size_t i = 0; i < la; i++) {
        char x = a[i], y = b[i];
        if (x >= 'A' && x <= 'Z') x = (char)(x + 32);
        if (y >= 'A' && y <= 'Z') y = (char)(y + 32);
        if (x != y) return false;
    }
    return true;
}

const char *lm_dns_parse(const uint8_t *msg, size_t len, lm_dns_reply *out) {
    memset(out, 0, sizeof(*out));
    reader r = { msg, len, 0, NULL };
    if (len < 12) return "the reply is shorter than a DNS header";
    out->id = u16(&r);
    uint16_t flags = u16(&r);
    out->qr = (flags >> 15) & 1;
    out->opcode = (flags >> 11) & 15;
    out->aa = (flags >> 10) & 1;
    out->tc = (flags >> 9) & 1;
    out->rd = (flags >> 8) & 1;
    out->ra = (flags >> 7) & 1;
    out->rcode = flags & 15;
    out->qdcount = u16(&r);
    out->ancount = u16(&r);
    out->nscount = u16(&r);
    out->arcount = u16(&r);
    if (out->qdcount > 1) return "the reply has more than one question";
    if (out->qdcount == 1) {
        size_t next = read_name(&r, r.at, out->qname);
        if (next == 0) return r.error;
        r.at = next;
        out->qtype = u16(&r);
        out->qclass = u16(&r);
        if (r.error != NULL) return r.error;
    }
    if (out->ancount > LM_DNS_MAX_RECORDS) return "the reply has more answers than this parser keeps";
    for (unsigned i = 0; i < out->ancount; i++) {
        if (!read_record(&r, &out->answer[i])) return r.error;
        out->answers++;
    }
    if (out->nscount > LM_DNS_MAX_RECORDS) return "the reply has more authority records than this parser keeps";
    for (unsigned i = 0; i < out->nscount; i++) {
        if (!read_record(&r, &out->authority[i])) return r.error;
        out->authorities++;
    }
    /* The additional section is counted (arcount) and not read: with no EDNS
     * in the query, a reply has no reason to carry one. */

    /* The CNAME chain from the question's name, then its first A record. */
    snprintf(out->canonical, sizeof(out->canonical), "%s", out->qname);
    for (unsigned hop = 0; hop <= out->answers; hop++) {
        bool moved = false;
        for (unsigned i = 0; i < out->answers; i++) {
            const lm_dns_record *rec = &out->answer[i];
            if (rec->type == LM_DNS_TYPE_CNAME && rec->class_ == 1 && lm_dns_same_name(rec->owner, out->canonical)) {
                snprintf(out->canonical, sizeof(out->canonical), "%s", rec->data);
                out->chain++;
                moved = true;
                break;
            }
        }
        if (!moved) break;
    }
    for (unsigned i = 0; i < out->answers; i++) {
        const lm_dns_record *rec = &out->answer[i];
        if (rec->type == LM_DNS_TYPE_A && rec->class_ == 1 && lm_dns_same_name(rec->owner, out->canonical)) {
            out->has_address = true;
            out->address = rec->a;
            break;
        }
    }
    return NULL;
}
