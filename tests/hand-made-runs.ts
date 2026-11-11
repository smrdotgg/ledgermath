/**
 * Hand-made Runs for tests: schema-valid Run files with the dump blobs they
 * name, made to order. Nothing in them comes from a real box.
 *
 * One boot per day unless told otherwise. A boot's host name, root volume and
 * instance ID differ from every other boot's, as on EC2; cpuinfo and memory
 * differ on every dump, as on a real box.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type FetchBlob, type ParamValue, readStream, type Run, type RunEvent, type RunExit, type RunFile } from "../methods/run";

export interface HandMadeRun {
	/** Such as 2026-11-12T22:15:00Z. */
	startedAt: string;
	benchmark?: string;
	params?: Record<string, ParamValue>;
	build?: string;
	instanceType?: string | null;
	zone?: string;
	zoneId?: string;
	/** Defaults to one boot per day. */
	boot?: string;
	/** Picks the cpuid, lscpu and sys_cpu sections. */
	processor?: string;
	/** Picks the kernel version in the kernel section. */
	kernel?: string;
	/** The TSC frequency in kHz in cpuid's hypervisor leaf 0x40000010, as calibrated at boot. */
	tscKhz?: number;
	/** lscpu's BogoMIPS field, as calibrated at boot. */
	bogomips?: string;
	/** Another cpuid line, as a processor with other features or microcode would print. */
	cpuidLine?: string;
	/** lscpu's Flags field. */
	lscpuFlags?: string;
	/** Picks the binary's bytes. */
	binary?: string;
	/** Each counted sample's sample_ended.t minus sample_started.t. */
	samplesNs?: number[];
	repetitions?: number;
	bytesPerRepetition?: number | null;
	exit?: RunExit;
	/** LM_SAMPLES; defaults to the number of samplesNs. */
	samples?: number;
	/** The stream stops after this many counted samples: no verified, no finished. */
	crashAfter?: number;
	quick?: boolean;
	/**
	 * Adds the sections the dump gained for the disk benchmarks, shaped like
	 * runner/run.py's: block_stat and nvme_stats differ on every dump; provision,
	 * ec2_volumes and ec2_instance on every boot; ec2_instance_type holds this
	 * catalog revision on every boot.
	 */
	diskSections?: { catalog?: string };
	/**
	 * Written as runners wrote Runs before stdout became the one source of
	 * their events: the events copied into the record too, and no
	 * stdout_bytes or stdout_lines.
	 */
	eventsInside?: boolean;
	/** The stdout blob's text, instead of the stream made from the options above. */
	stdout?: string;
	/**
	 * Adds the sections the dump gained for the Service benchmarks, shaped like
	 * runner/run.py's: net_counters differs on every dump; network, and the EC2
	 * API's route tables and VPC endpoints, are the same on every boot.
	 */
	networkSections?: boolean;
}

export const DEFAULT_PARAMS = { size_bytes: 1073741824, threads: 1, path: "scalar" };

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** 2026-11-12T22:15:00Z as 2026-11-12T22:15:00.000000000Z */
function nanoTime(iso: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) throw new Error(`not a time: ${iso}`);
	return `${new Date(ms).toISOString().slice(0, 19)}.${String(ms % 1000).padStart(3, "0")}000000Z`;
}

export class HandMade {
	readonly files: RunFile[] = [];
	readonly blobs = new Map<string, Uint8Array>();
	private count = 0;

	put(content: Uint8Array | string): string {
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const hash = `sha256:${sha256(bytes)}`;
		this.blobs.set(hash, bytes);
		return hash;
	}

	private section(value: unknown): string {
		return this.put(`${JSON.stringify(value, null, 1)}\n`);
	}

