/**
 * What each benchmark measures, in one line, and what one of its repetitions
 * is, for the lookup tool (scripts/lookup.ts). Taken from each benchmark's
 * README.md (memory_read has none: from the comment at the top of its source).
 * A Derivation gives time per repetition, and bytes per second where the
 * benchmark observed bytes_per_repetition; these lines say what those mean.
 *
 * Words, not numbers LedgerMath measured: when a benchmark's README changes
 * what it says it measures, change its line here. tests/lookup.test.ts
 * requires a line for every benchmark schedule.json runs.
 */

import type { ParamValue } from "../../methods/run";

/** A note for the parameter sets whose params include every key and value of `match`. */
export interface VariantNote {
	match: Record<string, ParamValue>;
	note: string;
}

export interface BenchmarkNote {
	/** What it measures, in one line. */
	measures: string;
	/** What one repetition is: what time per repetition is the time of. */
	repetition: string;
	/** What bytes per second counts, when the benchmark observes bytes_per_repetition. */
	bytes?: string;
	/** What the number must not be used for. */
	caveat?: string;
	variants?: VariantNote[];
	/** Where the words come from, from the root of the source repository. */
	source: string;
}

const ROOT_VOLUME =
	"the root EBS volume, the image's default 8 GiB gp3 (3000 IOPS, 125 MiB/s as provisioned): an EBS number, not the instance's own disk";
const INSTANCE_STORE = "the instance's own NVMe disk (instance store), on i4i.2xlarge only";

