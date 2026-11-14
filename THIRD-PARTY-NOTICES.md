# Third-party notices

LedgerMath's own code is licensed under the Apache License 2.0: [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE). The Runs it publishes are licensed separately, under CC BY 4.0, by the
Runs repository, whose statement is kept here as
[`docs/runs-repository/README.md`](docs/runs-repository/README.md).

This file lists what comes from other projects: what is in this repository, and what is
inside the benchmark binaries LedgerMath builds and publishes. For each it says what it is,
where it is used, its licence, and, where the licence requires them to travel with it, its
copyright notice and licence text. It records where things came from. It is not legal
advice.

1. [In this repository](#1-in-this-repository): napkin-math; AWS C Auth's SigV4 test
   cases; mattpocock/skills; Linux's `statx` declarations; AWS's data in test fixtures
2. [In the published benchmark binaries](#2-in-the-published-benchmark-binaries): the GNU
   C Library; GCC's runtime library; AWS-LC
3. [JavaScript packages](#3-javascript-packages)
4. [What is not listed](#4-what-is-not-listed)

## 1. In this repository

### napkin-math

napkin-math, <https://github.com/sirupsen/napkin-math>, by Simon Eskildsen, under the MIT
License (notice and text below). LedgerMath began as a port of its benchmarks to C
([`docs/initial-benchmark-plan.md`](docs/initial-benchmark-plan.md),
[`docs/prds/`](docs/prds/README.md)). How much of each benchmark came from it differs:

- **Translated from napkin-math's code.** `benchmarks/memory_read/memory_read.c` and
  `benchmarks/c/bench_memory_read.c` (in July's retired proof of concept, `benchmarks/c/`)
  are C translations of napkin-math's
  `benches/benchmarks/memory_read.rs`: the scalar read loop (x86 assembly, instruction for
  instruction), the AVX2 read loop with four accumulators and its reduction, and the pool of
  pinned threads that each fill their own slice, meeting at one barrier once their slices
  are filled and at two around every pass.
- **Ported, with the code written anew in C.**
  `benchmarks/memory_read_random/memory_read_random.c` and July's
  `benchmarks/c/bench_memory_read_random.c` keep the design of napkin-math's
  `memory_read_random` (`src/main.rs`): 64-byte elements, each read once in a shuffled
  order, with `madvise(MADV_RANDOM)` on the data and `madvise(MADV_SEQUENTIAL)` on the
  order. `benchmarks/compressed_memory_read/compressed_memory_read.c` and July's
  `benchmarks/c/bench_compressed_memory_read.c` keep the shape of napkin-math's
  `compressed_memory_read` benchmark: one block of the values 0 to 255 at 8 bits, a pool of
  1,000,000 blocks, 1,024 bytes unpacked per block. napkin-math's benchmark calls the
  `bitpacking` crate; none of that crate's code is here.
- **The subject only.** `memory_write`, `syscall`, `hash`, `sort`, `mutex`, `tcp_echo`,
  `disk_write`, `disk_read_sequential`, `disk_read_random` and `disk_read_io_uring` (and
  their July versions in `benchmarks/c/`) measure what a napkin-math benchmark of the same
  subject measured, some with its sizes or its system calls. Their code is LedgerMath's, and
  each one's README says how its method differs. `http_get` has no counterpart in
  napkin-math.

This notice travels with the files of the first two groups:

```
The MIT License

Copyright (c) 2019 Simon Eskildsen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### AWS C Auth: SigV4 test cases

`tests/http-get/sigv4/` holds 15 cases (75 files) of AWS's Signature Version 4 test suite
as published in AWS C Auth, <https://github.com/awslabs/aws-c-auth>, in its directory
`tests/aws-signing-test-suite/v4/`. On 2026-11-14 every one of the 75 files was byte for
byte the same as on aws-c-auth's `main` branch, where that directory last changed in commit
`3281f8692e6fd10562c4585a4dded5c16b322698`. `tests/http-get.test.ts` checks
`benchmarks/harness/c/lm_sigv4.c` against them; they are not part of any binary.

Licence: Apache License 2.0, the same text as [`LICENSE`](LICENSE). AWS C Auth's `NOTICE`
reads:

```
AWS C Auth
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0.
```

### mattpocock/skills

`docs/agents/domain.md`, `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`
and the "Agent skills" section of `CLAUDE.md` were made on 2026-08-08 from the templates of
the setup skill of mattpocock/skills, <https://github.com/mattpocock/skills>, and have been
edited since. Licence: MIT License.

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Linux's `statx` declarations

`benchmarks/harness/c/lm_disk.c` declares the `statx` structure (`struct lm_statx`,
`struct lm_statx_timestamp`) and the masks it asks for (`LM_STATX_BASIC_STATS`,
`LM_STATX_BTIME`, `LM_STATX_MNT_ID`, `LM_STATX_DIOALIGN`) following Linux 6.1's
`include/uapi/linux/stat.h`: the same fields in the same order, with the same padding and
the same mask values, under other names. `LM_AT_EMPTY_PATH` has the value of `AT_EMPTY_PATH`
in Linux 6.1's `include/uapi/linux/fcntl.h`. Both headers are marked
`SPDX-License-Identifier: GPL-2.0 WITH Linux-syscall-note`. The text of that note, in the
kernel's `LICENSES/exceptions/Linux-syscall-note` at tag v6.1, begins:

```
   NOTE! This copyright does *not* cover user programs that use kernel
 services by normal system calls - this is merely considered normal use
 of the kernel, and does *not* fall under the heading of "derived work".
```

and the same file says the note "is used together with one of the above SPDX-Licenses to
mark user space API (uapi) header files so they can be included into non GPL compliant user
space application code". `lm_disk.c` uses the structure to call the `statx` system call
directly.

### AWS's data in test fixtures

AWS's own published data, reproduced as AWS published it, for the tests. LedgerMath's
licence does not cover it, and LedgerMath claims no rights in it.

- `tests/samples/prices/sources/`: excerpts of AWS's Price List offer files for
  `us-east-2`, each record byte for byte, with AWS's header and disclaimer; and
  `tests/samples/prices/repository/prices/2026/11/11/aws.json`, a price file cut from them.
  [`tests/samples/prices/README.md`](tests/samples/prices/README.md) says how they were
  made.
- `scripts/box-in-container/ec2/*.json`: the records the EC2 API's `DescribeInstanceTypes`
  gave for three instance types.
- `packages/shared/src/utils/aws-ec2-instance-types.ts`, `aws-regions.ts` and
  `aws-zones.ts`: lists of AWS's names for instance types, Regions and zones.

## 2. In the published benchmark binaries

Every benchmark binary is built on a box from this repository, at boot, and kept in the
bucket under the hash of its bytes. Every Run names its binary (`binary.blob`) and the
source archive it was built from (`source`), and records the compiler and the commands the
build ran (`binary.compiler`, `binary.command`). Every benchmark has a static build, linked
with `gcc -static`, so its binary contains parts of the libraries below. `memory_read` also
has a dynamic build, which loads the C library at run time: the only parts of these
libraries in that file are the start-up files of glibc and GCC and one object of GCC's
runtime library.

What is in which binary was read from link maps on 2026-11-14. Each of the 14 benchmarks
was built with `make BUILD=static`, and `memory_read` also with `BUILD=dynamic`, in Amazon
Linux 2023 release 2023.12.20260710.0 with the packages a box installs (gcc
11.5.0-5.amzn2023.0.5, glibc-static 2.34-231.amzn2023.0.4, binutils 2.41; `http_get` with
AWS-LC built as its lock says). Each was then linked again with `-Wl,-Map`, which gave the
same bytes. Every glibc object a map lists was matched by name to its source file in glibc
2.34 (with Amazon Linux's patches checked for files they add). The header of each such file,
and the headers it includes, were searched for any notice other than the Free Software
Foundation's, and every file found was read. The boxes' own binaries were not mapped: their
`-march=native` resolves on their own processors, which can change a binary's own code and,
in principle, which library objects it needs.

### The GNU C Library (glibc)

**LedgerMath's benchmark binaries use the GNU C Library, and the library and its use in them
are covered by the GNU Lesser General Public License, version 2.1 or later**, whose text is
[`third-party/glibc-2.34/COPYING.LIB`](third-party/glibc-2.34/COPYING.LIB). Some of the
library's files carry other notices as well. glibc collects them in
[`third-party/glibc-2.34/LICENSES`](third-party/glibc-2.34/LICENSES), and asks that the file
be distributed with any binary built from the library. Which of them concern which binary is
below. Both files are glibc 2.34's own, byte for byte: they are the same in glibc's git at
tag `glibc-2.34`, in GNU's release tarball `glibc-2.34.tar.xz`, and in Amazon Linux's source
package, none of whose patches changes them.

- **Where**: every static benchmark binary contains parts of glibc's `libc.a`; `http_get`
  also two objects of its `libm.a`. Every binary, the dynamic `memory_read` included,
  contains glibc's start-up files (below).
- **Version**: 2.34, as Amazon Linux 2023 builds it. The boxes boot the image pinned in
  `infra/runs/stack.ts` (`ami-03499a87bbb39a09a`, Amazon Linux 2023 release
  2023.12.20260710.0) and install `glibc-static` from that release's repository, where the
  newest is `glibc-static-2.34-231.amzn2023.0.4.x86_64`. The sample Runs in
  `tests/samples/`, built in a container of that release, record that package. Each Run's
  dump records the exact package its binary was built with (section `packages`).
- **Corresponding source**: Amazon Linux 2023's source package
  `glibc-2.34-231.amzn2023.0.4.src.rpm`, 19,983,463 bytes, SHA-256
  `5c14047c719844c616626f2c139ae5b4fb19023762407565e824186e5812f9cf`. It holds GNU's release
  tarball `glibc-2.34.tar.xz` (SHA-256
  `44d26a1fe20b8853a48f470ead01e4279e869ac149b195dda4e44a195d981ab2`), the patches Amazon
  Linux applies, and the spec file that applies them. It is offered from the same place as
  the binaries: in the bucket that holds them, as the blob
  `blobs/sha256/5c14047c719844c616626f2c139ae5b4fb19023762407565e824186e5812f9cf`, which
  `scripts/publish-third-party-source.ts` puts there from
  [`third-party/sources.lock.json`](third-party/sources.lock.json). It is also at Amazon
  Linux's own address,
  <https://cdn.amazonlinux.com/al2023/blobstore/5c14047c719844c616626f2c139ae5b4fb19023762407565e824186e5812f9cf/glibc-2.34-231.amzn2023.0.4.src.rpm>.
- **Relinking with a modified glibc**, as section 6 of the licence provides for: the source
  of everything else in a static binary is public. The Run names the source archive, which
  holds the benchmark's source and its `Makefile`, and records the compiler and the exact
  commands the build ran. AWS-LC's source archive is a blob too (below), and the image is
  pinned. Compile the same sources the same way, then link them against the modified library.
- Amazon Linux's source package declares, for everything it builds (programs not linked into
  the benchmarks included): "LGPLv2+ and LGPLv2+ with exceptions and GPLv2+ and GPLv2+ with
  exceptions and BSD and Inner-Net and ISC and Public Domain and GFDL".

**Start-up files.** `crt1.o`, `crti.o` and `crtn.o` are glibc's (package `glibc-devel`),
and every binary contains them. `crt1.o` is made from `sysdeps/x86_64/start.S`,
`sysdeps/x86/abi-note.c`, `csu/init.c` and `csu/static-reloc.c`; `crti.o` and `crtn.o` from
`sysdeps/x86_64/crti.S` and `sysdeps/x86_64/crtn.S`. All are under LGPL-2.1-or-later.
`start.S`, `abi-note.c`, `crti.S` and `crtn.S` add: "In addition to the permissions in the
GNU Lesser General Public License, the Free Software Foundation gives you unlimited
permission to link the compiled version of this file with other programs, and to distribute
those programs without any restriction coming from the use of this file." `csu/init.c`
holds one constant (`_IO_stdin_used`) and `csu/static-reloc.c` at most an empty function;
those two carry the licence without that sentence. GCC's own start-up files are listed under
GCC below.

**The notices of `LICENSES` in each binary**:

| Binaries | Notices of `LICENSES` | Linked files of glibc 2.34 that carry them |
|---|---|---|
| Every static binary (all 14) | The 4.4 BSD licence of the Regents of the University of California | `libio/filedoalloc.c` and `libio/wfiledoalloc.c` (stdio's buffers), `gmon/prof-freq.c` |
| `memory_read`, `mutex`, `tcp_echo`, `http_get` | Also those of the DNS resolver taken from BIND 4.9.5: UC Berkeley (the same 4.4 BSD licence), Digital Equipment Corporation and Internet Software Consortium | `resolv/res_init.c`, `resolv/res-close.c`, `resolv/res_randomid.c`, `resolv/inet_addr.c`, `resolv/res_libc.c`, `resolv/inet_pton.c`, `resolv/inet_pton_length.c` (added by one of Amazon Linux's patches), `inet/inet_mkadr.c`. In `memory_read`, `mutex` and `tcp_echo`, `pthread_create` refers to the resolver's per-thread state, which brings them in; in `http_get`, `getaddrinfo` does |
| `http_get` | Also Craig Metz's Inner Net License, Version 2.00 | `sysdeps/posix/getaddrinfo.c`. AWS-LC's socket helper refers to `getaddrinfo`, so the link brings it in (and warns about it); nothing in `http_get` calls it, because the binary resolves names itself |
| `http_get` | Also Sun fdlibm's | `sysdeps/ieee754/dbl-64/s_log1p.c` (`log1p`, which draws the gaps between requests) |
| `http_get` | More of the resolver's (UC Berkeley, DEC, ISC) | `resolv/inet_ntop.c`, `inet/inet_net.c`, `resolv/dn_expand.c`, `resolv/dn_skipname.c`, `resolv/res_mkquery.c`, `resolv/res_query.c`, `resolv/res_send.c`, `resolv/res-name-checking.c`, `resolv/res_context_hostalias.c`, `resolv/res_nameinquery.c`, `resolv/res_queriesmatch.c`, `resolv/nss_dns/dns-host.c`, `resolv/nss_dns/dns-network.c`, `nss/nss_files/files-hosts.c` (which includes `resolv/mapv4v6addr.h`, added by one of Amazon Linux's patches), and the nine `resolv/ns_*.c` below |

The individual files give their own years in these notices (for example "Copyright (c)
1985, 1989, 1993" for UC Berkeley in `resolv/res_init.c`); `LICENSES` gives one form of each.
No file under the other notices of `LICENSES` is linked into any binary: Sun RPC (Oracle
America), CMU's for Mach and for `if_ppp.h`, Intel's for the Itanium mathematical functions,
Eric Young's DES, the WIDE Project's `rcmd`, Tom Lord's, Henry Spencer's, the University of
Cambridge's PCRE tests, and Stephen L. Moshier's long double functions. Headers under the Sun
RPC notice are read when some linked files are compiled (`<netdb.h>` includes
`rpc/netdb.h`; `malloc/thread-freeres.c` includes `rpc/rpc.h`), for their declarations.

**Notices in linked files that `LICENSES` does not reproduce**, as the files have them, all in
`http_get`:

`resolv/ns_name_compress.c`, `resolv/ns_name_ntop.c`, `resolv/ns_name_pack.c`,
`resolv/ns_name_pton.c`, `resolv/ns_name_skip.c`, `resolv/ns_name_uncompress.c` and
`resolv/ns_name_unpack.c`:

```
 * Copyright (c) 2004 by Internet Systems Consortium, Inc. ("ISC")
 * Copyright (c) 1996,1999 by Internet Software Consortium.
 *
 * Permission to use, copy, modify, and distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND ISC DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS.  IN NO EVENT SHALL ISC BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
 * OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
```

`resolv/ns_makecanon.c` and `resolv/ns_samename.c`:

```
 * Copyright (c) 2004 by Internet Systems Consortium, Inc. ("ISC")
 * Copyright (c) 1995,1999 by Internet Software Consortium.
 *
 * Permission to use, copy, modify, and distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND INTERNET SOFTWARE CONSORTIUM DISCLAIMS
 * ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES
 * OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL INTERNET SOFTWARE
 * CONSORTIUM BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL
 * DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
 * PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS
 * ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS
 * SOFTWARE.
 */
```

`resolv/nss_dns/dns-network.c` (beside the 4.4 BSD licence):

```
/* Copyright (c) 1993 Carlos Leandro and Rui Salgueiro
 *      Dep. Matematica Universidade de Coimbra, Portugal, Europe
 *
 * Permission to use, copy, modify, and distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 */
```

### GCC's runtime library

- **Where**: every static binary contains GCC's start-up files `crtbeginT.o` and `crtend.o`,
  and these objects of `libgcc.a` and `libgcc_eh.a`, which glibc's `libc.a` refers to: the
  quad-precision routines `addtf3`, `letf2`, `multf3`, `unordtf2` and `sfp-exceptions`, and
  the unwinder (`unwind-dw2`, `unwind-dw2-fde-dip`, `unwind-c`). `hash`, `memory_read` and
  `memory_write` also contain `cpuinfo`, the CPU detection behind `__builtin_cpu_supports`;
  `http_get` also contains `_umoddi3`, which AWS-LC refers to. The dynamic `memory_read`
  contains `crtbegin.o`, `crtend.o` and `cpuinfo`.
- **Version**: GCC 11.5.0, Amazon Linux 2023's `gcc-11.5.0-5.amzn2023.0.5` in the pinned
  release. Every Run records its compiler (`binary.compiler`, for example
  `cc (GCC) 11.5.0 20240719 (Red Hat 11.5.0-5)`).
- **Licence**, as the files' headers state it. These were read in GCC's source at tag
  `releases/gcc-11.5.0`; Amazon Linux's source package was not read.
  - `libgcc/crtstuff.c` (the start-up files), `libgcc/libgcc2.c` (`_umoddi3`),
    `libgcc/config/i386/cpuinfo.c`, `libgcc/config/i386/sfp-exceptions.c` and the
    unwinder's files are under the GNU General Public License, version 3 or later, and say:
    "Under Section 7 of GPL version 3, you are granted additional permissions described in
    the GCC Runtime Library Exception, version 3.1, as published by the Free Software
    Foundation."
  - The quad-precision routines (`libgcc/soft-fp/addtf3.c`, `letf2.c`, `multf3.c`,
    `unordtf2.c`) are under LGPL-2.1-or-later, with "unlimited permission to link the
    compiled version of this file into combinations with other programs, and to distribute
    those combinations without any restriction coming from the use of this file."
- **The exception**, in the words of its section 1 (GCC's `COPYING.RUNTIME`): "You have
  permission to propagate a work of Target Code formed by combining the Runtime Library with
  Independent Modules, even if such propagation would otherwise violate the terms of GPLv3,
  provided that all Target Code was generated by Eligible Compilation Processes. You may then
  convey such a combination under terms of your choice, consistent with the licensing of the
  Independent Modules." It calls a Compilation Process "Eligible" "if it is done using GCC,
  alone or with other GPL-compatible software, or if it is done without using any work based
  on GCC". LedgerMath's binaries are compiled by GCC and linked by GNU ld, as each Run's
  build record shows.
- **Source**: `gcc-11.5.0-5.amzn2023.0.5.src.rpm`, in the same Amazon Linux repository as
  glibc's. It is not stored in the bucket.

### AWS-LC

- **Where**: the TLS library of `http_get`. Its `libssl` and `libcrypto` are linked
  statically into the `http_get` binary, and into no other.
- **Version**, as [`benchmarks/harness/c/vendor/aws-lc.lock`](benchmarks/harness/c/vendor/aws-lc.lock)
  pins it: AWS-LC 5.14.0, from the source archive
  <https://github.com/aws/aws-lc/archive/refs/tags/v5.14.0.tar.gz>, SHA-256
  `8895a9d2434e875e009e652a1015f9c2c275261634c7132253ca5aa60d266888`, built by
  `benchmarks/harness/c/vendor/build-aws-lc.sh` with the lock's CMake flags.
- **Source**: that archive. The deploy also keeps it in the bucket as a blob, under its
  hash.
- **Licence**, as AWS-LC's `LICENSE` states it: AWS-LC's own new code under Apache-2.0 OR
  ISC; code from BoringSSL under ISC (older code) or Apache-2.0 (newer); code from OpenSSL
  under Apache-2.0; code from mlkem-native and mldsa-native under Apache-2.0 OR ISC OR MIT;
  and, compiled into `libcrypto` and `libssl`, Fiat Cryptography (MIT), s2n-bignum
  (Apache-2.0 OR ISC OR MIT-0), the CPU Jitter Random Number Generator (distributed by
  Amazon under BSD-3-Clause) and Keccak and AES reference code (CC0). The pinned build
  leaves CPU Jitter entropy in: its CMake option `DISABLE_CPU_JITTER_ENTROPY` is off unless
  set, and the lock does not set it.

Below are AWS-LC's `NOTICE` and `LICENSE` as they are in the pinned archive, and the licence
files that `LICENSE` points to for the code compiled into the libraries. Their SHA-256:

- `aws-lc-5.14.0/NOTICE`: `f97c469fa666b51b3dae2e1530504a5ee73bbf47b980aa76746d26c271dd591d`
- `aws-lc-5.14.0/LICENSE`: `977c541bd25ffe36975dde25c028c0cd15ddf3d08243983b58e8a6a3d9447523`

`aws-lc-5.14.0/NOTICE`:

````
AWS-LC
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. 
````

`aws-lc-5.14.0/LICENSE`:

````
AWS Libcrypto (AWS-LC)

AWS-LC is a fork of BoringSSL, which is itself a fork of OpenSSL.
Content from these and other sources retains their original licensing,
as described below. New files from AWS-LC are made available under the Apache-2.0 license OR the ISC
license. These licenses are reproduced at the bottom of this file.

```
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0 OR ISC
```


================================================================================
BoringSSL
================================================================================

BoringSSL is a Google-maintained fork of OpenSSL. Historically, code
authored by Google for BoringSSL was licensed under the ISC License.
BoringSSL has since relicensed upstream to Apache License 2.0. Existing
AWS-LC code originating from BoringSSL retains its ISC license, while
newer code taken from BoringSSL is licensed under Apache License 2.0.

```
Copyright (c) 2014-2024 Google Inc.
SPDX-License-Identifier: ISC
```

Additional individual contributions to BoringSSL-derived code are
covered under the ISC license:

  - Brian Smith (Copyright 2016)
  - Robert Nagy (Copyright 2022)
  - Arm Ltd (Copyright 2020)

```
Copyright (c) 2025-2026 Google Inc.
SPDX-License-Identifier: Apache-2.0
```

================================================================================
OpenSSL
================================================================================

Code derived from the OpenSSL project is licensed under the
Apache License, Version 2.0.

```
Copyright (c) 1998-2011 The OpenSSL Project. All rights reserved.
SPDX-License-Identifier: Apache-2.0
```

Some OpenSSL-derived files also carry the original SSLeay copyright:

```
Copyright (c) 1995-1998 Eric Young (eay@cryptsoft.com). All rights reserved.
SPDX-License-Identifier: Apache-2.0
```

Portions of OpenSSL-derived code include contributions from:

  - Sun Microsystems, Inc. (Copyright 2002)
  - Nokia (Copyright 2005)
  - Intel Corporation (Copyright 2012-2021)

These contributions are covered under the Apache-2.0 license.

================================================================================
mlkem-native
================================================================================

Code from the mlkem-native project is licensed under Apache License 2.0 or MIT or ISC.

```
Copyright (c) The mlkem-native project authors.
SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
```

================================================================================
mldsa-native
================================================================================

Code from the mldsa-native project is licensed under Apache License 2.0 or MIT or ISC

```
Copyright (c) The mldsa-native project authors.
SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT
```

================================================================================
Third-Party Libraries (compiled into libcrypto/libssl)
================================================================================

Fiat Cryptography
-----------------
Synthesizing Correct-by-Construction Code for Cryptographic Primitives.
See third_party/fiat/LICENSE.

```
Copyright (c) 2015-2020 the fiat-crypto authors.
SPDX-License-Identifier: MIT
```

s2n-bignum
----------
Integer arithmetic routines for cryptography.
See third_party/s2n-bignum/s2n-bignum-imported/LICENSE.

```
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0 OR ISC OR MIT-0
```

Note: ML-KEM/SHA3 code within s2n-bignum is licensed as
Apache-2.0 OR ISC OR MIT (with attribution), sourced from the
mlkem-native project.

Jitter Entropy RNG
-------------------
CPU Jitter Random Number Generator Library.
See third_party/jitterentropy/jitterentropy-library/LICENSE.

The Jitter Entropy library is dual-licensed under a BSD-style license
and the GNU General Public License Version 2. Amazon expressly elects
to distribute the package under the 3-Clause BSD License and NOT under
GNU General Public License Version 2.

```
Copyright (C) 2017 - 2025, Stephan Mueller <smueller@chronox.de>.
SPDX-License-Identifier: BSD-3-Clause
```

Keccak / AES Reference Implementations
---------------------------------------
Public domain (CC0) contributions.
https://creativecommons.org/public-domain/cc0

Code from sources and by authors listed in comments on top of the respective files.


================================================================================
Third-Party Libraries (NOT compiled into libcrypto/libssl)
================================================================================

The following are used for testing and build tooling only. Distributing
code linked against AWS-LC (libcrypto/libssl) does NOT trigger these
license obligations.

Google Test
-----------
See third_party/googletest/LICENSE.

```
Copyright 2008 Google Inc.
SPDX-License-Identifier: BSD-3-Clause
```

Go Standard Library
-------------------
Code in ssl/test/runner/ is derived from the Go standard library.

```
Copyright (c) The Go Authors. All rights reserved.
SPDX-License-Identifier: BSD-3-Clause
```

Wycheproof Test Vectors
------------------------
Project Wycheproof is a community managed repository of test vectors that can be used by cryptography library
developers to test against known attacks, specification inconsistencies, and other various implementation bugs.

See third_party/wycheproof_testvectors/LICENSE.

```
SPDX-License-Identifier: Apache-2.0
```


================================================================================
Full License Texts
================================================================================

Apache License 2.0
------------------
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

    1. Definitions.

        "License" shall mean the terms and conditions for use, reproduction, and distribution as defined by Sections 1 through 9 of this document.

        "Licensor" shall mean the copyright owner or entity authorized by the copyright owner that is granting the License.

        "Legal Entity" shall mean the union of the acting entity and all other entities that control, are controlled by, or are under common control with that entity. For the purposes of this definition, "control" means (i) the power, direct or indirect, to cause the direction or management of such entity, whether by contract or otherwise, or (ii) ownership of fifty percent (50%) or more of the outstanding shares, or (iii) beneficial ownership of such entity.

        "You" (or "Your") shall mean an individual or Legal Entity exercising permissions granted by this License.

        "Source" form shall mean the preferred form for making modifications, including but not limited to software source code, documentation source, and configuration files.

        "Object" form shall mean any form resulting from mechanical transformation or translation of a Source form, including but not limited to compiled object code, generated documentation, and conversions to other media types.

        "Work" shall mean the work of authorship, whether in Source or Object form, made available under the License, as indicated by a copyright notice that is included in or attached to the work (an example is provided in the Appendix below).

        "Derivative Works" shall mean any work, whether in Source or Object form, that is based on (or derived from) the Work and for which the editorial revisions, annotations, elaborations, or other modifications represent, as a whole, an original work of authorship. For the purposes of this License, Derivative Works shall not include works that remain separable from, or merely link (or bind by name) to the interfaces of, the Work and Derivative Works thereof.

        "Contribution" shall mean any work of authorship, including the original version of the Work and any modifications or additions to that Work or Derivative Works thereof, that is intentionally submitted to Licensor for inclusion in the Work by the copyright owner or by an individual or Legal Entity authorized to submit on behalf of the copyright owner. For the purposes of this definition, "submitted" means any form of electronic, verbal, or written communication sent to the Licensor or its representatives, including but not limited to communication on electronic mailing lists, source code control systems, and issue tracking systems that are managed by, or on behalf of, the Licensor for the purpose of discussing and improving the Work, but excluding communication that is conspicuously marked or otherwise designated in writing by the copyright owner as "Not a Contribution."

        "Contributor" shall mean Licensor and any individual or Legal Entity on behalf of whom a Contribution has been received by Licensor and subsequently incorporated within the Work.
    2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.
    3. Grant of Patent License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer the Work, where such license applies only to those patent claims licensable by such Contributor that are necessarily infringed by their Contribution(s) alone or by combination of their Contribution(s) with the Work to which such Contribution(s) was submitted. If You institute patent litigation against any entity (including a cross-claim or counterclaim in a lawsuit) alleging that the Work or a Contribution incorporated within the Work constitutes direct or contributory patent infringement, then any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed.
    4. Redistribution. You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, and in Source or Object form, provided that You meet the following conditions:
        (a) You must give any other recipients of the Work or Derivative Works a copy of this License; and
        (b) You must cause any modified files to carry prominent notices stating that You changed the files; and
        (c) You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work, excluding those notices that do not pertain to any part of the Derivative Works; and
        (d) If the Work includes a "NOTICE" text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file, excluding those notices that do not pertain to any part of the Derivative Works, in at least one of the following places: within a NOTICE text file distributed as part of the Derivative Works; within the Source form or documentation, if provided along with the Derivative Works; or, within a display generated by the Derivative Works, if and wherever such third-party notices normally appear. The contents of the NOTICE file are for informational purposes only and do not modify the License. You may add Your own attribution notices within Derivative Works that You distribute, alongside or as an addendum to the NOTICE text from the Work, provided that such additional attribution notices cannot be construed as modifying the License.

    You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.
    5. Submission of Contributions. Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions. Notwithstanding the above, nothing herein shall supersede or modify the terms of any separate license agreement you may have executed with Licensor regarding such Contributions.
    6. Trademarks. This License does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor, except as required for reasonable and customary use in describing the origin of the Work and reproducing the content of the NOTICE file.
    7. Disclaimer of Warranty. Unless required by applicable law or agreed to in writing, Licensor provides the Work (and each Contributor provides its Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied, including, without limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining the appropriateness of using or redistributing the Work and assume any risks associated with Your exercise of permissions under this License.
    8. Limitation of Liability. In no event and under no legal theory, whether in tort (including negligence), contract, or otherwise, unless required by applicable law (such as deliberate and grossly negligent acts) or agreed to in writing, shall any Contributor be liable to You for damages, including any direct, indirect, special, incidental, or consequential damages of any character arising as a result of this License or out of the use or inability to use the Work (including but not limited to damages for loss of goodwill, work stoppage, computer failure or malfunction, or any and all other commercial damages or losses), even if such Contributor has been advised of the possibility of such damages.
    9. Accepting Warranty or Additional Liability. While redistributing the Work or Derivative Works thereof, You may choose to offer, and charge a fee for, acceptance of support, warranty, indemnity, or other liability obligations and/or rights consistent with this License. However, in accepting such obligations, You may act only on Your own behalf and on Your sole responsibility, not on behalf of any other Contributor, and only if You agree to indemnify, defend, and hold each Contributor harmless for any liability incurred by, or claims asserted against, such Contributor by reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

To apply the Apache License to your work, attach the following boilerplate notice, with the fields enclosed by brackets "[]" replaced with your own identifying information. (Don't include the brackets!) The text should be enclosed in the appropriate comment syntax for the file format. We also recommend that a file or class name and description of purpose be included on the same "printed page" as the copyright notice for easier identification within third-party archives.

Copyright [yyyy] [name of copyright owner]

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

ISC License
-----------
Permission to use, copy, modify, and/or distribute this software for
any purpose with or without fee is hereby granted, provided that the
above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL
DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

MIT License
-----------
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

BSD 3-Clause License
--------------------
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived
   from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

MIT No Attribution (MIT-0)
--------------------------
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. 
````

`aws-lc-5.14.0/third_party/fiat/LICENSE`:

````
The MIT License (MIT)

Copyright (c) 2015-2020 the fiat-crypto authors (see
https://github.com/mit-plv/fiat-crypto/blob/master/AUTHORS).

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
````

`aws-lc-5.14.0/third_party/s2n-bignum/s2n-bignum-imported/NOTICE` (its `LICENSE` holds the
Apache-2.0, ISC and MIT-0 texts, which are in AWS-LC's `LICENSE` above):

````
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
````

`aws-lc-5.14.0/third_party/jitterentropy/jitterentropy-library/LICENSE`:

````
Copyright (C) 2017 - 2025, Stephan Mueller <smueller@chronox.de>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, and the entire permission notice in its entirety,
   including the disclaimer of warranties.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. The name of the author may not be used to endorse or promote
   products derived from this software without specific prior
   written permission.

ALTERNATIVELY, this product may be distributed under the terms of
the GNU General Public License, in which case the provisions of the GPL2
are required INSTEAD OF the above restrictions.  (This clause is
necessary due to a potential bad interaction between the GPL and
the restrictions contained in a BSD-style copyright.)

THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED
WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE, ALL OF
WHICH ARE HEREBY DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT
OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
USE OF THIS SOFTWARE, EVEN IF NOT ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE.

````

## 3. JavaScript packages

The tools in this repository run on Bun, with the packages `package.json` names at the
versions `bun.lock` pins. The packages are not in the repository (`bun install` fetches
them), and none is part of anything LedgerMath publishes: the page
(`scripts/build-page.ts`) uses no package and loads nothing from the network, and the
Lambda functions that SST builds from `infra/` at a deploy run in the project's AWS account
and are not published.

| Package | Version | Licence | What uses it |
|---|---|---|---|
| `@aws-sdk/client-ec2` | 3.1085.0 | Apache-2.0 | The Lambda functions that launch and reap boxes (`infra/`) |
| `sst` | 4.17.0 | MIT | Deploying the stack (`sst.config.ts`, `infra/`) |
| `ajv` | 8.20.0 | MIT | Checking Runs, events and price files against `schemas/` |
| `zod` | 4.4.3 | MIT | `packages/shared` |
| `typescript` | 7.0.2 | Apache-2.0 | Type checking (`bunx tsc --noEmit`) |
| `@types/aws-lambda` | 8.10.162 | MIT | Type definitions |
| `@types/bun` | 1.3.14 | MIT | Type definitions |

## 4. What is not listed

- Implementations of published algorithms and protocols in the benchmarks and the harness:
  SHA-256 (the scalar version), CRC32C, the LSD radix sort, xorshift64, xorshift64*,
  SplitMix64 and its finalizer, FNV-1a, the Fisher-Yates shuffle, AWS Signature Version 4,
  and the DNS (RFC 1035) and HTTP/1.1 (RFC 9112) parsers. Where an algorithm fixes the shape
  of the code (its constants, its rounds), they match other implementations of it. No other
  project's implementation was identified as the source of any of them.
- Two routines that resemble public-domain code, which asks for no notice; we say so because
  it is not known whether that code was used:
  - The SHA-256 routine that uses the SHA extensions (`sha256_compress_ni` in
    `benchmarks/hash/hash.c`, and the same body in `benchmarks/c/bench_hash.c`) closely
    resembles Jeffrey Walton's public-domain `sha256-x86.c`
    (<https://github.com/noloader/SHA-Intrinsics>), itself based on code by Intel, Sean
    Gulley and the miTLS project. Whether that file was used as a reference when the routine
    was written has not been established.
  - The SipHash-1-3 function (`siphash13_64` in the same two files) follows the round of
    SipHash's reference implementation (<https://github.com/veorq/SipHash>) closely. That
    implementation's `siphash.c` dedicates it to the public domain under CC0, and its
    repository also offers it under the MIT licence and Apache-2.0 with LLVM exceptions.
    The plan the benchmark was written from, `docs/prds/04-hash.md`, asked for a
    public-domain SipHash implementation to be vendored into the file.
- Short facts from AWS's documentation used in tests and samples: the S3 User Guide's
  example credentials and signatures (`tests/http-get.test.ts`) and AWS's example
  identifiers (`tests/samples/README.md`).
- Files that tools write: `bun.lock` (Bun) and `sst-env.d.ts` (SST).
