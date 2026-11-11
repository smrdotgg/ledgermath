#include "lm_dns.h"

#include "lm.h"

#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
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

/* Checks a possibly compressed name at `at`, formatting nothing. Returns the
 * offset just past the name where it began (pointers are followed, but the
 * reader continues after the first one), or 0 with r->error set. Every
 * pointer must point before the label that holds it, so a loop is
 * impossible. */
static size_t check_name(reader *r, size_t at) {
    size_t after = 0;
    size_t total = 0;
    size_t lowest = at; /* a pointer must point below every label read so far */
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
        if (at < lowest) lowest = at;
        at += 1 + length;
    }
}

/* The labels of a name, one at a time. For a name lm_dns_parse checked, the
 * walk is that check's walk; for any other bytes it still ends, after at most
 * WALK_STEPS labels and pointers (a checked name in a reply of at most 64 KiB
 * takes fewer). */
#define WALK_STEPS (65536 + 256)
typedef struct {
    const uint8_t *msg;
    size_t len;
    size_t at;
    unsigned steps;
} walker;

/* Returns the next label's length and sets *label, or 0 at the end of the name. */
static size_t next_label(walker *w, const uint8_t **label) {
    while (w->steps < WALK_STEPS && w->at < w->len) {
        w->steps++;
        uint8_t length = w->msg[w->at];
        if ((length & 0xc0) == 0xc0) {
            if (w->at + 1 >= w->len) return 0;
            w->at = ((size_t)(length & 0x3f) << 8) | w->msg[w->at + 1];
            continue;
        }
        if (length == 0 || (length & 0xc0) != 0 || w->at + 1 + length > w->len) return 0;
        *label = w->msg + w->at + 1;
        w->at += 1 + length;
        return length;
    }
    return 0;
}

static unsigned char lower(unsigned char c) { return (c >= 'A' && c <= 'Z') ? (unsigned char)(c + 32) : c; }

static bool names_equal(const uint8_t *msg, size_t len, size_t a, size_t b) {
    walker wa = { msg, len, a, 0 }, wb = { msg, len, b, 0 };
    for (;;) {
        const uint8_t *la = NULL, *lb = NULL;
        size_t na = next_label(&wa, &la), nb = next_label(&wb, &lb);
        if (na != nb) return false;
        if (na == 0) return true;
        for (size_t i = 0; i < na; i++) {
            if (lower(la[i]) != lower(lb[i])) return false;
        }
    }
}

bool lm_dns_name_is(const uint8_t *msg, size_t len, size_t at, const char *text) {
    size_t tl = strlen(text);
    if (tl > 1 && text[tl - 1] == '.') tl--;
    size_t t = 0;
    walker w = { msg, len, at, 0 };
    for (;;) {
        const uint8_t *label = NULL;
        size_t n = next_label(&w, &label);
        if (n == 0) return t >= tl || (tl == 1 && text[0] == '.');
        if (t > 0) {
            if (t >= tl || text[t] != '.') return false;
            t++;
        }
        if (tl - t < n) return false;
        for (size_t i = 0; i < n; i++) {
            /* A dot inside a label is not the dot between two labels. */
            if (label[i] == '.' || lower(label[i]) != lower((unsigned char)text[t + i])) return false;
        }
        t += n;
    }
}

static void append(char *out, size_t *o, const char *text) {
    size_t n = strlen(text);
    if (*o + n >= LM_DNS_NAME_MAX) n = LM_DNS_NAME_MAX - 1 - *o;
    memcpy(out + *o, text, n);
    *o += n;
    out[*o] = '\0';
}

void lm_dns_name_text(const uint8_t *msg, size_t len, size_t at, char *out) {
    size_t o = 0;
    out[0] = '\0';
    const uint8_t *label = NULL;
    size_t n;
    walker w = { msg, len, at, 0 };
    while ((n = next_label(&w, &label)) > 0) {
        for (size_t i = 0; i < n; i++) {
            unsigned char c = label[i];
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
    }
    if (o == 0) append(out, &o, ".");
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
    case 41: return "OPT";
    default: snprintf(scratch, size, "TYPE%u", type); return scratch;
    }
}

/* Checks one record and keeps where its parts are. */
static bool read_record(reader *r, lm_dns_record *rec) {
    rec->owner_at = r->at;
    size_t next = check_name(r, r->at);
    if (next == 0) return false;
    r->at = next;
    rec->type = u16(r);
    rec->class_ = u16(r);
    rec->ttl = u32(r);
    rec->rdlength = u16(r);
    if (!need(r, rec->rdlength)) return false;
    rec->rdata_at = r->at;
    size_t rdata = r->at, end = rdata + rec->rdlength;
    rec->a = 0;
    if (rec->type == LM_DNS_TYPE_A && rec->rdlength == 4) {
        memcpy(&rec->a, r->msg + rdata, 4);
    } else if (rec->type == LM_DNS_TYPE_CNAME || rec->type == 2 || rec->type == 12) {
        reader inner = *r;
        inner.len = end; /* the name may point anywhere before, but not past its rdata */
        size_t after = check_name(&inner, rdata);
        if (after == 0) {
            r->error = inner.error;
            return false;
        }
        if (after != end) {
            r->error = "a record's name does not fill its rdata";
            return false;
        }
    } else if (rec->type == 6) {
        /* SOA: MNAME RNAME SERIAL REFRESH RETRY EXPIRE MINIMUM (RFC 1035 3.3.13). */
        reader inner = *r;
        inner.len = end;
        size_t at = check_name(&inner, rdata);
        if (at != 0) at = check_name(&inner, at);
        if (at == 0 || at + 20 != end) {
            r->error = inner.error != NULL ? inner.error : "an SOA record's data is not two names and five numbers";
            return false;
        }
    }
    r->at = end;
    return r->error == NULL;
}