	private dump(
		moment: "before" | "after",
		o: Required<Pick<HandMadeRun, "processor" | "kernel" | "tscKhz" | "bogomips" | "cpuidLine" | "lscpuFlags">> & {
			boot: string;
			startedAt: string;
			n: number;
			diskSections: HandMadeRun["diskSections"];
			networkSections?: boolean;
		},
	): string {
		// Shaped like runner/cpuid.c's output and lscpu -J's, for four CPUs.
		const hex = (value: number): string => `0x${value.toString(16).padStart(8, "0")}`;
		const cpuid = [0, 1, 2, 3]
			.map((cpu) =>
				[
					`CPU ${cpu}:`,
					"   0x00000000 0x00: eax=0x0000001b ebx=0x756e6547 ecx=0x6c65746e edx=0x49656e69",
					`   0x00000001 0x00: eax=0x000606a6 ebx=${hex(0x800 + (cpu << 24))} ecx=0xfffa3203 edx=0x1f8bfbff`,
					`   0x80000002 0x00: brand=${o.processor}`,
					...(o.cpuidLine === "" ? [] : [`   ${o.cpuidLine}`]),
					`   0x40000000 0x00: eax=0x40000010 ebx=0x4b4d564b ecx=0x564b4d56 edx=0x0000004d`,
					`   0x40000010 0x00: eax=${hex(o.tscKhz)} ebx=0x000f4240 ecx=0x00000000 edx=0x00000000`,
				].join("\n"),
			)
			.join("\n");
		const lscpu = JSON.stringify(
			{
				lscpu: [
					{ field: "Architecture:", data: "x86_64" },
					{ field: "Model name:", data: o.processor },
					{ field: "BogoMIPS:", data: o.bogomips },
					{ field: "Flags:", data: o.lscpuFlags },
				],
			},
			null,
			3,
		);
		const sections = {
			cpuid: this.section({ "$ cpuid": { exit: 0, stderr: "", stdout: `${cpuid}\n` } }),
			cpuinfo: this.section({ "/proc/cpuinfo": `model name: ${o.processor}\ncpu MHz: ${2900 + o.n}.${moment === "before" ? 1 : 2}\n` }),
			lscpu: this.section({ "$ lscpu -J": { exit: 0, stderr: "", stdout: `${lscpu}\n` } }),
			sys_cpu: this.section({ "/sys/devices/system/cpu/online": "0-31\n", "/sys/devices/system/cpu/cpu0/microcode/version": `${o.processor}-ucode\n` }),
			kernel: this.section({
				"$ uname -a": { exit: 0, stderr: "", stdout: `Linux ip-host-${o.boot} ${o.kernel} x86_64 GNU/Linux\n` },
				"/proc/version": `Linux version ${o.kernel}\n`,
				"/sys/kernel/mm/transparent_hugepage/enabled": "always [madvise] never\n",
			}),
			memory: this.section({ "/proc/uptime": `${o.n}.${moment === "before" ? 1 : 2} 1.0\n` }),
			devices: this.section({ "/sys/class/nvme/nvme0/serial": `vol-serial-${o.boot}\n` }),
			process: this.section({ allowed_cpus: [0, 1, 2, 3] }),
			packages: this.section({ "$ rpm -qa (sorted)": { exit: 0, stderr: "", stdout: "gcc-11.5.0\nglibc-2.34\n" } }),
			provider: this.section({ "http://169.254.169.254/latest/meta-data/instance-id": `i-${o.boot}` }),
			...(o.diskSections === undefined ? {} : this.diskSections(moment, o.boot, o.n, o.diskSections.catalog ?? "revision 1")),
			...(o.networkSections ? this.networkSections(moment, o.n) : {}),
		};
		return this.put(`${JSON.stringify({ schema: "ledgermath.dump/1", taken_at: o.startedAt, sections }, null, 2)}\n`);
	}

	private diskSections(moment: "before" | "after", boot: string, n: number, catalog: string): Record<string, string> {
		const reads = 1000 * n + (moment === "before" ? 1 : 2);
		const command = (stdout: string) => ({ exit: 0, stderr: "", stdout });
		return {
			block_stat: this.section({ "/sys/block/nvme0n1/stat": `${reads} 0 ${reads * 8} 10 0 0 0 0 0 20 30\n` }),
			nvme_stats: this.section({ "$ nvme amzn stats /dev/nvme0n1 -o json": command(`{"total_read_ops": ${reads}}\n`) }),
			provision: this.section({
				"/var/tmp/ledgermath/provision.json": `{"schema": "ledgermath.provision/1", "started_at": "${boot} 00:01", "steps": []}\n`,
			}),
			ec2_instance_type: this.section({ "$ aws ec2 describe-instance-types --instance-types c6i.8xlarge": command(`{"InstanceTypes": ["${catalog}"]}\n`) }),
			ec2_volumes: this.section({ "$ aws ec2 describe-volumes": command(`{"Volumes": [{"VolumeId": "vol-${boot}"}]}\n`) }),
			ec2_instance: this.section({ "$ aws ec2 describe-instances --instance-ids i-x": command(`{"InstanceId": "i-${boot}"}\n`) }),
		};
	}

	private networkSections(moment: "before" | "after", n: number): Record<string, string> {
		const packets = 1000 * n + (moment === "before" ? 1 : 2);
		const command = (stdout: string) => ({ exit: 0, stderr: "", stdout });
		return {
			network: this.section({ "/sys/class/net/ens5/mtu": "9001\n", "$ ethtool -i ens5": command("driver: ena\n") }),
			net_counters: this.section({
				"/proc/net/dev": `ens5: ${packets * 1500} ${packets}\n`,
				"$ ethtool -S ens5": command(`NIC statistics:\n     bw_in_allowance_exceeded: 0\n     rx_packets: ${packets}\n`),
			}),
			ec2_route_tables: this.section({ "$ aws ec2 describe-route-tables": command('{"RouteTables": []}\n') }),
			ec2_vpc_endpoints: this.section({ "$ aws ec2 describe-vpc-endpoints": command('{"VpcEndpoints": []}\n') }),
		};
	}

