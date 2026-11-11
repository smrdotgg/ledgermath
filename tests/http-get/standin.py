#!/usr/bin/env python3
"""A local stand-in for S3 and the VPC resolver, so http_get runs end to end
with no network and no credentials (tests/http-get.test.ts,
scripts/check-scratch.py).

    python3 -I tests/http-get/standin.py DIR [--bind ADDRESS]

At start it makes a throwaway certificate authority with the openssl command
(DIR/ca.pem, the CA bundle the binary is given), a server certificate for
*.s3.lm.test signed by it, a second CA and a certificate signed by that one
(for "badcert"), and one for another name ("wrongname"). It then listens on
ADDRESS (127.0.0.1 by default), on a UDP port for DNS and a TCP port for
HTTPS, both chosen by the kernel, prints one JSON line naming them, and serves
until it is killed or its stdin closes.

The first label of the name asked for chooses the behaviour, for DNS and for
HTTPS alike: <scenario>.s3.lm.test. A name in "mixed-..." walks a sequence of
behaviours, one per request. Every request it reads is appended to
DIR/requests.ndjson (its request line and headers, verbatim), so a test can
check what the binary sent, its signature included.

DNS answers as S3's does: a CNAME to s3-r-w.lm.test with TTL 300, then A
records with TTL 5, the first of them the stand-in's own address, using name
compression. Scenarios: nxdomain (rcode 3, an SOA in the authority section),
truncated (TC set, no answers), dnsdrop (no reply), refused (the first A
record is an address where nothing listens).

HTTPS: an object key ending in a number N is the Fixture of N bytes
(benchmarks/harness/c/lm_fixture.h's pattern), with S3's headers and a correct
x-amz-checksum-sha256. Scenarios: ok, forbidden (403 AccessDenied, chunked
XML), slowdown (503 SlowDown, chunked XML), echo (403 SignatureDoesNotMatch
echoing the access key ID, the signature and a canonical request holding the
session token, as S3 does), accountid (403 whose message names an account),
reset (half the body, then RST), stall (half the body, then silence for
three seconds), short (half the body, then close_notify and FIN), shortfin
(half the body, then FIN without close_notify), badsum (a wrong
x-amz-checksum-sha256), nosum (none), wrongbody (other bytes of the right
length, with their own correct checksum), slow (the first byte 300 ms late),
close (Connection: close on every response), idleclose (the connection closed
10 ms after each response), bigheaders (a header block over 64 KiB), folded
(obsolete line folding), chunked (the Fixture, chunked), badcert, wrongname.
"""

import base64
import datetime
import hashlib
import json
import os
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time

MASK = (1 << 64) - 1
SEED = 0x8D6D2F9D5F9D1B37
DOMAIN = "s3.lm.test"
CANONICAL = "s3-r-w.lm.test"
MIXED = ["ok", "ok", "forbidden", "ok", "slowdown", "ok", "reset", "ok", "short", "ok", "stall", "ok"]


def mix64(x):
    x ^= x >> 30
    x = (x * 0xBF58476D1CE4E5B9) & MASK
    x ^= x >> 27
    x = (x * 0x94D049BB133111EB) & MASK
    x ^= x >> 31
    return x


_fixtures = {}
_fixtures_lock = threading.Lock()


def fixture(size):
    """The first `size` bytes of the Fixture: the 64-bit little-endian word at offset o is mix64(o ^ SEED)."""
    with _fixtures_lock:
        if size not in _fixtures:
            words = (size + 7) // 8
            data = bytearray(words * 8)
            for i in range(words):
                struct.pack_into("<Q", data, i * 8, mix64((i * 8) ^ SEED))
            _fixtures[size] = bytes(data[:size])
        return _fixtures[size]


# ---- certificates ----