export const BENCHMARK_NOTES: Readonly<Record<string, BenchmarkNote>> = {
	memory_read: {
		measures:
			"How fast a buffer of 64-bit words is read front to back and summed: on one unpinned thread (threads 1) or one pinned thread per allowed CPU (threads all), with an x86 scalar loop (path scalar) or AVX2 (path avx2). Whether the buffer comes from memory or cache depends on size_bytes and the machine's caches, which the Run's dump records.",
		repetition: "reads size_bytes once; with threads all, each thread reads its own slice of it",
		bytes: "bytes read",
		source: "benchmarks/memory_read/memory_read.c",
	},
	compressed_memory_read: {
		measures:
			"How fast one core unpacks integers stored at 8 bits each into 32-bit integers, the decode step of a compressed column, cycling through a pool of blocks meant to come from memory rather than cache. Whether the pool exceeds the cache depends on the machine (some have an L3 of hundreds of MiB); the Run's dump records the cache sizes.",
		repetition: "unpacks one block: 256 bytes in, 256 32-bit integers (1024 bytes) out",
		bytes: "bytes written out (unpacked), not bytes read: 1024 out for 256 in",
		source: "benchmarks/compressed_memory_read/README.md",
	},
	memory_read_random: {
		measures:
			"How fast one core reads a large buffer in random order: the first 8 bytes of every 64-byte element, in a shuffled order, with many cache misses in flight. The throughput of random reads, not the latency of one.",
		repetition: "reads every 64-byte element of size_bytes once: size_bytes / 64 reads",
		bytes: "bytes of the elements read from: 64 per read, the cache line each read brings in, of which the core uses 8",
		source: "benchmarks/memory_read_random/README.md",
	},
	memory_write: {
		measures:
			"How fast one core writes a large buffer, front to back (order sequential) or in random order (order random), one 64-byte element at a time: two 32-byte AVX2 stores, then a read of its last word.",
		repetition: "writes every 64-byte element of size_bytes once",
		bytes: "bytes written",
		source: "benchmarks/memory_write/README.md",
	},
	syscall: {
		measures:
			"The cost of one call into the kernel (call getpid, getrusage, stat; stat's cost depends on the file system that answers it, which the Run observes), beside call gettimeofday, which the vDSO normally answers without entering the kernel. Whether it did is not observed: the clock source in the Run's dump decides it.",
		repetition: "makes one call",
		source: "benchmarks/syscall/README.md",
	},
	hash: {
		measures:
			"How long one core takes to hash a 64-byte input: CRC32C (algorithm crc32), SipHash-1-3 (siphash) or SHA-256 (sha256, with the SHA extensions when the processor has them).",
		repetition: "hashes the same 64 bytes once",
		bytes: "bytes hashed",
		source: "benchmarks/hash/README.md",
	},
	sort: {
		measures: "How fast one core sorts 64-bit integer keys: a copy of size_bytes of unsorted keys, sorted by an LSD radix sort.",
		repetition: "copies size_bytes of keys (131,072 keys for 1 MiB) and sorts the copy",
		bytes: "bytes of keys copied and sorted",
		source: "benchmarks/sort/README.md",
	},
	tcp_echo: {
		measures:
			"The round trip of a buffer over loopback TCP inside one process: the kernel's TCP stack and system calls, with no network card.",
		repetition: "sends size_bytes to 127.0.0.1 and reads all of it back",
		bytes: "bytes sent and read back, counted once",
		caveat: "Loopback: no network is involved. It is not a number for traffic between two machines.",
		source: "benchmarks/tcp_echo/README.md",
	},
	mutex: {
		measures:
			"What a critical section under a pthread mutex costs: uncontended on one thread, and with two threads handing the lock between two physical cores or the two hardware threads of one core.",
		repetition: "exactly 10,000 critical sections, by whichever threads win the lock: divide by 10,000 for one",
		variants: [
			{
				match: { threads: 1, idle_threads: 1 },
				note: "one lock and unlock nobody contends, in a program that has more than one thread: usually the number wanted",
			},
			{
				match: { threads: 1, idle_threads: 0 },
				note: "the same in a process that has only ever had one thread, where glibc skips the atomic instructions",
			},
			{ match: { placement: "distinct_cores", critical_section_lines: 1 }, note: "lock handoff throughput between two physical cores" },
			{
				match: { placement: "distinct_cores", critical_section_lines: 8 },
				note: "lock handoff throughput between two physical cores with eight protected cache lines moving with the lock, which includes glibc's futex sleep and wake-up",
			},
			{ match: { placement: "smt_siblings" }, note: "lock handoff throughput between the two hardware threads of one core" },
		],
		source: "benchmarks/mutex/README.md",
	},
	disk_read_random: {
		measures: "The latency of one 8 KiB O_DIRECT read from a disk, with nothing else outstanding (queue depth 1).",
		repetition: "one read: time per repetition is the mean time of one read",
		bytes: "bytes read",
		variants: [
			{ match: { disk: "root_volume" }, note: ROOT_VOLUME },
			{ match: { disk: "instance_store" }, note: INSTANCE_STORE },
		],
		source: "benchmarks/disk_read_random/README.md",
	},
	disk_read_io_uring: {
		measures:
			"How many reads a disk completes with 64 kept submitted (O_DIRECT through io_uring). On EC2 the counted samples sit on the provider's throughput or IOPS limit for the disk, not the device's own; the device's counters in the Run say which limit bound.",
		repetition: "one completed read: time per repetition is the time per completion",
		bytes: "bytes read",
		variants: [
			{ match: { disk: "root_volume", access: "sequential" }, note: `${ROOT_VOLUME}; 32 KiB reads: its throughput limit` },
			{ match: { disk: "root_volume", access: "random" }, note: `${ROOT_VOLUME}; 4 KiB reads: its IOPS limit` },
			{ match: { disk: "instance_store", access: "sequential" }, note: `${INSTANCE_STORE}; 32 KiB reads: its sustained throughput limit` },
			{ match: { disk: "instance_store", access: "random" }, note: `${INSTANCE_STORE}; 4 KiB reads: its sustained IOPS limit` },
		],
		source: "benchmarks/disk_read_io_uring/README.md",
	},
	disk_read_sequential: {
		measures:
			"Reading a file front to back the way a program does: buffered 8 KiB preads with the kernel's stock readahead, each sample's region dropped from the page cache first. It is a cold read when the eviction worked, which the Run records as each sample's resident pages.",
		repetition: "one 8 KiB pread",
		bytes: "bytes read",
		variants: [
			{ match: { disk: "root_volume" }, note: ROOT_VOLUME },
			{ match: { disk: "instance_store" }, note: INSTANCE_STORE },
		],
		source: "benchmarks/disk_read_sequential/README.md",
	},
	disk_write: {
		measures:
			"What a buffered 8 KiB pwrite costs, followed by fdatasync (sync fdatasync: until the device has the data) or by nothing (sync none: until the page cache has it). fdatasync's cost depends on the disk's write cache, which the Run records (every disk seen so far is write through).",
		repetition: "one write, with its fdatasync when sync is fdatasync",
		bytes: "bytes written",
		variants: [
			{ match: { sync: "none" }, note: "the page cache's number, not the disk's" },
			{ match: { disk: "root_volume", sync: "fdatasync" }, note: `a durable write to ${ROOT_VOLUME}` },
			{ match: { disk: "instance_store", sync: "fdatasync" }, note: `a durable write, through XFS, to ${INSTANCE_STORE}` },
		],
		source: "benchmarks/disk_write/README.md",
	},
	http_get: {
		measures:
			"How long an HTTPS GET of an object in S3 takes, signed with SigV4, from the box to the stage's private bucket in us-east-2, through the internet gateway: every phase of every request (name resolved, connected, secured, request sent, first byte, headers, body) is an event, and every 2xx body is checked against the Fixture. Over a new connection per request (connection new) or one kept connection (connection reused); object_bytes is the object's size.",
		repetition: "one GET, from just before its DNS query (new) or its request write (reused) to its whole body: one request per sample",
		caveat:
			"Method series v1 gives one number per Run, the median of the requests' total times, and counts only a Run that exited 0. Method requests v1 gives each phase's percentiles across the requests (show <id>), to the 99th and 99.9th where the requests support them; a Run that exited 4 (a failed request or a status that is not 2xx) counts there, its failed requests counted and never timed.",
		variants: [
			{ match: { connection: "new" }, note: "each request resolves the name, connects and does a TLS handshake inside its sample: what a fresh client pays" },
			{ match: { connection: "reused" }, note: "the request on a kept connection: send, first byte, headers and body only" },
		],
		source: "benchmarks/http_get/README.md",
	},
};

/** The notes of every variant whose match the params satisfy, in table order. */
export function variantNotes(note: BenchmarkNote, params: Record<string, ParamValue>): string[] {
	return (note.variants ?? [])
		.filter((variant) => Object.entries(variant.match).every(([key, value]) => params[key] === value))
		.map((variant) => variant.note);
}
