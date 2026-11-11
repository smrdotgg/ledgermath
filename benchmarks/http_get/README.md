# http_get

HTTPS GET requests to S3, one request per sample, with every phase of every request an
event: name resolved, connected, secured, request sent, first byte, headers, body. The
binary speaks to S3 itself. It sends its own DNS query to the box's resolver, opens TCP,
does TLS with AWS-LC (linked statically), writes HTTP/1.1 by hand, signs each request by
hand with SigV4 before the request's first timestamp, and frames the response itself. No
SDK, no retry, no redirect.

An error (a status that is not 2xx, a reset, a timeout, a short body, a TLS or DNS failure)
is an event holding what was received. The Run goes on to the next request, and the exit
code says a completed Run contained an error.

The design is the study in the first comment of the step-5 brief (#43). Where this differs,
the reasons are in "Departures from the study" at the end.

```bash
# AWS-LC's source is not in git: fetch the pinned archive once, then build.
benchmarks/harness/c/vendor/fetch-aws-lc.sh /path/to/aws-lc.tar.gz
make -C benchmarks/http_get AWS_LC_ARCHIVE=/path/to/aws-lc.tar.gz   # build/static/http_get
```

The first build unpacks the archive (336 MB) and builds AWS-LC into `build/aws-lc` (28 MB).
Later builds, `make -B` included, reuse it as long as the archive, flags and compilers are
the same. `make clean` leaves it. A run against S3 needs the Service inputs below; the
tests run it against a local stand-in (see "Testing").

## Parameters

| Variable | Scheduled (the study's sets) | Meaning |
|---|---|---|
| `LM_PARAM_OBJECT_BYTES` | `4096`, `131072`, `16777216` | The size of the Fixture object. Each 2xx body is checked against the first this-many bytes of the Fixture pattern; the body buffer is this plus 64 KiB |
| `LM_PARAM_KEY` | `http_get/v1/<object_bytes>` | The object key, sent as the path, encoded as S3 wants (once, every byte but `A-Z a-z 0-9 - . _ ~ /` as `%XX`) |
| `LM_PARAM_CONNECTION` | `new`, `reused` | `new`: every request resolves the name, connects and secures a connection of its own, inside its sample. `reused`: one kept connection, opened outside any sample, carries every request; it is reopened (outside a sample) when the server closes it |
| `LM_PARAM_GAP_MEAN_MS` | `200` | The mean of the pause before each request after the first: exponential, from a fixed seed, so every Run pauses the same sequence |
| `LM_PARAM_BUDGET_SECONDS` | `240` (`120` for 16 MiB) | No request starts after this long from the first; the Run then ends early |
| `LM_PARAM_TIMEOUT_MS` | `10000` | The longest the binary waits for any one thing: the DNS reply, `connect`, and each TLS read or write (the sockets' `SO_RCVTIMEO` and `SO_SNDTIMEO`; the latter also bounds a blocking `connect` on Linux) |
| `LM_PARAM_CA_FILE` | `/etc/pki/tls/certs/ca-bundle.crt` | The PEM bundle the server's chain is verified against: the box's own trust store |
| `LM_PARAM_RESOLV_CONF` | `/etc/resolv.conf` | The file whose first IPv4 `nameserver` line is the resolver queried. An address may carry a port, `<address>:<port>`, which no system resolver reads; the tests' stand-in listens on one |
| `LM_PARAM_AUTH` | `sigv4` | `sigv4`: each request is signed with the credentials below. `none`: unsigned, and no credential is read. That is how a public object can be fetched (it was, once; see "A real exchange") |

`LM_SAMPLES` is the number of counted requests; request 0 is a warmup sample before them.
`--quick` takes 3 counted requests and gives every unset parameter a default (4 KiB, a new
connection, 10 ms gaps, 60 s budget, 5 s timeout, the paths above, `sigv4`).

## Service inputs

These come from the runner, never from the schedule, and never reach the Run:

| Variable | Meaning |
|---|---|
| `LM_SERVICE_ENDPOINT` | `https://<host>[:<port>]`, no path. On the box `https://<fixtures-bucket>.s3.us-east-2.amazonaws.com`: virtual-hosted style, so the bucket is the host's first label. The host is resolved, used for SNI and certificate verification, and sent as `Host` (with the port when it is not 443) |
| `LM_SERVICE_REGION` | The Region the signature is scoped to, `us-east-2`. Read only with `auth` `sigv4` |
| `LM_SERVICE_AWS_ACCESS_KEY_ID` | Short-lived credentials from `AssumeRole`: the key ID (16 to 128 capital letters and digits) |
| `LM_SERVICE_AWS_SECRET_ACCESS_KEY` | The secret key (at least 16 characters) |
| `LM_SERVICE_AWS_SESSION_TOKEN` | The session token (at least 16 characters); optional, sent as `x-amz-security-token` when given |

A missing or malformed input is a usage error: exit 2 after `started` alone, with a line on
stderr naming the variable and never its value.

## One request's events

Over a new connection, in stream order. The binary reads the clock just after each call
named below returns, and nowhere else inside a sample. The request's lines are written once
it has ended (with its body checked), so a binary that dies mid-request leaves none of
them.

| Event | Its `t`: read just after | Fields besides `t` |
|---|---|---|
| `sample_started` | nothing: just before the DNS query's `send` (new) or the request's `SSL_write` (reused) | `sample`, `warmup`, `repetitions` (1) |
| `name_resolved` | `recv` returned the resolver's reply | `request`, `server`, `name`, `reply_bytes`, `rcode`, `truncated`, `answers` (each record as `<owner> <ttl> <TYPE> <data>`), `authority` (when the reply has one), `address` (the one used: the first A record of the end of the CNAME chain), `cpu_ns` |
| `connection_opened` | `connect` returned | `connection`, `request`, `address`, `port`, `nodelay` (read back), `local`, `cpu_ns` |
| `connection_secured` | `SSL_connect` returned 1 | `connection`, `tls`, `cipher`, `group`, `peer_signature`, `alpn`, `hello_retry`, `resumed`, `verify`, `peer_chain_sha256` (each certificate as sent, leaf first), `cpu_ns` |
| `certificate` | the same `t`, the first time a fingerprint appears in the Run | `sha256`, `der_base64` |
| `request_sent` | `SSL_write` of the whole request returned | `request`, `connection`, `method`, `target`, `request_bytes`, `headers` (as sent, in order, with credential values withheld), `signing` (`algorithm`, `credential_scope`, `signed_headers`), `cpu_ns` |
| `first_byte` | the first `SSL_read` returning more than 0 | `request`, `cpu_ns` |
| `response_headers` | the read that completed the header block, and its parse | `request`, `status_line`, `status`, `headers` (`[[name, value], …]`, verbatim, in order), `cpu_ns` |
| `response_ended` | the read that completed the body (`Content-Length` reached, the chunked terminator, or close_notify for a body framed by the connection's end) | `request`, `bytes` (the body, de-chunked), `wire_bytes`, `framing`, `body_sha256`, `cpu_ns`, `tcp_info`; for 2xx `fixture` and `s3_checksum`; otherwise `body` and `error_fields` |
| `request_failed` | the call that failed returned | instead of the response's remaining events: `request`, `phase`, `error`, `detail`, `bytes_received`, and what had arrived (below) |
| `sample_ended` | the same clock read as `response_ended` or `request_failed` | `sample` |
| `connection_closed` | `close` returned, outside the sample | `connection`, `reason`, `requests`, `session_tickets_received` |

Over a reused connection, `name_resolved`, `connection_opened`, `connection_secured` and
any `certificate` come before the sample that first uses the connection, outside any sample
and without `request`. Each sample is `sample_started`, `request_sent`, `first_byte`,
`response_headers`, `response_ended` (or `request_failed`), `sample_ended`. Before each
sample the binary looks at the idle connection without blocking. If the server has closed
it (`eof_while_idle`, `close_notify_while_idle`), sent anything (`data_while_idle`) or reset
it (`error_while_idle`), the binary writes `connection_closed` and opens a new connection
outside the sample. A setup that fails outside a sample is `connection_failed` (`phase`,
`error`, `detail`) and makes no request.

`connection_closed.reason`: `done` (new: after its one request), `server_requested` (the
response said `Connection: close`, or was HTTP/1.0), `failed` (after a failed request), the
four idle reasons above, `end_of_run`.

### The phases

| Phase | Interval | Includes, besides the network and the server |
|---|---|---|
| DNS | `name_resolved` − `sample_started` | the `send` and `recv` system calls |
| TCP | `connection_opened` − `name_resolved` | closing the UDP socket, parsing the reply (microseconds), the `connect` system call |
| TLS | `connection_secured` − `connection_opened` | our side of the handshake: key generation, certificate verification (see "What our CPU contributes") |
| Send | `request_sent` − `connection_secured` (reused: − `sample_started`) | encrypting and writing the request |
| First byte | `first_byte` − `request_sent` | decrypting the first record (at most 16 KiB) and any post-handshake messages (S3 sends none) |
| Headers | `response_headers` − `first_byte` | 0 to microseconds: the header block usually arrives in the first read; parsing it |
| Body | `response_ended` − `response_headers` | decrypting and copying every record after the headers |
| Transfer | `response_ended` − `first_byte` | Headers and Body together, the study's transfer |
| Total | `sample_ended` − `sample_started` | |

The socket, the TLS object, the DNS query and the signed request are all made before the
sample starts. Each phase event's `cpu_ns` is this thread's CPU time
(`CLOCK_THREAD_CPUTIME_ID`) over that phase alone, from the previous boundary of the same
request to this one. Reading that clock costs a system call at every boundary;
`observed.cpu_clock_read_ns` is its measured cost, about 0.34 µs on the dev machine.

### Failures

`request_failed.phase` is `dns`, `connect`, `tls`, `send`, `first_byte`, `headers` or
`body`. `error` is one of:

- `dns`: a reply came but cannot be used. Its rcode is not NOERROR, its TC bit is set, it has
  no A record for the name, it does not parse, or its ID or question is not the query's.
- `timeout`: nothing came within `timeout_ms`.
- `refused` or `unreachable`: `connect` said so.
- `reset`: the connection was reset.
- `eof`: the connection ended early, with close_notify or with TCP alone; `detail` says which.
- `tls`: the handshake or a record failed (an alert, a protocol error).
- `verify`: the server's certificate did not verify (another CA, another name, expired).
- `protocol`: the response broke HTTP/1.1. That covers folding, a bare CR or LF, a header
  block over 64 KiB, disagreeing `Content-Length` values, a transfer coding other than
  chunked, an interim 1xx response, a body larger than the buffer, or bytes after the
  response's end.
- `system`: another error from the kernel.

`detail` is the library's or the kernel's words.

What had arrived is kept:

- `bytes_received`: the response's bytes as framed.
- `head_received`: the partial header block, when it never completed.
- `content_length`, `body_bytes_received` and `body_sha256_received`: when the headers had
  completed.
- `tcp_info`.

A DNS reply that cannot be used is still in `name_resolved`, its records included, before
the failure.

### What ends a Run early

Nothing retries. Every request is attempted, with two exceptions, after which the Run goes
straight to its closing `observed`, `verified` and `finished`:

- **The budget.** No request starts once `budget_seconds` have passed since the first.
  Waiting is bounded: the last request can still take a few `timeout_ms` (the DNS reply,
  `connect`, the handshake, and then each read). A server that sends one byte just inside
  every `timeout_ms` is not cut off; the runner's timeout is the backstop. The schedule's
  `timeout_seconds` should be at least `budget_seconds` plus a minute.
- **Nothing reachable.** Ten requests in a row (or ten reused-connection setups) end without
  a TLS session: DNS, `connect` or the handshake failed every time. A server that answers,
  with any status, resets this count. A 503 storm is therefore recorded in full. At about 5
  requests a second that is 1/1000 of what one prefix supports.

`observed.ended_early` says which (`budget`, `unreachable`, or null), and
`requests_not_made` how many requests were not made. Such a stream has fewer counted
samples than `LM_SAMPLES`, so it fails `check-events.py --samples N` on purpose, and the
exit code is 4.

### Exit codes

| Code | When |
|---|---|
| 0 | Every request returned 2xx with a body that matches the Fixture and S3's SHA-256 checksum |
| 1 | A 2xx body did not match the Fixture (`fixture` `mismatch`), or S3's checksum was wrong or absent (`s3_checksum` `mismatch` or `absent`): every event is kept, `observed.body_mismatch` is true. Also any fatal setup error before the first sample (an unreadable CA file or resolver file), as `lm_die` does, and the secret guard (below) |
| 2 | A bad parameter or Service input (`lm_usage`), after `started` alone |
| 3 | stdout could not be written |
| 4 | The Run completed, but a request failed, a status was not 2xx, a reused connection could not be set up, or the Run ended early |

Method version 1 counts only exit 0. A Method that reads requests one by one can take the
good requests of an exit-4 Run.

## What is recorded, what is withheld, and why

**Verbatim:**

- every DNS record of the reply, in order, with its TTL;
- the address and port connected to, and the local address;
- the TLS version, cipher, group, peer signature algorithm and ALPN negotiated;
- the SHA-256 of each certificate exactly as the server sent it, and each new certificate's
  DER once per Run;
- the request as sent, except credential values;
- the status line and every response header, in order, S3's request IDs and checksums
  included;
- the body's length and SHA-256;
- a non-2xx body of at most 4 KiB.

**Never printed:** the access key ID (it maps to the account), the secret key, the session
token, and every signature. `Authorization` and `x-amz-security-token` appear in
`request_sent.headers` with the value `<withheld>`. What the signature covered is in
`signing`: the scope (date, Region, service) and the signed header names, which the binary
built from nothing secret.

**Anything received** (a header, the status line, a DNS record, an error body, each XML
field) is printed only if it holds:

- none of our credentials or signatures, ignoring case;
- nothing shaped like an access key ID: `AKIA` or `ASIA` and sixteen more capitals or digits;
- no number of exactly twelve digits standing alone (an account ID, as in
  `arn:aws:sts::123456789012:`). Digits inside a hex or base64 value touch letters, and are
  not one: real S3 sent an ETag that the stricter "twelve digits anywhere" withheld.

Something that fails the rule becomes `{"withheld_bytes": n}`, with no digest: a digest of a
short text could be searched for the account ID it hides. For an error body,
`error_fields` keeps S3's `Code`, `Message`, `RequestId` and `HostId`, each passing the same
rule on its own.

This matters on real S3. Its `InvalidToken` body echoes the whole session token, and its
`InvalidAccessKeyId` body echoes the key ID (see "A real exchange").

**The guard.** Behind that rule, `lm_lines.c` searches every buffer it is about to write to
stdout for every registered secret, ignoring case. It exits 1 with a fixed line, naming
nothing, rather than write one. The rule above keeps the Run going; the guard only catches
a mistake. Bytes received pass the same search before they are base64'd. A secret key or
token shorter than 16 characters is refused at the start, because something that short
could turn up by chance (inside a certificate's base64, say). stderr carries only fixed
messages and parameter values, never a Service input.

## Checking the body, and the elision guard

Outside every timed interval:

- **Before the first sample:** the binary computes the Fixture's SHA-256 for `object_bytes`
  (`observed.fixture_sha256`). The pattern is `benchmarks/harness/c/lm_fixture.h`'s: the
  64-bit little-endian word at offset o is `mix64(o ^ 0x8d6d2f9d5f9d1b37)`.
- **After each 2xx response:** it hashes the de-chunked body. `fixture` is `match` when the
  length and digest are the Fixture's. `s3_checksum` is `match` when `x-amz-checksum-sha256`
  (requested with `x-amz-checksum-mode: ENABLED` on every request) is that digest in base64.
  Every verified body therefore matches every other.

`verified` is the first 64 bits of one SHA-256 over every complete response's body digest,
in order, errors included.

## Observed

Two `observed` events. The first comes before any sample, so a crash still leaves it:

| Key | What it is |
|---|---|
| `tls_library` | `AWS-LC 5.14.0`, from the headers compiled in |
| `tls_library_source_sha256` | The source archive's SHA-256, compiled in from `aws-lc.lock` |
| `client_hello` | The ClientHello this binary's TLS configuration makes for the endpoint's host, read back from a memory BIO with no network. It is the observed counterpart of the pinned offer (below). It has its sizes, legacy version, cipher suites and extensions in order, groups, key shares, signature algorithms, versions, ALPN and PSK modes. Making it is also the library's one-time warm-up (seeding its RNG, first allocations) |
| `ca_file_sha256`, `ca_certificates_loaded`, `ca_certificates_rejected` | The CA bundle read, and how many of its certificates the trust store took (143 and 0 for Amazon Linux 2023's) |
| `resolver` | `<address>:<port>` queried |
| `fixture_sha256` | The Fixture digest every 2xx body must have |
| `body_buffer_bytes` | `object_bytes` + 64 KiB |
| `cpu_clock_read_ns` | The median cost of one read of the thread CPU clock |

The second comes after the last sample:

- `requests_made` and `requests_not_made`;
- `ended_early`;
- `connections_opened` and `connection_setups_failed`;
- `responses`, `responses_2xx_verified` and `requests_failed`;
- `body_bytes`: the length every verified body had, or null;
- `body_mismatch`;
- `statuses` (status → count) and `failures` (error → count).

The two lists are what the stream also shows, gathered.

## TLS

**AWS-LC 5.14.0** is built from the pinned archive and linked statically; the final link
with `gcc` needs no `libstdc++`. The binary checks at start that its headers are the
release the lock pins.

**Pinned in code,** so a new release cannot change the offer silently:

- TLS 1.2 to 1.3.
- The TLS 1.3 suites in a fixed order: AES-128-GCM, AES-256-GCM, ChaCha20-Poly1305. The
  library would otherwise put ChaCha20 first on a CPU without AES instructions.
- Six ECDHE AEAD suites for TLS 1.2.
- The groups: AWS-LC 5.14.0's own default list, pinned.
  - In order: X25519MLKEM768, SecP256r1MLKEM768, SecP384r1MLKEM1024, X25519, P-256, P-384.
  - Key shares are sent for the first group and X25519.
- The signature algorithms accepted: the library's default verify list, pinned.
- ALPN `http/1.1`.
- No GREASE, and no extension permutation.
- No OCSP or SCT request.
- Session tickets requested but never stored, so no session is ever offered back.
- Renegotiation refused.

**What is negotiated** is the server's choice and is recorded. S3 chose `TLSv1.3`,
`TLS_AES_128_GCM_SHA256` and `X25519MLKEM768`, with no HelloRetryRequest and no session
tickets.

**Verification:**

- `SSL_VERIFY_PEER` against `ca_file`, the host name checked.
- The binary owns the socket and hands it to the library (`SSL_set_fd`).
- Read-ahead is off, the library default: each record is read in two system calls.

**Two notes on the library:**

- AWS-LC reads `OPENSSL_ia32cap` from the environment to override CPU features. The runner
  passes only `LM_*` variables, so it is never set.
- The link warns that AWS-LC's socket BIO references `getaddrinfo`. Nothing calls it: the
  binary resolves names itself.

## What our CPU contributes

Every phase's `cpu_ns` is this thread's CPU in that phase. A Method can subtract it, or
report the network's and S3's share as wall time minus `cpu_ns`. That share is an
approximation: our CPU and the network overlap when data is already waiting.

Measured against real S3 from the dev machine, an `m6id.xlarge` in `use2-az1` (other work
was running on it), with the Amazon Linux build. Medians of the counted requests:

| Phase | 5,545 B, new (5 requests) | Our CPU | 5,545 B, reused (5) | Our CPU |
|---|---|---|---|---|
| DNS | 0.26 ms | 0.05 ms | | |
| TCP | 1.17 ms | 0.10 ms | | |
| TLS | 2.42 ms | 0.85 ms (0.72 to 0.87) | | |
| Send | 0.011 ms | 0.010 ms | 0.052 ms | 0.052 ms |
| First byte | 27.4 ms | 0.06 ms | 21.8 ms | 0.09 ms |
| Body | 0.019 ms | 0.018 ms | 0.017 ms | 0.017 ms |

- **TLS phase:** about a third of it is ours.
- **TCP phase:** our 0.1 ms is the kernel's own work on our thread, sending the SYN and the
  final ACK through a virtual NIC.
- **Body of a small object:** the body arrives with or just after the headers, so the Body
  phase is almost entirely our decrypting and copying. Its wall time is not a network
  number.
- **Send on a reused connection:** five times a new connection's, all of it CPU. It is the
  first write after a 200 ms sleep, with cold caches.

The numbers will differ by instance type, which is why every request carries them.

## A real exchange

Once, on 2026-11-11, the Amazon Linux build (sha256 `12b9e582…b119`, then `0487aa4c…971d`
after the ETag fix) made 23 requests to real S3 in us-east-2. Two more were made with curl
(below), 25 in all. The resolver was 172.31.0.2 (the VPC's) and the trust store was Amazon
Linux 2023's bundle.

**The public bucket `aws-public-blockchain`, unsigned (`auth` `none`).** Its objects are
not the Fixture, so these Runs exit 1, as they must.

- `/manifest.json` (5,545 B): six requests over new connections, six over one reused
  connection, and two more after the fix.
- `/index.html` (44,170 B): three requests.
- Every response was 200 with `Content-Length` framing.

**The regional endpoint, signed with deliberately invalid credentials:**

| Credentials | S3's answer | Body |
|---|---|---|
| A fake `ASIA` key ID with a fake session token | `HTTP/1.1 400 Bad Request`, `InvalidToken`, "The provided token is malformed or otherwise invalid.", chunked, `Connection: close` | 550 to 570 B, withheld |
| A fake `AKIA` key ID, no token | `HTTP/1.1 403 Forbidden`, `InvalidAccessKeyId`, "The AWS Access Key Id you provided does not exist in our records.", chunked | 374 B, withheld |

`error_fields` kept the code, message and IDs in both cases. No byte of the fake
credentials reached stdout or stderr.

Two requests with curl's own SigV4 showed why the bodies were withheld. The `InvalidToken`
body carries the token in `<Token-0>`; the `InvalidAccessKeyId` body carries the key ID in
`<AWSAccessKeyId>`. The study's proposed rule (withhold on twelve digits or an AKIA/ASIA key
ID) would have printed the token.

**One counted request over a new connection,** from the final build, with this machine's
address removed and the fingerprints shortened:

```json
{"event":"sample_started","t":327318522624393,"sample":1,"warmup":false,"repetitions":1}
{"event":"name_resolved","t":327318522831979,"request":1,"server":"172.31.0.2:53","name":"aws-public-blockchain.s3.us-east-2.amazonaws.com","reply_bytes":238,"rcode":0,"truncated":false,"answers":["aws-public-blockchain.s3.us-east-2.amazonaws.com. 194 CNAME s3-r-w.us-east-2.amazonaws.com.","s3-r-w.us-east-2.amazonaws.com. 5 A 3.5.92.92","s3-r-w.us-east-2.amazonaws.com. 5 A 3.5.104.55","s3-r-w.us-east-2.amazonaws.com. 5 A 3.5.88.87","s3-r-w.us-east-2.amazonaws.com. 5 A 3.5.105.240","s3-r-w.us-east-2.amazonaws.com. 5 A 3.5.93.57","s3-r-w.us-east-2.amazonaws.com. 5 A 3.5.89.24","s3-r-w.us-east-2.amazonaws.com. 5 A 3.5.128.144","s3-r-w.us-east-2.amazonaws.com. 5 A 3.5.105.176"],"address":"3.5.92.92","cpu_ns":27179}
{"event":"connection_opened","t":327318524098388,"connection":1,"request":1,"address":"3.5.92.92","port":443,"nodelay":true,"local":"172.31.x.x:53096","cpu_ns":60382}
{"event":"connection_secured","t":327318526289638,"connection":1,"tls":"TLSv1.3","cipher":"TLS_AES_128_GCM_SHA256","group":"X25519MLKEM768","peer_signature":"rsa_pss_rsae_sha256","alpn":"http/1.1","hello_retry":false,"resumed":false,"verify":"ok","peer_chain_sha256":["ffb529f1…c1a1","138bdf6e…019b","87dcd4dc…2706"],"cpu_ns":556401}
{"event":"request_sent","t":327318526297502,"request":1,"connection":1,"method":"GET","target":"/manifest.json","request_bytes":152,"headers":[["Host","aws-public-blockchain.s3.us-east-2.amazonaws.com"],["User-Agent","ledgermath-http_get/1"],["x-amz-checksum-mode","ENABLED"]],"cpu_ns":7666}
{"event":"first_byte","t":327318554774556,"request":1,"cpu_ns":32261}
{"event":"response_headers","t":327318554780793,"request":1,"status_line":"HTTP/1.1 200 OK","status":200,"headers":[["x-amz-request-id","SWYJSXZ7FQHJKTK2"],["x-amz-id-2","dOi6+afXMKwQTQyj0kpV2CmnfDnI2Mi0OEB7jQXhVKJKt8XzfJOr88HpZ7owcxcdoCymYEmPGV8Ge3fnTUyJgii99sM9IOqC"],["Content-Length","5545"],["Accept-Ranges","bytes"],["Date","Wed, 11 Nov 2026 11:53:12 GMT"],["Server","AmazonS3"],["Last-Modified","Thu, 15 Jan 2026 19:21:26 GMT"],["ETag","\"7f3295ffaa17252261001785f819a205\""],["x-amz-checksum-crc64nvme","4l04sRZeHUk="],["x-amz-checksum-type","FULL_OBJECT"],["Content-Type","application/json"],["x-amz-server-side-encryption","AES256"]],"cpu_ns":5599}
{"event":"response_ended","t":327318554790612,"request":1,"bytes":5545,"wire_bytes":5545,"framing":"length","body_sha256":"e321ab031b0e7deaf2f74b38e1b9c5200013c1e9aa53fe1ae77710632113f950","cpu_ns":9790,"tcp_info":{"rtt_us":1143,"rttvar_us":344,"min_rtt_us":1000,"rcv_rtt_us":0,"rcv_space":56587,"rcv_mss":5567,"snd_mss":8228,"pmtu":9001,"snd_cwnd":10,"total_retrans":0,"bytes_acked":1757,"bytes_received":12091,"segs_out":12,"segs_in":12},"fixture":"mismatch","s3_checksum":"absent"}
{"event":"sample_ended","t":327318554790612,"sample":1}
{"event":"connection_closed","t":327318554850258,"connection":1,"reason":"done","requests":1,"session_tickets_received":0}
```

The phases of this request:

| DNS | TCP | TLS | Send | First byte | Body | Total |
|---|---|---|---|---|---|---|
| 0.21 ms | 1.27 ms | 2.19 ms (0.56 ms ours) | 0.01 ms | 28.48 ms | 0.01 ms | 32.17 ms |

The `ETag`, `"7f3295ffaa17252261001785f819a205"`, holds a run of fourteen digits between
letters. The build before the fix withheld it in the earlier Runs; this one prints it.

A few facts S3 showed along the way:

- It answered with `x-amz-checksum-crc64nvme` for this object; the object was uploaded
  without a SHA-256 checksum. The Fixtures are to be uploaded with one.
- An unsigned request may still send `x-amz-checksum-mode`.
- The path MTU was 9001: jumbo frames inside the VPC.

## Size of a Run's stream

| | Per request | 200 counted requests, against the stand-in (measured) | Projected for S3 |
|---|---|---|---|
| New connections | 3.0 KB stand-in, 3.5 KB S3 | 616,157 B | about 720 KB |
| Reused connection | 2.0 KB | 406,972 B | about 414 KB |

Against S3 a signed request's events come to about 3.5 KB over a new connection. They are
the real unsigned request's 3.1 KB, plus 365 B for the signed request's headers and
`signing`, plus about 30 B for a SHA-256 checksum header. The largest pieces are
`name_resolved` (730 B for 9 records), `response_headers` (640 B), `request_sent` (660 B
signed), `connection_secured` (490 B) and `response_ended` (490 B, `tcp_info` included).

Outside the samples there are about 9 to 10 KB, mostly S3's three certificates (6.2 KB).
These figures are larger than the study's estimate (541 KB and 261 KB) because:

- every phase carries `cpu_ns`;
- `tcp_info` has more fields;
- `client_hello` is in `observed`;
- the request headers are recorded on every request.

Where long streams live is the maintainer's decision (#43, decision 4).

## Building it

`aws-lc.lock` (`benchmarks/harness/c/vendor/`) pins:

- the release;
- the archive's URL and SHA-256;
- the CMake flags: Release, static, no Go or Perl, no tests or tools,
  `ENABLE_CRYPTO_POLICIES=OFF`;
- the targets: `crypto` and `ssl`.

`build-aws-lc.sh` refuses an archive with another hash. It adds `-ffile-prefix-map` so the
unpack directory leaves no trace in the library's bytes, and it prints a few lines for the
build record. The full CMake log stays in `build/aws-lc/build.log`.

**Measured in `amazonlinux:2023.12.20260710.0`**, with 2 CPUs and `-j2` on the shared dev
machine:

| | |
|---|---|
| Configure | 4 s (9 s on a busier run) |
| Build | 122 to 208 s |
| Largest compiler process | 331 MB RSS; the container's peak, page cache of the 336 MB source included, was 0.76 to 0.98 GB |
| Library | `libcrypto.a` 6,988,232 B, `libssl.a` 1,238,186 B |
| `http_get`, static | 5,543,128 B (5,059,608 stripped), built in 2 s once the library exists |
| Byte identity | Two libraries built separately, in different directories, gave the same `http_get` bytes |
| Packages beyond `box.sh`'s | `cmake` and `gcc-c++`, which pull in nine more: `cmake-data`, `cmake-filesystem`, `cmake-rpm-macros`, `emacs-filesystem`, `jsoncpp`, `libstdc++-devel`, `libuv`, `rhash`, `vim-filesystem` |

## Testing

`tests/http-get.test.ts` builds this binary and `build/test/http_get_test` with the
machine's compiler. It needs `cmake`, a C++ compiler and `AWS_LC_ARCHIVE`, and skips with a
message without them, unless `LM_HTTP_GET_REQUIRED=1`, as CI sets it.

The binary then runs against `tests/http-get/standin.py`, a local stand-in for S3 and the
resolver. The stand-in has a throwaway CA made by `openssl` at start, and the host name's
first label chooses its behaviour:

- the Fixture, in Content-Length or chunked framing;
- 403 and 503 XML errors;
- an error body echoing the credentials;
- one naming an account;
- a reset, a stall, and short bodies with and without close_notify;
- wrong or missing checksums, and other bytes;
- a slow first byte;
- oversized or folded headers;
- a certificate from another CA, and one for another name;
- NXDOMAIN, a truncated reply, and no reply;
- a refused connection;
- `Connection: close`, and closes while idle.

Every stream must pass `scripts/check-events.py`, `methods/v1/stream.ts` and the event
schema. Every stream and stderr is searched for the test credentials and for every
signature the stand-in received.

The test driver checks the parts directly:

- SigV4 against AWS's test suite (the cases in `tests/http-get/sigv4/`, from aws-c-auth),
  the S3 User Guide's two examples, and a signature computed in the test with
  `node:crypto`;
- the DNS builder and parser: compression, CNAME chains in any order, truncation, bad
  pointers;
- the HTTP parser;
- the event lines' UTF-8 handling and the guard.

`scripts/check-scratch.py` runs the study's five sets in a `FROM scratch` container
against the same stand-in.

## What the runner and the stage must provide

- **The build:**
  - `make BUILD=static` here, with `AWS_LC_ARCHIVE` set to the archive's path.
  - The packages above.
  - About 520 MB of disk for the archive, its unpacked source and the build.
  - The archive can be fetched once per boot with `fetch-aws-lc.sh OUT URL`, from a
    content-addressed copy in the Runs bucket, and is checked against the lock either way.
    GitHub's tag archives have been stable, but are not promised to be.
- **The parameters above,** in the schedule.
- **`LM_SERVICE_ENDPOINT`**, `https://<fixtures-bucket>.s3.us-east-2.amazonaws.com`; the
  bucket name must have no dots.
- **`LM_SERVICE_REGION`**, `us-east-2`.
- **The credentials:** `LM_SERVICE_AWS_ACCESS_KEY_ID`, `LM_SERVICE_AWS_SECRET_ACCESS_KEY`
  and `LM_SERVICE_AWS_SESSION_TOKEN`, from one `AssumeRole` per boot. They go in
  `http_get`'s environment only, never into the Run's `params`.
- **The files:** `ca_file` and `resolv_conf`, the box's own.
- **The objects in the bucket**, keys `http_get/v1/4096`, `http_get/v1/131072` and
  `http_get/v1/16777216`:
  - Each is the first N bytes of the Fixture pattern.
  - Each is uploaded in a single part with `ChecksumAlgorithm` `SHA256`, so a GET with
    `x-amz-checksum-mode: ENABLED` returns `x-amz-checksum-sha256`.
  - Each stays in the STANDARD class, under SSE-S3.
  - Their SHA-256, in hex and as S3 returns it:

    | Key | SHA-256 | As S3 returns it |
    |---|---|---|
    | `4096` | `72f840c3ae501f19c3083101c1e79c84b13fae0289077549d73b4647c253ef8c` | `cvhAw65QHxnDCDEBweechLE/rgKJB3VJ1ztGR8JT74w=` |
    | `131072` | `e9266ae7ba4f7463ec9b3f791b16bce95986f77566d995298bae7be5cf22fa38` | `6SZq57pPdGPsmz95Gxa86VmG93Vm2ZUpi6575c8i+jg=` |
    | `16777216` | `59ab84d1e9ac682e4d54c3b0cb8c06bf3a8b56734fa8178d70751210d5e61de3` | `WauE0emsaC5NVMOwy4wGvzqLVnNPqBeNcHUSENXmHeM=` |

- **The credentials' permissions:** `s3:GetObject` on
  `arn:aws:s3:::<fixtures-bucket>/http_get/*`, and nothing else. Without `s3:ListBucket` a
  missing object is a 403 rather than a 404. Either way it is an event. SSE-S3 needs no KMS
  permission.
- **A schedule `timeout_seconds`** of at least `budget_seconds` plus a minute.

## Departures from the study

- **Service inputs.**
  - The endpoint comes whole, as `LM_SERVICE_ENDPOINT`, instead of being built from
    `region` and `LM_SERVICE_BUCKET`. The stand-in needs another host and port, and the host
    sent is recorded in every request anyway.
  - The Region comes as `LM_SERVICE_REGION`, as the brief lists it.
  - The key is the parameter `key`, not derived from `object_bytes`, so a public object
    could be fetched for the real exchange.
- **New parameters:** `key`, `timeout_ms` (the study fixed 2 s for DNS and nothing else),
  `resolv_conf` (the tests cannot replace `/etc/resolv.conf`; it may name a port) and
  `auth`.
- **`Authorization` is withheld whole.** The scope and signed headers move to `signing`.
  The rule ("a credential's value is never printed") is then one line, not a parser.
- **The error-body rule:**
  - It matches our own credentials exactly, ignoring case, beside the key-ID and account-ID
    shapes. Real S3 echoes the token, which the study's rule would have printed.
  - A twelve-digit number must stand alone.
  - A withheld item keeps no digest.
  - Headers, the status line and DNS records pass the same rule.
- **Events:**
  - Every phase event carries `cpu_ns` for its own phase, where the study had
    `handshake_cpu_ns` and two others.
  - `idle_ns` is dropped: it is derivable from the `t` values.
  - `connection_secured` has no `request`; join on `connection`.
  - `response_ended` gains `framing`, `fixture`, `s3_checksum` and `error_fields`.
  - A failed reused-connection setup is `connection_failed`.
  - `request_failed` carries the partial header block or body digest.
  - An SOA in DNS is in presentation form, so its numbers do not read as an account ID.
- **`observed` is two events.** The setup facts come first, so a crash still leaves them.
  The offer is read back from the ClientHello's bytes. Counts the stream shows directly are
  not repeated, beyond the summary above. `host` and `key` are left out: they were told,
  and `request_sent` shows them as sent.
- **A Run can end early.** It ends at its budget, or after ten requests in a row that
  reach no server. The study had nothing stop early.
- **An absent S3 checksum fails the body (exit 1).** The Fixtures are uploaded with one, so
  its absence means the Fixture is not what the stage made.
- **Gaps** run from the end of one request's output to the start of the next, not start to
  start, so requests never overlap.
- **The whole offer is pinned:** versions, both suite lists, groups, signature algorithms,
  GREASE and extension order. The study pinned the groups. The TLS 1.2 list is six ECDHE
  AEAD suites.
- **Two CMake flags added:** `ENABLE_CRYPTO_POLICIES=OFF` and `-ffile-prefix-map`. The
  study's byte-identical builds held only for one path; the AWS-LC source names are compiled
  in.
- **A 1xx interim response is a protocol error.** S3 sends none, and the event keeps it.
- **The lock** is `benchmarks/harness/c/vendor/aws-lc.lock`, in make syntax, rather than
  JSON.
- **The stand-in is Python, not TypeScript.** `scripts/check-scratch.py`, which is Python
  in a CI job without Bun, starts it too. Python's `ssl` gives socket-level control (a
  reset by `SO_LINGER`).
