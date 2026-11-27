/**
 * The headline selection: which Series the home table shows, one per
 * benchmark and machine type. A page may show more Series than these (other
 * settings, the other build), never other figures for these.
 *
 * The rule (headline selection 1), applied to each benchmark in order:
 *
 *  1. Settings measured on every machine type. So: the root volume, not the
 *     instance store (only i4i.2xlarge has one); and for mutex, only the
 *     one-thread settings (m5.large has no two distinct cores, c8a.2xlarge no
 *     SMT siblings).
 *  2. The static build. Every benchmark has it; the dynamic build exists for
 *     memory_read only, as a comparison.
 *  3. One thread where the benchmark offers a choice: a one-thread figure
 *     compares machines of 2 to 32 vCPUs; an all-threads figure grows with
 *     the machine.
 *  4. Where settings are still left to choose between, the one named below
 *     for the benchmark, with its reason. Each reason comes from the
 *     benchmark's README.
 *
 * Every choice is applied to each machine type of the tree the site is built
 * from (siteData in ./index.ts). A choice that matches one Series there fills
 * its cell; one that matches none leaves the cell without a figure, and the
 * page says so; one that matches more than one fails the build, because the
 * rule no longer says which to show. With the trees of November 2026 that is
 * 14 benchmarks × 5 machine types = 70 cells, every one filled.
 *
 * Which figure leads a row (`lead`) is part of the rule too: the median
 * (p50) of bytes per second where the benchmark is about moving bytes and
 * the tree has the rate, otherwise the median time of one repetition.
 * The 5th and 95th percentiles may stand beside it.
 */

export type Section = "Memory" | "Compute" | "Operating system" | "Disk" | "Network";

export type HeadlineChoice = {
	benchmark: string;
	section: Section;
	/** A short name for the row, in plain words. */
	label: string;
	/** What the benchmark measures, in one sentence (from its README). */
	what: string;
	/** What one repetition is, so a time per repetition can be read. */
	repetition: string;
	/** The chosen settings, in plain words. */
	setting: string;
	/** The build the row shows. */
	build: string;
	/** The params a Series must have, every one of them, to stand for this row. */
	params: Record<string, string | number | boolean>;
	/** Which figure leads the row: the median rate (bytes per second) or the median time of one repetition. */
	lead: "rate" | "time";
	/**
	 * When one repetition is a fixed count of something smaller (mutex: 10,000 critical sections),
	 * that count and its name, so a page can show the time of one with formatDurationPerUnit (or
	 * perUnit), which divides exactly and only by a power of ten. Never move the point by hand.
	 */
	per?: { count: number; of: string };
	/** Why these settings, where step 4 of the rule chose between several. */
	reason?: string;
	/** Where the page links the benchmark's name: its page in the documentation (benchmarkDocsUrl). */
	readme: string;
};

// ---------------------------------------------------------------- the documentation's addresses
//
// The one place for them. The documentation is not written yet: /docs/ is a placeholder page
// (src/docs/Page.tsx) that says so and points to the data API, and every link to the
// documentation goes there, the header's and footer's "Docs" and each benchmark's name. When a
// benchmark's own page exists, point the names at their pages by making benchmarkDocsUrl
// return plannedBenchmarkDocsUrl(benchmark): one line.

/** The documentation: for now the placeholder page at /docs/, inside the site. */
export const DOCS_URL = "/docs/";
/** Where a benchmark's page will be, once the documentation has one: /docs/benchmarks/<benchmark>. Nothing links here yet. */
export const plannedBenchmarkDocsUrl = (benchmark: string) => `${DOCS_URL}benchmarks/${benchmark}`;
/** Where a benchmark's name links: the placeholder, until the documentation has the benchmark's page. */
export const benchmarkDocsUrl = (_benchmark: string): string => DOCS_URL;
const README = benchmarkDocsUrl;
const ROOT_VOLUME = { disk: "root_volume", dir: "/var/tmp/ledgermath/disk" } as const;

