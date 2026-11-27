# http_get

How long an HTTPS GET of an object takes, from the box to the S3 endpoint its Service
names, over a new connection per request or over one kept connection, one request at a
time on one thread, each request after the first preceded by a pause whose mean is
`gap_mean_ms`: a lightly loaded client. With `auth` `sigv4`, as scheduled, each request is
signed before its clock starts; each phase it reaches (name resolved, connected, secured,
request sent, first byte, headers, body) is an event, and the body of each 2xx response
that ends without a failure is checked against the Fixture.

## What a figure means

HTTPS GET requests to S3, one request per sample, with each phase a request reaches an
event: name resolved, connected, secured, request sent, first byte, headers, body. The
binary speaks to S3 itself. It sends its own DNS query to the box's resolver, opens TCP,
does TLS with AWS-LC (linked statically), writes HTTP/1.1 by hand, with `auth` `sigv4`
signs each request by hand with SigV4 before the request's first timestamp, and frames the
response itself. No
SDK, no retry, no redirect.

An error (a status that is not 2xx, a reset, a timeout, a short body, a TLS or DNS failure)
is an event holding what was received. The Run goes on to the next request, and the exit
code says a completed Run contained an error.

One repetition is one request, and each sample holds one: over a new connection
(`connection` `new`) from just before its DNS query, over a kept connection (`reused`) from
just before its request is written, to its whole body or to the failure that ends it; a
kept connection is opened outside any sample. Request 0 is a warmup sample; the counted
requests follow it, at most as many as the Run asks for, 200 in the schedule (40 for the
16 MiB object); a Run that ends early can make fewer (see "What ends a Run early").