def openssl(*arguments):
    subprocess.run(["openssl"] + list(arguments), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def make_ca(directory, name):
    key, cert = os.path.join(directory, name + ".key"), os.path.join(directory, name + ".pem")
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", cert,
            "-days", "2", "-subj", "/CN=LedgerMath stand-in " + name, "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    return key, cert


def make_leaf(directory, name, ca_key, ca_cert, dns_name):
    key, csr, cert = (os.path.join(directory, name + suffix) for suffix in (".key", ".csr", ".pem"))
    extensions = os.path.join(directory, name + ".ext")
    with open(extensions, "w", encoding="ascii") as handle:
        handle.write("subjectAltName=DNS:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n"
                     "extendedKeyUsage=serverAuth\n" % dns_name)
    openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", csr,
            "-subj", "/CN=" + dns_name)
    openssl("x509", "-req", "-in", csr, "-CA", ca_cert, "-CAkey", ca_key, "-CAcreateserial", "-out", cert, "-days", "2",
            "-extfile", extensions)
    # The chain as a server sends it: the leaf, then the CA.
    with open(cert, "a", encoding="ascii") as out, open(ca_cert, encoding="ascii") as ca:
        out.write(ca.read())
    return key, cert


def contexts(directory):
    ca_key, ca_cert = make_ca(directory, "ca")
    other_key, other_cert = make_ca(directory, "other-ca")
    made = {}
    for name, (signing_key, signing_cert, dns_name) in {
        "good": (ca_key, ca_cert, "*." + DOMAIN),
        "badcert": (other_key, other_cert, "*." + DOMAIN),
        "wrongname": (ca_key, ca_cert, "*.elsewhere.lm.test"),
    }.items():
        key, cert = make_leaf(directory, name, signing_key, signing_cert, dns_name)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        context.set_alpn_protocols(["http/1.1"])
        made[name] = context

    def choose(sock, server_name, context):
        scenario = scenario_of(server_name or "")
        if scenario in ("badcert", "wrongname"):
            sock.context = made[scenario]
        return None

    made["good"].sni_callback = choose
    return made["good"], ca_cert


# ---- scenarios ----

_counters = {}
_counters_lock = threading.Lock()


def scenario_of(name):
    label = name.rstrip(".").split(".")[0].lower()
    return label


def behaviour(host):
    """The behaviour for the next request to `host`, and the request's number for that host."""
    scenario = scenario_of(host.split(":")[0])
    with _counters_lock:
        number = _counters.get(host, 0)
        _counters[host] = number + 1
    if scenario.startswith("mixed"):
        return MIXED[number % len(MIXED)], number
    return scenario, number


# ---- DNS ----

def read_name(message, at):
    labels = []
    while True:
        length = message[at]
        if length == 0:
            return ".".join(labels), at + 1
        labels.append(message[at + 1:at + 1 + length].decode("ascii", "replace"))
        at += 1 + length


def encode_name(name):
    out = b""
    for label in name.rstrip(".").split("."):
        out += bytes([len(label)]) + label.encode("ascii")
    return out + b"\x00"


def dns_reply(query, own_address):
    ident, flags = struct.unpack("!HH", query[:4])
    qname, after = read_name(query, 12)
    question = query[12:after + 4]
    scenario = scenario_of(qname)
    if scenario == "dnsdrop":
        return None
    rd = flags & 0x0100
    header = lambda rcode, tc, an, ns: struct.pack("!HHHHHH", ident, 0x8080 | rd | (0x0200 if tc else 0) | rcode, 1, an, ns, 0)
    if scenario == "nxdomain":
        soa = encode_name("lm.test") + struct.pack("!HHIH", 6, 1, 60, 0)
        rdata = encode_name("ns.lm.test") + encode_name("hostmaster.lm.test") + struct.pack("!IIIII", 1, 7200, 900, 1209600, 60)
        soa = soa[:-2] + struct.pack("!H", len(rdata)) + rdata
        return header(3, False, 0, 1) + question + soa
    if scenario == "truncated":
        return header(0, True, 0, 0) + question
    first = "127.0.0.2" if scenario == "refused" else own_address
    # A CNAME owned by the question's name (a pointer to offset 12), then A records owned by its target.
    target = encode_name(CANONICAL)
    answers = b"\xc0\x0c" + struct.pack("!HHIH", 5, 1, 300, len(target)) + target
    target_offset = 12 + len(question) + 12
    for address in (first, "127.0.0.3", "127.0.0.4"):
        answers += struct.pack("!HHHIH", 0xC000 | target_offset, 1, 1, 5, 4) + socket.inet_aton(address)
    return header(0, False, 4, 0) + question + answers


