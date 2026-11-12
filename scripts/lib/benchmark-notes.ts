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

/*
 * No quantity is written here by hand: a size, a limit or a count is named by
 * the parameter or observed value that holds it, or by the dump section that
 * records it (tests/lookup.test.ts reads every line with the checker's own
 * reader and finds no number). A condition is stated only where a Run holds
 * proof of it.
 */
const ROOT_VOLUME =
	"the root EBS volume, not the instance's own disk: an EBS number. Its volume type, size and provisioned IOPS and throughput are AWS's record in each boot's dump section ec2_volumes, which the tool does not show";
const INSTANCE_STORE = "the instance's own NVMe disk (instance store), on the instance types that have one; each boot's dump section provision records how it was prepared";
const CACHES = "the Run's dump sections lscpu and sys_cpu record the cache sizes, which the tool does not show";

export const BENCHMARK_NOTES: Readonly<Record<string, BenchmarkNote>> = {
	memory_read: {
		measures: `How fast a buffer of size_bytes is read front to back and summed word by word: on one unpinned thread or on one pinned thread per allowed CPU (the parameter threads: a single thread, or all), with an x86 scalar loop (path scalar) or AVX2 (path avx2). Whether the buffer comes from memory or cache depends on size_bytes and the machine; ${CACHES}.`,
		repetition: "reads size_bytes once; with threads all, each thread reads its own slice of it",
		bytes: "bytes read",
		source: "benchmarks/memory_read/memory_read.c",
	},
	compressed_memory_read: {
		measures: `How fast one thread unpacks integers stored at a width of bits into full-width integers, the decode step of a compressed column, cycling through a pool of blocks (the parameter blocks) meant to come from memory rather than cache. Whether the pool exceeds the cache depends on the machine; ${CACHES}.`,
		repetition: "unpacks one block; the bytes it reads and writes are what each Run observes (compressed_bytes_per_repetition in, bytes_per_repetition out)",
		bytes: "bytes written out (unpacked), which are more than the bytes read",
		source: "benchmarks/compressed_memory_read/README.md",
	},
	memory_read_random: {
		measures:
			"How fast one thread reads a buffer of size_bytes in random order: the first word of every cache-line element, in a shuffled order, with many cache misses in flight. The throughput of random reads, not the latency of one.",
		repetition: "reads every element of size_bytes once; how many reads that is, each Run observes (reads_per_repetition)",
		bytes: "bytes of the elements read from, a whole cache line each, not the bytes the thread uses",
		source: "benchmarks/memory_read_random/README.md",
	},
	memory_write: {
		measures:
			"How fast one thread writes a buffer of size_bytes, front to back (order sequential) or in random order (order random), one cache-line element at a time: AVX2 stores, then a read of the element's last word.",
		repetition: "writes every element of size_bytes once",
		bytes: "bytes written",
		source: "benchmarks/memory_write/README.md",
	},
	syscall: {
		measures:
			"The cost of one call into the kernel, on one thread (call getpid, getrusage, stat; stat's cost depends on the file system that answers it, which the Run observes), beside call gettimeofday, which the vDSO normally answers without entering the kernel. Whether it did is not observed: the clock source in the Run's dump section kernel decides it.",
		repetition: "makes one call",
		source: "benchmarks/syscall/README.md",
	},
	hash: {
		measures:
			"How long one thread takes to hash an input of size_bytes: CRC32C (algorithm crc32), SipHash with a fixed key in the variant Rust's DefaultHasher uses (siphash), or SHA-256 (sha256, with the SHA extensions when the processor has them).",
		repetition: "hashes the same size_bytes of input once",
		bytes: "bytes hashed",
		source: "benchmarks/hash/README.md",
	},
	sort: {
		measures: "How fast one thread sorts word-sized integer keys: a copy of size_bytes of unsorted keys, sorted by an LSD radix sort.",
		repetition: "copies size_bytes of keys and sorts the copy",
		bytes: "bytes of keys copied and sorted",
		source: "benchmarks/sort/README.md",
	},
	tcp_echo: {
		measures:
			"The round trip of a buffer of size_bytes over loopback TCP inside one process, between its main thread and a server thread that echoes: the kernel's TCP stack and system calls, with no network card.",
		repetition: "sends size_bytes to the loopback address and reads all of it back",
		bytes: "bytes sent and read back, counted once",
		caveat: "Loopback: no network is involved. It is not a number for traffic between two machines.",
		source: "benchmarks/tcp_echo/README.md",
	},
	mutex: {
		measures:
			"What a critical section under a pthread mutex costs: uncontended on one thread, and with two threads handing the lock between two physical cores or the two hardware threads of one core.",
		repetition:
			"a fixed number of critical sections, by whichever threads win the lock: each Run observes how many (critical_sections_per_repetition), which the tool does not show; divide by it for one",
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
				note: "lock handoff throughput between two physical cores with the protected cache lines of critical_section_lines moving with the lock, which includes glibc's futex sleep and wake-up",
			},
			{ match: { placement: "smt_siblings" }, note: "lock handoff throughput between the two hardware threads of one core" },
		],
		source: "benchmarks/mutex/README.md",
	},
	disk_read_random: {
		measures: "The latency of one O_DIRECT read of request_bytes from a disk, on one thread, with nothing else outstanding.",
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
			"How many reads a disk completes with queue_depth of them kept submitted (O_DIRECT through io_uring), from one thread. On EC2 the counted samples sit on the provider's throughput or IOPS limit for the disk, not the device's own; the device's counters in the Run say which limit bound.",
		repetition: "one completed read: time per repetition is the time per completion",
		bytes: "bytes read",
		variants: [
			{ match: { disk: "root_volume", access: "sequential" }, note: `${ROOT_VOLUME}; sequential reads of request_bytes: its throughput limit` },
			{ match: { disk: "root_volume", access: "random" }, note: `${ROOT_VOLUME}; random reads of request_bytes: its IOPS limit` },
			{ match: { disk: "instance_store", access: "sequential" }, note: `${INSTANCE_STORE}; sequential reads of request_bytes: its sustained throughput limit` },
			{ match: { disk: "instance_store", access: "random" }, note: `${INSTANCE_STORE}; random reads of request_bytes: its sustained IOPS limit` },
		],
		source: "benchmarks/disk_read_io_uring/README.md",
	},
	disk_read_sequential: {
		measures:
			"Reading a file front to back the way a program does, on one thread: buffered preads of request_bytes with the kernel's stock readahead, each sample's region dropped from the page cache first. It is a cold read when the eviction worked, which the Run records as each sample's resident pages.",
		repetition: "one pread of request_bytes",
		bytes: "bytes read",
		variants: [
			{ match: { disk: "root_volume" }, note: ROOT_VOLUME },
			{ match: { disk: "instance_store" }, note: INSTANCE_STORE },
		],
		source: "benchmarks/disk_read_sequential/README.md",
	},
	disk_write: {
		measures:
			"What a buffered pwrite of request_bytes costs, on one thread, one write at a time: followed by fdatasync (sync fdatasync: until the device has the data) or by nothing (sync none: until the page cache has it). fdatasync's cost depends on the disk's write cache, which each Run observes (write_cache).",
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
			"How long an HTTPS GET of an object takes, from the box to the endpoint its Service names, on one thread and one request at a time, each request after the first preceded by a pause whose mean is gap_mean_ms: a lightly loaded client. Every phase of every request (name resolved, connected, secured, request sent, first byte, headers, body) is an event, and every 2xx body is checked against the Fixture. Over a new connection per request (connection new) or one kept connection (connection reused); object_bytes is the object's size; with auth sigv4 the binary signs each request, with auth none it does not. Where a Series' requests went, how they were signed and what they negotiated is what its Runs record, shown with its percentiles across requests; the path between box and server is in each Run's dumps.",
		repetition: "one GET, from just before its DNS query (new) or its request write (reused) to its whole body: one request per sample",
		caveat:
			"Method series v1 gives one number per Run, the median of the requests' total times, and counts only a Run whose binary exited cleanly. Method requests v1 gives each phase's percentiles across the requests (show <id>), to the 99th and 99.9th where the requests support them; a Run whose binary reported a failed request or a status that is not 2xx counts there, its failed requests counted and never timed.",
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