	/** Makes a Run, keeps it in files and its blobs in blobs, and returns it. */
	run(options: HandMadeRun): Run {
		const n = this.count++;
		const startedAt = nanoTime(options.startedAt);
		const ms = Date.parse(options.startedAt);
		const boot = options.boot ?? `boot-${startedAt.slice(0, 10)}`;
		const samplesNs = options.samplesNs ?? Array.from({ length: 10 }, () => 1_000_000_000);
		const repetitions = options.repetitions ?? 100;
		const bytes = options.bytesPerRepetition === undefined ? 1073741824 : options.bytesPerRepetition;
		const processor = options.processor ?? "Intel(R) Xeon(R) Platinum 8375C";
		const kernel = options.kernel ?? "6.1.176-221.360.amzn2023.x86_64";
		const calibrated = {
			tscKhz: options.tscKhz ?? 2_899_996,
			bogomips: options.bogomips ?? "5799.99",
			cpuidLine: options.cpuidLine ?? "",
			lscpuFlags: options.lscpuFlags ?? "fpu vme de pse tsc avx2 avx512f",
		};

		const events: RunEvent[] = [];
		let t = 1_000_000;
		events.push({ event: "started", t, schema: "ledgermath.events/1", wall_utc: startedAt, clock: "CLOCK_MONOTONIC_RAW", clock_read_ns: 20, quick: options.quick ?? false });
		t += 1000;
		events.push({ event: "observed", t, values: { ...(bytes === null ? {} : { bytes_per_repetition: bytes }), threads_used: 1, path_taken: "scalar" } });
		events.push({ event: "sample_started", t: (t += 1000), sample: 0, warmup: true, repetitions: 1 });
		events.push({ event: "sample_ended", t: (t += 5_000_000), sample: 0 });
		const counted = options.crashAfter ?? samplesNs.length;
		samplesNs.slice(0, counted).forEach((ns, i) => {
			events.push({ event: "sample_started", t: (t += 1000), sample: i + 1, warmup: false, repetitions });
			events.push({ event: "sample_ended", t: (t += ns), sample: i + 1 });
		});
		if (options.crashAfter === undefined) {
			events.push({ event: "verified", t: (t += 1000), checksum: "0x0000000000000001" });
			events.push({ event: "finished", t: (t += 1000) });
		}

		const hex = ms.toString(16).padStart(12, "0");
		const tail = sha256(`hand-made ${n}`);
		const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18)}`;
		const stdout = options.stdout ?? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
		const stdoutBytes = new TextEncoder().encode(stdout);
		const run: Run = {
			schema: "ledgermath.run/1",
			id,
			boot,
			started_at: startedAt,
			ended_at: nanoTime(new Date(ms + 15_000).toISOString()),
			benchmark: options.benchmark ?? "memory_read",
			params: options.params ?? DEFAULT_PARAMS,
			samples: options.samples ?? samplesNs.length,
			source_commit: "0123456789abcdef0123456789abcdef01234567",
			source: this.put("a source archive"),
			binary: {
				blob: this.put(`binary: ${options.binary ?? "memory_read"} ${options.build ?? "static"}`),
				build: options.build ?? "static",
				compiler: "cc (GCC) 11.5.0",
				command: "cc -O3 -march=native",
				resolved_flags: this.put("-march=icelake-server"),
			},
			provider: {
				name: "aws",
				instance_type: options.instanceType === undefined ? "c6i.8xlarge" : options.instanceType,
				region: "us-east-2",
				availability_zone: options.zone ?? "us-east-2c",
				availability_zone_id: options.zoneId ?? "use2-az3",
				image_id: "ami-0123456789abcdef0",
				instance_id: `i-${boot}`,
			},
			environment: {
				before: this.dump("before", { processor, kernel, ...calibrated, boot, startedAt, n, diskSections: options.diskSections, networkSections: options.networkSections }),
				after: this.dump("after", { processor, kernel, ...calibrated, boot, startedAt, n, diskSections: options.diskSections, networkSections: options.networkSections }),
			},
			runner: this.put("a runner manifest"),
			exit: options.exit ?? { code: 0 },
			...(options.eventsInside ? { events } : {}),
			stdout: this.put(stdout),
			...(options.eventsInside ? {} : { stdout_bytes: stdoutBytes.length, stdout_lines: readStream(stdoutBytes).lines }),
			stderr: this.put(""),
		};
		const bytesOfFile = new TextEncoder().encode(`${JSON.stringify(run, null, 2)}\n`);
		this.files.push({ path: `runs/${startedAt.slice(0, 4)}/${startedAt.slice(5, 7)}/${startedAt.slice(8, 10)}/${id}.json`, sha256: sha256(bytesOfFile), record: run });
		return run;
	}

	readonly fetch: FetchBlob = async (hash) => this.blobs.get(hash) ?? null;

	/** Writes runs/ and blobs/sha256/ under directory, laid out like the bucket. */
	writeTo(directory: string): void {
		for (const file of this.files) {
			const path = join(directory, file.path);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(file.record, null, 2)}\n`);
		}
		mkdirSync(join(directory, "blobs", "sha256"), { recursive: true });
		for (const [hash, bytes] of this.blobs) writeFileSync(join(directory, "blobs", "sha256", hash.slice("sha256:".length)), bytes);
	}
}