def serve_dns(sock, own_address):
    while True:
        try:
            query, peer = sock.recvfrom(512)
            reply = dns_reply(query, own_address)
            if reply is not None:
                sock.sendto(reply, peer)
        except Exception as error:  # a malformed query must not stop the responder
            print("standin: dns: %r" % error, file=sys.stderr, flush=True)


# ---- HTTPS ----

_log_lock = threading.Lock()


def log_request(path, record):
    with _log_lock, open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")


def read_request(conn, buffered):
    while b"\r\n\r\n" not in buffered:
        data = conn.recv(65536)
        if not data:
            return None, b""
        buffered += data
    head, rest = buffered.split(b"\r\n\r\n", 1)
    lines = head.decode("latin-1").split("\r\n")
    method, target, version = lines[0].split(" ", 2)
    headers = [line.split(":", 1) for line in lines[1:]]
    headers = [[name, value.strip()] for name, value in headers]
    return {"method": method, "target": target, "version": version, "headers": headers}, rest


def header(request, name):
    for key, value in request["headers"]:
        if key.lower() == name:
            return value
    return None


def chunked(body):
    out = b""
    for start in range(0, len(body), 100):
        piece = body[start:start + 100]
        out += b"%x\r\n" % len(piece) + piece + b"\r\n"
    return out + b"0\r\n\r\n"


def http_date():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")


def error_response(status, reason, code, message, request_id, extra=""):
    body = ('<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>%s</Code><Message>%s</Message>%s<RequestId>%s</RequestId>'
            "<HostId>c3RhbmQtaW4gaG9zdCBpZA==</HostId></Error>" % (code, message, extra, request_id)).encode("utf-8")
    head = ("HTTP/1.1 %d %s\r\nx-amz-request-id: %s\r\nx-amz-id-2: c3RhbmQtaW4gaG9zdCBpZA==\r\nContent-Type: application/xml\r\n"
            "Transfer-Encoding: chunked\r\nDate: %s\r\nServer: ledgermath-standin\r\n\r\n" % (status, reason, request_id, http_date()))
    return head.encode("ascii") + chunked(body)


def object_head(size, checksum, request_id, extra=b""):
    return (b"HTTP/1.1 200 OK\r\nx-amz-id-2: c3RhbmQtaW4gaG9zdCBpZA==\r\nx-amz-request-id: " + request_id.encode() +
            b"\r\nDate: " + http_date().encode() + b"\r\nLast-Modified: Thu, 12 Nov 2026 10:00:00 GMT\r\n"
            b"ETag: \"0123456789abcdef0123456789abcdef\"\r\nx-amz-server-side-encryption: AES256\r\n" +
            (b"x-amz-checksum-sha256: " + checksum + b"\r\nx-amz-checksum-type: FULL_OBJECT\r\n" if checksum else b"") +
            b"Accept-Ranges: bytes\r\nContent-Type: application/octet-stream\r\n" + extra +
            (b"" if b"Transfer-Encoding" in extra else b"Content-Length: %d\r\n" % size) + b"Server: ledgermath-standin\r\n\r\n")