static const char *read_section(reader *r, unsigned count, lm_dns_record *records, unsigned *kept, const char *too_many) {
    if (count > LM_DNS_MAX_RECORDS) return too_many;
    for (unsigned i = 0; i < count; i++) {
        if (!read_record(r, &records[i])) return r->error;
        (*kept)++;
    }
    return NULL;
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
        out->qname_at = r.at;
        size_t next = check_name(&r, r.at);
        if (next == 0) return r.error;
        r.at = next;
        out->qtype = u16(&r);
        out->qclass = u16(&r);
        if (r.error != NULL) return r.error;
        out->has_question = true;
    }
    const char *why = read_section(&r, out->ancount, out->answer, &out->answers, "the reply has more answers than this parser keeps");
    if (why == NULL) why = read_section(&r, out->nscount, out->authority, &out->authorities, "the reply has more authority records than this parser keeps");
    if (why == NULL) why = read_section(&r, out->arcount, out->additional, &out->additionals, "the reply has more additional records than this parser keeps");
    if (why != NULL) return why;
    out->end = r.at;

    /* The CNAME chain from the question's name, then its first A record. */
    if (!out->has_question) return NULL;
    out->canonical_at = out->qname_at;
    for (unsigned hop = 0; hop <= out->answers; hop++) {
        bool moved = false;
        for (unsigned i = 0; i < out->answers; i++) {
            const lm_dns_record *rec = &out->answer[i];
            if (rec->type == LM_DNS_TYPE_CNAME && rec->class_ == 1 && names_equal(msg, len, rec->owner_at, out->canonical_at)) {
                out->canonical_at = rec->rdata_at;
                out->chain++;
                moved = true;
                break;
            }
        }
        if (!moved) break;
    }
    for (unsigned i = 0; i < out->answers; i++) {
        const lm_dns_record *rec = &out->answer[i];
        if (rec->type == LM_DNS_TYPE_A && rec->class_ == 1 && rec->rdlength == 4 && names_equal(msg, len, rec->owner_at, out->canonical_at)) {
            out->has_address = true;
            out->address = rec->a;
            break;
        }
    }
    return NULL;
}

/* ---- presentation form, after the request ---- */

char *lm_dns_record_text(const uint8_t *msg, size_t len, const lm_dns_record *rec) {
    /* The longest line: two names, an SOA's two more names, or 2 hex digits per rdata byte. */
    size_t cap = 4 * LM_DNS_NAME_MAX + 2 * (size_t)rec->rdlength + 128;
    char *out = malloc(cap);
    char *data = malloc(cap);
    if (out == NULL || data == NULL) lm_die("lm_dns: out of memory");
    const uint8_t *rd = msg + rec->rdata_at;
    data[0] = '\0';
    if (rec->type == LM_DNS_TYPE_A && rec->rdlength == 4) {
        inet_ntop(AF_INET, rd, data, (socklen_t)cap);
    } else if (rec->type == 28 && rec->rdlength == 16) {
        inet_ntop(AF_INET6, rd, data, (socklen_t)cap);
    } else if (rec->type == LM_DNS_TYPE_CNAME || rec->type == 2 || rec->type == 12) {
        lm_dns_name_text(msg, rec->rdata_at + rec->rdlength, rec->rdata_at, data);
    } else if (rec->type == 6) {
        reader inner = { msg, rec->rdata_at + rec->rdlength, rec->rdata_at, NULL };
        char mname[LM_DNS_NAME_MAX], rname[LM_DNS_NAME_MAX];
        size_t at = check_name(&inner, rec->rdata_at);
        lm_dns_name_text(msg, inner.len, rec->rdata_at, mname);
        size_t at2 = check_name(&inner, at);
        lm_dns_name_text(msg, inner.len, at, rname);
        inner.at = at2;
        uint32_t serial = u32(&inner), refresh = u32(&inner), retry = u32(&inner), expire = u32(&inner), minimum = u32(&inner);
        snprintf(data, cap, "%s %s %u %u %u %u %u", mname, rname, serial, refresh, retry, expire, minimum);
    } else {
        /* RFC 3597's form for data this parser does not interpret, every byte of it. */
        size_t o = (size_t)snprintf(data, cap, "\\# %u", rec->rdlength);
        if (rec->rdlength > 0) data[o++] = ' ';
        for (size_t i = 0; i < rec->rdlength; i++) o += (size_t)snprintf(data + o, cap - o, "%02x", rd[i]);
        data[o] = '\0';
    }
    char owner[LM_DNS_NAME_MAX];
    lm_dns_name_text(msg, len, rec->owner_at, owner);
    char scratch[16];
    char klass[24] = "";
    if (rec->class_ != 1) snprintf(klass, sizeof(klass), "CLASS%u ", rec->class_);
    snprintf(out, cap, "%s %u %s%s %s", owner, rec->ttl, klass, type_name(rec->type, scratch, sizeof(scratch)), data);
    free(data);
    return out;
}