/** The rows, in the order the home table lists them. */
export const HEADLINE_CHOICES: readonly HeadlineChoice[] = [
	{
		benchmark: "memory_read",
		section: "Memory",
		label: "Read memory sequentially",
		what: "How fast one core reads a 1 GiB buffer front to back.",
		repetition: "One pass over the whole 1 GiB buffer.",
		setting: "1 GiB, one thread, AVX2 loads, static build",
		build: "static",
		params: { size_bytes: 1073741824, threads: 1, path: "avx2" },
		lead: "rate",
		reason: "The AVX2 path (four 32-byte loads at a time) is the one an optimised copy or scan loop takes; the scalar path reads 8 bytes at a time.",
		readme: README("memory_read"),
	},
	{
		benchmark: "memory_read_random",
		section: "Memory",
		label: "Read memory in random order",
		what: "How fast one core reads a 1 GiB buffer one 64-byte cache line at a time, in a shuffled order.",
		repetition: "One read of every 64-byte element of the buffer, in the shuffled order.",
		setting: "1 GiB, one thread, static build",
		build: "static",
		params: { size_bytes: 1073741824, threads: 1 },
		lead: "rate",
		readme: README("memory_read_random"),
	},
	{
		benchmark: "memory_write",
		section: "Memory",
		label: "Write memory sequentially",
		what: "How fast one core writes a 1 GiB buffer, one 64-byte cache line after another.",
		repetition: "One write of every 64-byte element of the buffer.",
		setting: "1 GiB, one thread, in order, static build",
		build: "static",
		params: { size_bytes: 1073741824, threads: 1, order: "sequential" },
		lead: "rate",
		reason: "In order, as memory_read's row reads; random order has a setting of its own.",
		readme: README("memory_write"),
	},
	{
		benchmark: "compressed_memory_read",
		section: "Memory",
		label: "Unpack 8-bit integers",
		what: "How fast one core unpacks integers stored at 8 bits each into 32-bit integers, from a pool larger than most caches.",
		repetition: "One block: 256 bytes in, 256 32-bit integers (1024 bytes) out.",
		setting: "1,000,000 blocks, 8 bits, static build",
		build: "static",
		params: { blocks: 1000000, bits: 8 },
		lead: "rate",
		readme: README("compressed_memory_read"),
	},
	{
		benchmark: "hash",
		section: "Compute",
		label: "Hash 64 bytes with SHA-256",
		what: "How long one core takes to hash a 64-byte input.",
		repetition: "One hash of the same 64 bytes.",
		setting: "SHA-256, 64 bytes, static build",
		build: "static",
		params: { algorithm: "sha256", size_bytes: 64 },
		lead: "time",
		reason: "The cryptographic end of the three: the hash that content addressing and integrity checks use (LedgerMath addresses its own evidence by SHA-256). CRC32C and SipHash have settings of their own.",
		readme: README("hash"),
	},
	{
		benchmark: "sort",
		section: "Compute",
		label: "Sort 1 MiB of 64-bit keys",
		what: "How long one core takes to copy and sort 131,072 unsorted 64-bit keys with a radix sort.",
		repetition: "One copy and sort of 1 MiB of keys.",
		setting: "1 MiB, static build",
		build: "static",
		params: { size_bytes: 1048576 },
		lead: "time",
		readme: README("sort"),
	},
	{
		benchmark: "syscall",
		section: "Operating system",
		label: "Make a system call",
		what: "The cost of one call into the kernel.",
		repetition: "One syscall(SYS_getpid), which enters the kernel every time.",
		setting: "getpid, static build",
		build: "static",
		params: { call: "getpid" },
		lead: "time",
		reason: "The call that does least once inside: it shows the cost of entering and leaving the kernel. gettimeofday is answered in user space by the vDSO, and stat and getrusage do work of their own; each has a setting of its own.",
		readme: README("syscall"),
	},
	{
		benchmark: "mutex",
		section: "Operating system",
		label: "Lock and unlock a mutex",
		what: "What a critical section under a pthread mutex costs when nobody contends for it.",
		repetition: "10,000 critical sections, each a lock, an increment and an unlock.",
		setting: "One thread on one CPU, one idle thread, static build",
		build: "static",
		params: { threads: 1, placement: "one_cpu", critical_section_lines: 1, lock: "pthread_mutex_default", idle_threads: 1 },
		lead: "time",
		per: { count: 10000, of: "critical section" },
		reason: "With one idle thread, glibc locks with atomic instructions, as in any program that has ever started a thread: the uncontended lock a reader usually means, and so usually the number wanted. With no other thread, glibc skips the atomic instructions; that has a setting of its own.",
		readme: README("mutex"),
	},
	{
		benchmark: "tcp_echo",
		section: "Operating system",
		label: "Echo 32 KiB over loopback TCP",
		what: "The round trip of a buffer over loopback TCP: the kernel's TCP stack and system calls, with no network card.",
		repetition: "Send 32 KiB to a server thread and read all of it back.",
		setting: "32 KiB, static build",
		build: "static",
		params: { size_bytes: 32768 },
		lead: "time",
		readme: README("tcp_echo"),
	},
	{
		benchmark: "disk_read_sequential",
		section: "Disk",
		label: "Read a file sequentially",
		what: "Reading a file front to back from a cold page cache, in buffered 8 KiB reads, from the root EBS gp3 volume.",
		repetition: "One 8 KiB read.",
		setting: "Root volume, 8 KiB reads, static build",
		build: "static",
		params: { ...ROOT_VOLUME, request_bytes: 8192, bytes_per_sample: 134217728, span_bytes: 1073741824 },
		lead: "rate",
		readme: README("disk_read_sequential"),
	},
	{
		benchmark: "disk_read_random",
		section: "Disk",
		label: "Read 8 KiB from disk",
		what: "The latency of one 8 KiB direct read from the root EBS gp3 volume, with nothing else outstanding.",
		repetition: "One 8 KiB O_DIRECT read at a random offset.",
		setting: "Root volume, 8 KiB, static build",
		build: "static",
		params: { ...ROOT_VOLUME, request_bytes: 8192, span_bytes: 1073741824 },
		lead: "time",
		readme: README("disk_read_random"),
	},
	{
		benchmark: "disk_read_io_uring",
		section: "Disk",
		label: "Random 4 KiB reads, 64 submitted",
		what: "The time per completed read when 64 direct 4 KiB reads at random offsets are kept submitted through io_uring to the root EBS gp3 volume: one over the volume's IOPS.",
		repetition: "One completed read.",
		setting: "Root volume, random 4 KiB, queue depth 64, static build",
		build: "static",
		params: { ...ROOT_VOLUME, access: "random", request_bytes: 4096, queue_depth: 64, span_bytes: 1073741824 },
		lead: "time",
		reason: "Random 4 KiB reads reach the volume's IOPS limit; its throughput limit is what disk_read_sequential's row shows.",
		readme: README("disk_read_io_uring"),
	},
	{
		benchmark: "disk_write",
		section: "Disk",
		label: "Write 8 KiB durably",
		what: "A buffered 8 KiB write to the root EBS gp3 volume, followed by fdatasync: the time until the device has the data.",
		repetition: "One 8 KiB write and its fdatasync.",
		setting: "Root volume, 8 KiB, fdatasync, static build",
		build: "static",
		params: { ...ROOT_VOLUME, request_bytes: 8192, sync: "fdatasync", file_bytes: 1073741824 },
		lead: "time",
		reason: "Without a sync the binary calls pwrite alone and asks for nothing to be made durable: the README gives that as the time of a buffered write, not of a durable one.",
		readme: README("disk_write"),
	},
	{
		benchmark: "http_get",
		section: "Network",
		label: "GET 4 KiB from S3",
		what: "One HTTPS GET of a 4 KiB object from S3 in the same region, on a connection already open.",
		repetition: "One request, from sending it to the last byte of the body.",
		setting: "4 KiB object, connection reused, static build",
		build: "static",
		params: { object_bytes: 4096, connection: "reused" },
		lead: "time",
		reason: "A small object on an open connection, as a client with a connection pool sends it: the request's own round trip, without the set-up of a new connection or the transfer of a large body. New connections and larger objects have settings of their own.",
		readme: README("http_get"),
	},
];

/**
 * The benchmarks the home page draws as graphs above the table, in this order: of the sections
 * where the machine types differ (memory, compute, the operating system), one each. A choice of
 * which rows to draw, made when the page was designed; the figures are the table's own. Each
 * graph is headed by its benchmark's label, and scripts/check-figures.ts holds the page to
 * exactly these graphs, by their headings, in this order.
 */
export const GRAPH_BENCHMARKS: readonly string[] = ["memory_read", "hash", "syscall"];