def respond(conn, request, log_path):
    host = header(request, "host") or ""
    what, number = behaviour(host)
    request_id = "STANDIN%09d" % number
    log_request(log_path, dict(request, scenario=what, number=number))
    key = request["target"].rsplit("/", 1)[-1]
    size = int(key) if key.isdigit() else 0
    body = fixture(size)
    checksum = base64.b64encode(hashlib.sha256(body).digest())

    if what == "forbidden":
        conn.sendall(error_response(403, "Forbidden", "AccessDenied", "Access Denied", request_id))
        return True
    if what == "slowdown":
        conn.sendall(error_response(503, "Slow Down", "SlowDown", "Please reduce your request rate.", request_id))
        return True
    if what == "accountid":
        conn.sendall(error_response(403, "Forbidden", "AccessDenied", "User: arn:aws:sts::123456789012:assumed-role/reader/session "
                                    "is not authorized to perform: s3:GetObject", request_id))
        return True
    if what == "echo":
        authorization = header(request, "authorization") or ""
        key_id = authorization.split("Credential=", 1)[-1].split("/", 1)[0]
        signature = authorization.rsplit("Signature=", 1)[-1]
        token = header(request, "x-amz-security-token") or ""
        canonical = "GET\n%s\n\nhost:%s\nx-amz-security-token:%s\n" % (request["target"], host, token)
        extra = ("<AWSAccessKeyId>%s</AWSAccessKeyId><StringToSign>AWS4-HMAC-SHA256</StringToSign><SignatureProvided>%s"
                 "</SignatureProvided><CanonicalRequest>%s</CanonicalRequest>" % (key_id, signature, canonical))
        conn.sendall(error_response(403, "Forbidden", "SignatureDoesNotMatch", "The request signature we calculated does not match "
                                    "the signature you provided. Check your key and signing method.", request_id, extra))
        return True
    if what == "bigheaders":
        conn.sendall(b"HTTP/1.1 200 OK\r\n" + b"".join(b"x-padding-%05d: %s\r\n" % (i, b"p" * 100) for i in range(700)) + b"\r\n")
        return False
    if what == "folded":
        conn.sendall(b"HTTP/1.1 200 OK\r\nx-amz-request-id: " + request_id.encode() + b"\r\nx-folded: one\r\n two\r\nContent-Length: 0\r\n\r\n")
        return False
    if what == "slow":
        time.sleep(0.3)
    if what == "badsum":
        checksum = base64.b64encode(hashlib.sha256(b"something else").digest())
    if what == "nosum":
        checksum = None
    if what == "wrongbody":
        body = bytes(reversed(body))
        checksum = base64.b64encode(hashlib.sha256(body).digest())
    extra = b""
    if what == "close":
        extra = b"Connection: close\r\n"
    if what == "chunked":
        conn.sendall(object_head(size, checksum, request_id, b"Transfer-Encoding: chunked\r\n"))
        conn.sendall(chunked(body))
        return True
    conn.sendall(object_head(size, checksum, request_id, extra))
    if what in ("reset", "stall", "short", "shortfin"):
        conn.sendall(body[:size // 2])
        time.sleep(0.2 if what == "reset" else 0.05)
        if what == "reset":
            conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            conn.close()
        elif what == "stall":
            time.sleep(3)
        elif what == "short":
            conn.unwrap().close()
        return False
    conn.sendall(body)
    if what == "idleclose":
        time.sleep(0.01)
        conn.unwrap().close()
        return False
    return what != "close"


def serve_connection(raw, context, log_path):
    try:
        conn = context.wrap_socket(raw, server_side=True)
    except (ssl.SSLError, OSError):
        raw.close()
        return
    buffered = b""
    try:
        while True:
            request, buffered = read_request(conn, buffered)
            if request is None or not respond(conn, request, log_path):
                break
    except (ssl.SSLError, OSError, ValueError):
        pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def serve_https(listener, context, log_path):
    while True:
        raw, _ = listener.accept()
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        threading.Thread(target=serve_connection, args=(raw, context, log_path), daemon=True).start()


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: standin.py DIR [--bind ADDRESS]")
    directory = sys.argv[1]
    address = sys.argv[sys.argv.index("--bind") + 1] if "--bind" in sys.argv else "127.0.0.1"
    os.makedirs(directory, exist_ok=True)
    context, ca_file = contexts(directory)
    log_path = os.path.join(directory, "requests.ndjson")
    open(log_path, "w").close()

    dns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dns.bind((address, 0))
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((address, 0))
    listener.listen(64)
    threading.Thread(target=serve_dns, args=(dns, address), daemon=True).start()
    threading.Thread(target=serve_https, args=(listener, context, log_path), daemon=True).start()
    print(json.dumps({"address": address, "dns_port": dns.getsockname()[1], "https_port": listener.getsockname()[1],
                      "ca_file": ca_file, "requests": log_path, "domain": DOMAIN}), flush=True)
    # Serve until stdin closes (the test or check that started it is gone) or a signal ends the process.
    while sys.stdin.buffer.read(4096):
        pass


if __name__ == "__main__":
    main()