Two Methods read these Runs ([Methods](https://ledgermath.com/docs/methods)). Method
`series` v1 counts only a Run whose binary exited 0 and whose stream passes its checks,
with as many counted samples as the Run asked for. Each Run it counts gives one figure,
the median of its counted requests' total times, in nanoseconds
(`time_per_repetition_ns`); a Run it does not count gives none. A Series gives the 5th,
50th and 95th percentiles of those figures across its counted Runs. Method `requests` v1
gives each phase of a request, and the total, its percentiles across the succeeded
requests: the 50th, 90th, 95th, 99th and 99.9th, each only where there are enough requests
for it, within each Run it counts and pooled across them. A Run that exited 4 can count
there too, when its stream passes the Method's checks and holds as many counted requests
as the Run asked for; a Run that holds fewer counted samples than it asked for is in no
figure, its succeeded requests included. In a Run it counts, failed requests are counted
and never timed. The phases are differences of the events' times, as "The phases" below
defines them. The binary observes no
`bytes_per_repetition`, so no bytes per second is derived.

So a figure is the time of an HTTPS GET of a Fixture object of `object_bytes`, or of one of
its phases, from a box of one instance type to S3 in the same Region, by a client that
sends one request at a time.

## What a figure does not show

- One thread sends one request at a time, with a pause before each request after the
  first whose mean is `gap_mean_ms`. It is not S3 under load.
- With `connection` `reused` the requests have no DNS, TCP or TLS phase, so they do not
  show the cost of a new connection.
- The box and the endpoint are in one Region, so a figure is not that of a client
  elsewhere. Where the dump took them, each Run's dumps record the box's network settings
  (`network`) and the subnet's route tables and the VPC's endpoints as the EC2 API
  describes them (`ec2_route_tables`, `ec2_vpc_endpoints`): configuration, not the route
  the requests took.
- Method `series` v1's one figure per counted Run is a median, not a tail. The tail of
  the requests is Method `requests` v1's.
- The Body phase is not a network figure on its own. It starts once the header block is
  parsed and takes in every later read, any wait for the network included; for a small
  object most of it can be the program's own work on bytes already received. In ten
  requests for one 5,545-byte object from a development machine, five over new
  connections and five over a kept one, the median Body phase was almost all CPU (see
  "What our CPU contributes").

## Parameters

Each parameter set runs on every instance type in the schedule, against the Service
`s3_fixtures`. Each parameter set and instance type is a Series of its own.

The benchmark's Series and their figures are listed at
[https://api.ledgermath.com/v1/benchmarks/http_get.json](https://api.ledgermath.com/v1/benchmarks/http_get.json),
which says in `left_out` how many it leaves out.

| Variable | Scheduled (the study's sets) | Meaning |
|---|---|---|
| `LM_PARAM_OBJECT_BYTES` | `4096`, `131072`, `16777216` | The size of the Fixture object. The body of each 2xx response that ends without a failure is checked against the first this-many bytes of the Fixture pattern; the body buffer is this plus 64 KiB |
| `LM_PARAM_KEY` | `http_get/v1/<object_bytes>` | The object key, sent as the path, encoded as S3 wants (once, every byte but `A-Z a-z 0-9 - . _ ~ /` as `%XX`) |
| `LM_PARAM_CONNECTION` | `new`, `reused` | `new`: every request resolves the name, connects and secures a connection of its own, inside its sample. `reused`: one kept connection, opened outside any sample, carries every request; it is reopened (outside a sample) when the server closes it |
| `LM_PARAM_GAP_MEAN_MS` | `200` | The mean of the pause before each request after the first: exponential, from a fixed seed, so every Run pauses the same sequence |
| `LM_PARAM_BUDGET_SECONDS` | `240` (`120` for 16 MiB) | No request starts once this long has passed since the Run began preparing its first request (signing it with `auth` `sigv4` and, over a reused connection, opening that connection); the Run then ends early. See "What ends a Run early" |
| `LM_PARAM_TIMEOUT_MS` | `10000` | The longest the binary waits for any one thing: the DNS reply, `connect`, and each TLS read or write (the sockets' `SO_RCVTIMEO` and `SO_SNDTIMEO`; the latter also bounds a blocking `connect` on Linux) |
| `LM_PARAM_CA_FILE` | `/etc/pki/tls/certs/ca-bundle.crt` | The PEM bundle the server's chain is verified against: the box's own trust store |
| `LM_PARAM_RESOLV_CONF` | `/etc/resolv.conf` | The file whose first IPv4 `nameserver` line is the resolver queried. An address may carry a port, `<address>:<port>`, which no system resolver reads; the tests' stand-in listens on one |
| `LM_PARAM_AUTH` | `sigv4` | `sigv4`: each request is signed with the credentials below. `none`: unsigned, and no credential is read. That is how a public object can be fetched (it was, once; see "A real exchange") |

`LM_SAMPLES` is the number of counted requests asked for; request 0 is a warmup sample before them.
`--quick` takes 3 counted requests and gives every unset parameter a default (4 KiB, a new
connection, 10 ms gaps, 60 s budget, 5 s timeout, the paths above, `sigv4`).

Gaps run from the end of one request's output to the start of the next, not start to
start, so requests never overlap.

## Observed values

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
- `statuses` (status → count) and `failures` (error → count);
- `fields_withheld` and `lines_withheld` (see "What is recorded").

The two lists are what the stream also shows, gathered.

## Findings

### What our CPU contributes

Every phase's `cpu_ns` is this thread's CPU in that phase. It is context for a reader, not
a quantity to subtract from the wall time: our CPU and the network overlap, the two clocks
are read one after the other, and the CPU clock counts kernel work done for this thread. On
real S3 the Body phase of one request took 19,751 ns of wall time and 19,872 ns of CPU.

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
- **Body of a small object:** in these requests the body arrived with or just after the
  headers, so the Body phase was almost entirely our own work on bytes already received:
  copying and parsing what came in the header block's record, and reading and decrypting
  any record after it. Its wall time was not a network number.
- **Send on a reused connection:** five times a new connection's, all of it CPU. It is the
  first write after a 200 ms sleep, with cold caches.

The numbers will differ by instance type, which is why every request carries them.

### A real exchange

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
| A fake `ASIA` key ID with a fake session token | `HTTP/1.1 400 Bad Request`, `InvalidToken`, "The provided token is malformed or otherwise invalid.", chunked, `Connection: close` | 550 to 570 B, withheld by the rule |
| A fake `AKIA` key ID, no token | `HTTP/1.1 403 Forbidden`, `InvalidAccessKeyId`, "The AWS Access Key Id you provided does not exist in our records.", chunked | 374 B, withheld by the rule |

`error_fields` kept the code, message and IDs in both cases. No byte of the fake
credentials reached stdout or stderr. That build printed an error body of at most 4 KiB when
it passed the rule; today's prints none (see "What is recorded").

Two requests with curl's own SigV4 showed why the bodies were withheld. The `InvalidToken`
body carries the token in `<Token-0>`; the `InvalidAccessKeyId` body carries the key ID in
`<AWSAccessKeyId>`. The study's proposed rule (withhold on twelve digits or an AKIA/ASIA key
ID) would have printed the token.

**One counted request over a new connection,** from that build, with this machine's
address removed and the fingerprints shortened. Today's binary writes the same events, with
one more field, `sessions_received`, in `connection_closed`; its `name_resolved` is read
after the reply is parsed and its `response_headers` before any body byte is handled, so on
the same request each would be a microsecond or two later and earlier respectively:

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

## How it works

The design is the study in the first comment of the step-5 brief (#43). Where this differs,
the reasons are in "Departures from the study", now in
[`docs/dev-log.md`](../../docs/dev-log.md), section 8.

### One request's events

Over a new connection, in stream order. The request's lines are written once it has ended
(with its body checked), so a binary that dies mid-request leaves none of them.

| Event | Fields besides `t` |
|---|---|
| `sample_started` | `sample`, `warmup`, `repetitions` (1) |
| `name_resolved` | `request`, `server`, `name`, `reply_bytes` (the datagram's real length), `reply_bytes_read` (only when the 4096-byte buffer held less), `rcode`, `truncated` (the TC bit), `answers`, `authority` and `additional` (each record as `<owner> <ttl> <TYPE> <data>`; the last two when the reply has them), `trailing_bytes` (bytes after the last record, when there are any), `address` (the one used: the first A record of the end of the CNAME chain), `cpu_ns` |
| `connection_opened` | `connection`, `request`, `address`, `port`, `nodelay` (read back), `local`, `cpu_ns` |
| `connection_secured` | `connection`, `tls`, `cipher`, `group`, `peer_signature`, `alpn`, `hello_retry`, `resumed`, `verify`, `peer_chain_sha256` (each certificate as sent, leaf first, all of them), `cpu_ns` |
| `certificate` | `sha256`, `der_base64`, the first time a fingerprint appears in the Run |
| `request_sent` | `request`, `connection`, `method`, `target`, `request_bytes`, `headers` (as sent, in order, with credential values withheld), `signing` (`algorithm`, `credential_scope`, `signed_headers`), `cpu_ns` |
| `first_byte` | `request`, `cpu_ns` |
| `response_headers` | `request`, `status_line`, `status`, `headers` (`[[name, value], …]`, in order; each value without the optional whitespace around it, as RFC 9110 defines a field value), `cpu_ns` |
| `response_ended` | `request`, `bytes` (the body, de-chunked), `wire_bytes`, `framing`, `trailers` (as `headers`, when a chunked body has any), `cpu_ns`, `tcp_info`; for 2xx `body_sha256`, `fixture` and `s3_checksum`; otherwise `error_fields` and `error_elements` (see "What is recorded") |
| `request_failed` | instead of the response's remaining events: `request`, `phase`, `error`, `detail`, and what had arrived (below) |
| `sample_ended` | `sample` |
| `connection_closed` | `connection`, `reason`, `requests`, `sessions_received`, `session_tickets_received` |

#### Where each clock is read

The binary reads the clock (`CLOCK_MONOTONIC_RAW`, and the thread's CPU clock beside it) at
these points and nowhere else inside a sample:

| Event | Its `t` is read | What that moment is |
|---|---|---|
| `sample_started`, new connection | just before the DNS query's `send`, after the UDP socket, the TCP socket, the TLS object and the request (signed with `auth` `sigv4`) are made and the budget is checked | nothing of the request has left the program |
| `sample_started`, reused connection | just before the request's `SSL_write`, after the idle check, any reopening and the budget check | the same |
| `name_resolved` | after `recv` returned the reply and the reply was parsed and judged (its ID, question, TC bit, rcode, and an A record at the end of the CNAME chain) | the program knows the address to connect to, or that the reply gives none. Formatting the records as text waits until the request has ended |
| `connection_opened` | just after the blocking `connect` returns, whether it succeeded or failed (refused, unreachable, or not established within `timeout_ms`) | on success, the kernel has the server's SYN-ACK and has sent its ACK: TCP is established on our side. On failure, `connect` has said so; `nodelay` and `local` are then absent, and the `request_failed` (or `connection_failed`) that follows has the same `t` |
| `connection_secured` | just after `SSL_connect` returns 1 | our side of the handshake is done: the server's Finished is verified and ours is written. The server may not have read ours yet |
| `certificate` | the same read as `connection_secured`, or as the failure that refused the chain | |
| `request_sent` | just after `SSL_write` of the whole request returns | the encrypted request is in the kernel's send buffer, not necessarily on the wire. Written only when the write succeeded |
| `first_byte` | just after the first `SSL_read` that returns more than 0 | the first decrypted bytes of the response are available to the program. The library has read and decrypted the whole first TLS record by then (and any post-handshake messages before it); this is not the arrival of the first byte from the network |
| `response_headers` | just after the parser has taken the blank line that ends the header block, and parsed the block, before any body byte of the same read is handled | the program has the whole header block |
| `response_ended` | after the read that completed the body (`Content-Length` reached, the chunked terminator and any trailers, or close_notify for a body framed by the connection's end) has been handled, and after the look for bytes beyond it | the program has the whole body |
| `request_failed` | just after the call that failed returns, or as soon as the parser stops at the byte that breaks the response, or the bytes beyond the response are found. The clock is read before anything is made of the failure: a failed TLS call keeps only what the library returned and `errno`, and is classified, with its words formatted, after the read | the failure is known. For a failed `send`, `recv`, `connect` or TLS call, the moment that call returned |
| `sample_ended` | the same read as `response_ended` or `request_failed` | |
| `connection_closed` | after `close` returns, outside the sample | |

Over a reused connection, `name_resolved`, `connection_opened`, `connection_secured` and
any `certificate` come before the sample that first uses the connection, outside any sample
and without `request`. Each sample is `sample_started`, `request_sent`, `first_byte`,
`response_headers`, `response_ended` (or `request_failed`), `sample_ended`. Before each
sample the binary looks at the idle connection without blocking. If the server has closed
it (`eof_while_idle`, `close_notify_while_idle`), sent anything (`data_while_idle`) or reset
it (`error_while_idle`), the binary writes `connection_closed` and opens a new connection
outside the sample. A setup that fails outside a sample is `connection_failed` (`phase`,
`error`, `detail`, and the refused chain's fingerprints when it was the TLS phase) and makes
no request.

`connection_closed.reason`: `done` (new: after its one request), `server_requested` (the
response said `Connection: close`, or was HTTP/1.0), `failed` (after a failed request), the
four idle reasons above, `end_of_run`. `sessions_received` counts the sessions the server
offered, `session_tickets_received` those that came as a ticket. Under TLS 1.3 every session
is a ticket; under TLS 1.2 a server may offer a session by its Session ID alone, which is a
session and not a ticket.

#### The phases

| Phase | Interval | Includes, besides the network and the server |
|---|---|---|
| DNS | `name_resolved` − `sample_started` | the `send` and `recv` system calls, and parsing the reply (microseconds) |
| TCP | `connection_opened` − `name_resolved` | closing the UDP socket, the `connect` system call |
| TLS | `connection_secured` − `connection_opened` | our side of the handshake: key generation, certificate verification (see "What our CPU contributes") |
| Send | `request_sent` − `connection_secured` (reused: − `sample_started`) | encrypting and writing the request |
| First byte | `first_byte` − `request_sent` | reading and decrypting the first record (at most 16 KiB) and any post-handshake messages (S3 sends none) |
| Headers | `response_headers` − `first_byte` | 0 to microseconds: the header block usually arrives in the first read; parsing it |
| Body | `response_ended` − `response_headers` | copying and parsing the body bytes that came in the header block's own record (already decrypted, before `first_byte`), and every later read with its decryption |
| Transfer | `response_ended` − `first_byte` | Headers and Body together, the study's transfer |
| Total | `sample_ended` − `sample_started` | |

The socket, the TLS object, the DNS query and the request (signed with `auth` `sigv4`) are
all made before the sample starts. Each phase event's `cpu_ns` is this thread's CPU time
(`CLOCK_THREAD_CPUTIME_ID`) over that phase alone, from the previous boundary of the same
request to this one. Reading that clock costs a system call at every boundary;
`observed.cpu_clock_read_ns` is its measured cost, about 0.34 µs on the dev machine.

#### Failures

`request_failed.phase` is `dns`, `connect`, `tls`, `send`, `first_byte`, `headers` or
`body`: where the request was when the failure was seen. `headers` means the header block
never completed or did not parse; once it has, a failure is in `body`. `error` is one of:

- `dns`: a reply came but cannot be used. Its rcode is not NOERROR, its TC bit is set, it has
  no A record for the name, it does not parse, or its ID or question is not the query's.
- `timeout`: nothing came within `timeout_ms`.
- `refused` or `unreachable`: `connect` said so.
- `reset`: the connection was reset.
- `eof`: the connection ended early, with close_notify or with TCP alone; `detail` says which.
- `alert`: the server sent a fatal TLS alert. `alert` is its code (RFC 8446 section 6) and
  `alert_name` the library's name for it, such as 40 and "handshake failure".
- `verify`: the certificate check ran on the server's chain and failed (another CA, another
  name, expired). Only then: the library's verification result reads as an error until a
  chain has been checked, so it is consulted only when the library's own error says the
  check failed.
- `tls`: our side of TLS found something wrong: a reply that is not TLS, a version or suite
  we do not offer, a malformed message, a bad record.
- `protocol`: the response broke HTTP/1.1. That covers folding, a bare CR or LF, a header
  block over 64 KiB, disagreeing `Content-Length` values, a transfer coding other than
  chunked, an interim 1xx response, a malformed chunk or trailer line, a body larger than
  the buffer, or bytes after the response's end (see "Bytes after a response"). A body may
  fill the buffer exactly, in any framing; for one framed by the connection's end the binary
  reads on to find the end, and only a further body byte makes it too large.
- `system`: another error from the kernel.

`detail` is the library's or the kernel's words. For TLS failures the library's own error
decides the `error`, in this order: an alert received, then a failed certificate check, then
an early end of the connection; anything else is `tls`.

What had arrived is kept:

- `bytes_received`: what the parser took of the response, the header block and the body as
  framed (chunk framing and trailers included), up to the byte where it stopped. The same
  response gives the same count however it was split into reads.
- `surplus_bytes`: bytes found beyond the response's end, for that failure.
- `head_received`: the header block as received, when it never completed or did not parse.
  A block that completed and parsed is a `response_headers` event, whatever follows.
- `content_length`, `body_bytes_received`: when the headers had completed; and for a 2xx
  status `body_sha256_received`, the digest of what had arrived (an error body leaves no
  digest, see below).
- `trailers`, the trailer lines already read and checked when a chunked response fails
  after them (bytes after its end, or a later trailer line that breaks the rules).
- `peer_chain_sha256`, after a failed handshake whose server had sent its certificates: the
  fingerprints of the chain it showed, each new certificate also a `certificate` event, so a
  reader can tell which chain was refused.
- `tcp_info`.

A DNS reply that cannot be used is still in `name_resolved`, its records included, before
the failure.

#### Bytes after a response

Bytes that arrive in the same TLS record as the end of a response, after its
`Content-Length` body or its chunked terminator, were received with it. They make that
request fail with `protocol`, phase `body`, `surplus_bytes` saying how many; the response's
headers and body are kept as for any body failure.

Bytes in a later record are not looked for at the end of a response. On a new connection
nothing reads them: the connection is closed. On a reused one, the look at the idle
connection before the next request finds them, and the connection is closed
(`data_while_idle`) and opened again outside the sample. What cannot be told apart: bytes
that the server sends late, after that look and before the next request is written, are read
as the start of the next response, and that request fails, though the bytes may belong to
the one before. The look happens after the pause between requests, so a server would have
to send them hundreds of milliseconds after its response for this to happen.

#### What ends a Run early

Nothing retries. Every request is attempted, with two exceptions, after which the Run goes
straight to its closing `observed`, `verified` and `finished`:

- **The budget.** No request starts once `budget_seconds` have passed. They are counted
  from just before the first request is prepared: its signing with `auth` `sigv4`, its
  socket and TLS object,
  and over a reused connection the first opening of that connection, all fall inside the
  budget. A first lookup or handshake that takes the whole budget therefore leaves a Run
  that made no request. The budget is asked immediately before every sample starts, after
  any reopening of a kept connection, as well as before each pause.
  Waiting is bounded: the last request can still take a few `timeout_ms` (the DNS reply,
  `connect`, the handshake, and then each read). A server that sends one byte just inside
  every `timeout_ms` is not cut off; the runner's timeout is the backstop. The schedule's
  `timeout_seconds` should be at least `budget_seconds` plus a minute.
- **Nothing reachable.** Ten requests in a row (or ten reused-connection setups) end without
  a TLS session: DNS, `connect` or the handshake failed every time. A server that answers,
  with any status, resets this count. A 503 storm is therefore recorded in full. At about 5
  requests a second that is 1/1000 of what one prefix supports.

`observed.ended_early` says which (`budget`, `unreachable`, or null), and
`requests_not_made` how many requests were not made. Such a stream can have fewer counted
samples than `LM_SAMPLES`, and then fails `check-events.py --samples N` on purpose, and the
exit code is 4.

#### Exit codes

| Code | When |
|---|---|
| 0 | Every request returned 2xx with a body that matches the Fixture and S3's SHA-256 checksum |
| 1 | A 2xx body did not match the Fixture (`fixture` `mismatch`), or S3's checksum was wrong or absent (`s3_checksum` `mismatch` or `absent`): every event is kept, `observed.body_mismatch` is true. Also any fatal setup error before the first sample (an unreadable CA file or resolver file), as `lm_die` does |
| 2 | A bad parameter or Service input (`lm_usage`), after `started` alone |
| 3 | stdout could not be written |
| 4 | The Run completed, but a request failed, a status was not 2xx, a reused connection could not be set up, or the Run ended early |

Method version 1 counts only exit 0. A Method that reads requests one by one can take the
good requests of an exit-4 Run.

### What is recorded, what is withheld, and why

**Verbatim:**

- every DNS record of the reply, in all three sections, in order, with its TTL;
- the address and port connected to, and the local address;
- the TLS version, cipher, group, peer signature algorithm and ALPN negotiated;
- the SHA-256 of each certificate exactly as the server sent it, and each new certificate's
  DER once per Run, for an accepted chain and a refused one;
- the request as sent, except credential values;
- the status line and every response header and trailer, in order, S3's request IDs and
  checksums included. A field's value is kept without the optional whitespace (spaces and
  tabs) around it, which is not part of the value in HTTP; whitespace inside it is kept;
- the body's length, and for a 2xx response its SHA-256.

**Never printed:** the access key ID (it maps to the account), the secret key, the session
token, and every signature. `Authorization` and `x-amz-security-token` appear in
`request_sent.headers` with the value `<withheld>`. What the signature covered is in
`signing`: the scope (date, Region, service) and the signed header names, which the binary
built from nothing secret.

**An error body** (a status that is not 2xx) is not printed. The Run gets its length
(`bytes`), and from it only:

- `error_fields`: S3's `Code`, `Message`, `RequestId` and `HostId`, each the first such
  element's text, each under the rule below on its own;
- `error_elements`: the name of every element, in order, without its value (at most 64,
  with `error_elements_total` when there were more), each name under the rule too.

Not its digest: a digest of a short text can be searched for the account ID it hides. The
`verified` checksum is made from 2xx bodies alone for the same reason. Real S3 sends a lot
back in error bodies: its `InvalidToken` body holds the whole session token, its
`InvalidAccessKeyId` body the key ID (see "A real exchange"), and its `SignatureDoesNotMatch`
body the canonical request, which holds the token, both as text and as hexadecimal bytes.

**Anything else received** (a header or trailer, the status line, a header block that never
completed, a DNS record, a certificate, each error field and element name) is written only
if it passes the rule. The rule is applied once, by `lm_lines.c`, both to the bytes and to
the exact text that would be written for them (a JSON string with its escapes, or base64 for
bytes that are not UTF-8 or hold a NUL). It fails when either holds:

- one of our credentials or signatures, ignoring case, in any of these forms: as it is;
  percent-encoded (only the reserved bytes, or every byte); base64 or base64url, at each of
  the three alignments it can have inside a longer encoded text; hexadecimal, upper or lower
  case, bare or with a space, colon or hyphen between bytes. Each is also searched for with
  every byte up to 0x20 (spaces, line breaks, NULs) taken out, which finds a value split by
  them, or written in UTF-16;
- something shaped like an access key ID: `AKIA` or `ASIA` and sixteen more capitals or
  digits;
- a number of exactly twelve digits standing alone (an account ID, as in
  `arn:aws:sts::123456789012:`). Digits inside a hex or base64 value touch letters, and are
  not one: real S3 sent an ETag that the stricter "twelve digits anywhere" withheld.

Something that fails becomes `{"withheld_bytes": n}`, with no digest, and the line and the Run
go on. `observed.fields_withheld` counts them.

**What the rule guarantees, and what it does not.** No line written after the credentials
are read holds a byte string equal to one of our credentials or signatures, in any of the
forms above: the guard below makes sure of that whatever the rule decided. (`started`, the
only line before, is the program's own text.) Our credentials sent back in another encoding
are not recognised: XML character references (`&#x2F;`), JSON escapes (`\/`), a value split
by a printable character, compressed, encrypted, or encoded twice. A key ID or an account
ID that is not ours is recognised only by its shape, written plainly: one that is split,
encoded or reversed passes. The error-body allow-list is what keeps S3's own error bodies
out; the rule is the second layer, for the fields that are printed.

**The guard.** Behind the rule, `lm_lines.c` searches each line it is about to write for
every registered secret, in the same forms. A line that holds one (only a secret put
together from two fields, or a mistake in the program, could get there) is not written; in
its place goes `{"event":"line_withheld","t":<its t>,"withheld_event":<its name>,"withheld_bytes":<its length>}`,
and the Run goes on, its stream valid. `observed.lines_withheld` counts them. A credential
any of whose forms could appear inside a `sample_started`, `sample_ended`, `verified`,
`line_withheld` or `finished` line (one made of digits alone, say) is refused at the start
as a usage error, so the lines the stream's order depends on are never the ones withheld,
and `finished`, which `lm.c` writes past the guard, cannot hold one. A secret key
or token shorter than 16 characters is refused too, because something that short could turn
up by chance (inside a certificate's base64, say). stderr carries only fixed messages and
parameter values, never a Service input.

**Memory.** Before it reads the credentials, the binary sets its core-file size limit to
zero and marks itself not dumpable (`prctl(PR_SET_DUMPABLE, 0)`): a crash leaves no core
file, and no other process of the same user can read its memory.

### Checking the body, and the elision guard

Outside every timed interval:

- **Before the first sample:** the binary computes the Fixture's SHA-256 for `object_bytes`
  (`observed.fixture_sha256`). The pattern is `benchmarks/harness/c/lm_fixture.h`'s: the
  64-bit little-endian word at offset o is `mix64(o ^ 0x8d6d2f9d5f9d1b37)`.
- **After each 2xx response that ends without a failure:** it hashes the de-chunked body.
  `fixture` is `match` when the length and digest are the Fixture's. `s3_checksum` is `match` when `x-amz-checksum-sha256`
  (requested with `x-amz-checksum-mode: ENABLED` on every request) is that digest in base64.
  Every verified body therefore matches every other.

`verified` is the first 64 bits of one SHA-256 over every complete 2xx response's body
digest, in order. Error bodies are left out: nothing derived from them is printed.

### TLS

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

- `SSL_VERIFY_PEER` against `ca_file`, the host name checked against the certificate's
  subject alternative names only: a certificate with none is refused, never matched by its
  common name.
- The binary owns the socket and hands it to the library (`SSL_set_fd`).
- Read-ahead is off, the library default: each record is read in two system calls.

**Two notes on the library:**

- AWS-LC reads `OPENSSL_ia32cap` from the environment to override CPU features. The runner
  passes only `LM_*` variables, so it is never set.
- The link warns that AWS-LC's socket BIO references `getaddrinfo`. Nothing calls it: the
  binary resolves names itself.

### Size of a Run's stream

| | Per request | 200 counted requests and the warmup, against the stand-in (measured) | Projected for S3 |
|---|---|---|---|
| New connections | 3.1 KB stand-in, 3.5 KB S3 | 620,502 B | about 725 KB |
| Reused connection | 2.0 KB | 406,310 B | about 414 KB |

Measured on 2026-11-11 with this build, 4 KiB objects, signed requests; the same Runs with
the build before the reviews' fixes were 616,036 B and 406,612 B. The difference is
`sessions_received` in every `connection_closed` (about 22 B per connection), less the
error bodies no longer printed.

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

## Building and testing

```bash
# AWS-LC's source is not in git: fetch the pinned archive once, then build.
benchmarks/harness/c/vendor/fetch-aws-lc.sh /path/to/aws-lc.tar.gz
make -C benchmarks/http_get AWS_LC_ARCHIVE=/path/to/aws-lc.tar.gz   # build/static/http_get
```

The first build unpacks the archive (336 MB) and builds AWS-LC into `build/aws-lc` (28 MB).
Later builds, `make -B` included, reuse it as long as the archive, flags and compilers are
the same. `make clean` leaves it. A run against S3 needs the Service inputs below; the
tests run it against a local stand-in (see "Testing").

### Service inputs

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

### Building it

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

### Testing

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
- a certificate from another CA, one for another name, one with no subject alternative
  name, and a chain with eleven unrelated certificates after it;
- TLS 1.2 with and without a session ticket;
- five servers that fail the handshake: an HTTP reply, a fatal alert, a TLS 1.1 ServerHello,
  no suite in common, a ServerHello cut short;
- NXDOMAIN, a truncated reply, no reply, a reply with authority and additional sections, and
  one longer than the 4096-byte buffer;
- a refused connection;
- `Connection: close`, and closes while idle; a lookup answered late, to spend the budget
  while a kept connection is reopened;
- one response of each kind (good, short, each body error) written in one write, in two,
  and one byte per record, which must give the same events but for the clocks;
- bytes after a response, in its last record and in a later one;
- trailers, a header value with whitespace around it, a NUL in a header;
- the key ID, token and signature sent back in hex, base64, base64url and percent-encoded
  forms, S3's `SignatureDoesNotMatch` body with the canonical request in hex, and inputs where
  the bytes hold no secret but the text written for them would.

Every stream must pass `scripts/check-events.py`, `methods/v1/stream.ts` and the event
schema, have no `t` of 0, and have its events in time order inside each sample. Every stream
and stderr is searched for the test credentials and for every signature the stand-in
received.

A failed write is injected with `tests/http-get/fail-write.c`, a shim loaded with
`LD_PRELOAD` into the dynamic build that fails the Nth write to a TCP socket. A test reads
`/proc/<pid>/limits` and the ownership of `/proc/<pid>/environ` of a running binary for the
core-file limit and the dumpable flag. `LM_HTTP_GET_BINARY` runs every stream test against
another build, such as the sanitizer build; any sanitizer report fails the test.

The test driver checks the parts directly:

- SigV4 against AWS's test suite (the cases in `tests/http-get/sigv4/`, from aws-c-auth),
  the S3 User Guide's two examples, and a signature computed in the test with
  `node:crypto`;
- the DNS builder and parser: compression, CNAME chains in any order, truncation, bad
  pointers, the additional section, bytes after the last record;
- the HTTP parser: where it stops at the end of the header block, trailers, a body larger
  than the buffer however it is fed;
- the event lines: UTF-8 and NUL, the decision on the text written, each registered
  encoding of a secret, the line guard's replacement, the refusal of a secret that could be
  read in the stream's own lines.

`scripts/check-scratch.py` runs the study's five sets in a `FROM scratch` container
against the same stand-in.

### What the runner and the stage must provide

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
