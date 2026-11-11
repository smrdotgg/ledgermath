/**
 * Hand-made streams of requests for tests: the stdout an http_get Run's
 * binary writes (benchmarks/http_get/README.md, "One request's events"),
 * made to order, with each phase's time chosen. Shaped like the real streams
 * of 2026-11-11, trimmed to the fields a reader needs; nothing in them was
 * measured.
 */

import type { RunEvent } from "../methods/run";
import { HandMade, type HandMadeRun } from "./hand-made-runs";

/** Phase times in nanoseconds; a new connection's dns, connect and tls are ignored over a reused one. */
export interface Phases {
	dns: number;
	connect: number;
	tls: number;
	send: number;
	first_byte: number;
	headers: number;
	body: number;
}

export interface Request {
	/** Defaults to DEFAULT_PHASES. */
	phases?: Partial<Phases>;
	/** The server's address, for a new connection (a reused one takes its connection's). */
	address?: string;
	cipher?: string;
	/** A status that is not 2xx: a complete response, then the request has failed. */
	status?: number;
	/** The request fails, after the phases before `phase`, with request_failed. */
	fail?: { phase: "dns" | "connect" | "tls" | "send" | "first_byte" | "headers" | "body"; error: string };
	/** The body did not match the Fixture (the binary then exits 1). */
	mismatch?: boolean;
}

export interface Stream {
	connection: "new" | "reused";
	/** The counted requests; a warmup request goes before them. */
	requests: Request[];
	warmup?: Request;
	/** Over a reused connection, the server closes the connection after this many requests (S3: 100). */
	requestsPerConnection?: number;
	/** The address and cipher of each reused connection, in turn. */
	reusedAddresses?: string[];
	/** A reused connection's setup that fails outside any sample before the first request. */
	setupFailure?: { phase: string; error: string };
	/** The stream stops after this many counted requests: no observed, verified or finished. */
	crashAfter?: number;
	/** The Run ended at its budget after this many counted requests (the binary's ended_early). */
	endedEarlyAfter?: number;
	/** Gap between requests, in ns. */
	gap?: number;
	/** sigv4 (the default): every request_sent carries `signing`; none: none does. */
	auth?: "sigv4" | "none";
}

export const DEFAULT_PHASES: Phases = { dns: 200_000, connect: 900_000, tls: 2_200_000, send: 10_000, first_byte: 25_000_000, headers: 8_000, body: 12_000 };

const HOST = "fixtures.s3.us-east-2.amazonaws.com";

/** The stream's text, a line per event. */
export function requestStream(spec: Stream): string {
	const events: RunEvent[] = [];
	let t = 1_000_000_000;
	const push = (event: string, fields: Record<string, unknown> = {}): void => {
		events.push({ event, t, ...fields });
	};
	push("started", { schema: "ledgermath.events/1", wall_utc: "2026-11-11T21:35:46.378999800Z", clock: "CLOCK_MONOTONIC_RAW", clock_read_ns: 22.5, quick: false });
	t += 8_000_000;
	push("observed", { values: { tls_library: "AWS-LC 5.14.0", resolver: "172.31.0.2:53" } });
	let connection = -1;
	let used = 0;
	let closed = false;
	let reusedIndex = 0;
	const addresses = spec.reusedAddresses ?? ["3.5.133.225"];
	const openConnection = (request: number | null, address: string, cipher: string, phases: Phases, failAt: string | null): boolean => {
		const withRequest = request === null ? {} : { request };
		t += phases.dns;
		push("name_resolved", { ...withRequest, server: "172.31.0.2:53", name: HOST, rcode: 0, truncated: false, answers: [`s3-r-w.us-east-2.amazonaws.com. 5 A ${address}`], address });
		connection++;
		t += phases.connect;
		// As the binary does, a connect that failed is still written, without nodelay and local.
		if (failAt === "connect") {
			push("connection_opened", { connection, ...withRequest, address, port: 443 });
			return false;
		}
		push("connection_opened", { connection, ...withRequest, address, port: 443, nodelay: true, local: "192.0.2.10:50000" });
		if (failAt === "tls") return false;
		t += phases.tls;
		push("connection_secured", { connection, tls: "TLSv1.3", cipher, group: "X25519MLKEM768", alpn: "http/1.1", verify: "ok", peer_chain_sha256: ["ffb529f1"] });
		if (connection === 0) push("certificate", { sha256: "ffb529f1", der_base64: "MIIB" });
		used = 0;
		return true;
	};
	if (spec.connection === "reused") {
		if (spec.setupFailure !== undefined) {
			t += 300_000;
			push("connection_failed", { phase: spec.setupFailure.phase, error: spec.setupFailure.error, detail: "made by hand" });
		}
		openConnection(null, addresses[0] as string, "TLS_AES_128_GCM_SHA256", DEFAULT_PHASES, null);
	}

	const all: Array<{ request: Request; warmup: boolean }> = [{ request: spec.warmup ?? {}, warmup: true }, ...spec.requests.map((request) => ({ request, warmup: false }))];
	let made = 0;
	for (const [sample, { request, warmup }] of all.entries()) {
		if (!warmup && spec.crashAfter !== undefined && made >= spec.crashAfter) return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
		if (!warmup && spec.endedEarlyAfter !== undefined && made >= spec.endedEarlyAfter) break;
		const phases: Phases = { ...DEFAULT_PHASES, ...request.phases };
		t += spec.gap ?? 200_000_000;
		if (spec.connection === "reused" && (closed || (spec.requestsPerConnection !== undefined && used >= spec.requestsPerConnection))) {
			if (!closed) push("connection_closed", { connection, reason: "server_requested", requests: used });
			closed = false;
			reusedIndex++;
			t += 1_000_000;
			openConnection(null, addresses[reusedIndex % addresses.length] as string, "TLS_AES_128_GCM_SHA256", DEFAULT_PHASES, null);
			t += 1_000_000;
		}
		push("sample_started", { sample, warmup, repetitions: 1 });
		const fail = request.fail;
		const failed = (): void => {
			push("request_failed", { request: sample, phase: fail?.phase, error: fail?.error, detail: "made by hand", bytes_received: 0 });
			push("sample_ended", { sample });
			t += 50_000;
			push("connection_closed", { connection, reason: "failed", requests: 1 });
			closed = true;
		};
		if (spec.connection === "new") {
			if (fail?.phase === "dns") {
				t += phases.dns;
				failed();
				if (!warmup) made++;
				continue;
			}
			const opened = openConnection(sample, request.address ?? "3.5.133.225", request.cipher ?? "TLS_AES_128_GCM_SHA256", phases, fail?.phase === "connect" || fail?.phase === "tls" ? fail.phase : null);
			if (!opened) {
				if (fail?.phase === "tls") t += phases.tls;
				failed();
				if (!warmup) made++;
				continue;
			}
		}
		if (fail?.phase === "send") {
			t += phases.send;
			failed();
			if (!warmup) made++;
			continue;
		}
		t += phases.send;
		const signing = (spec.auth ?? "sigv4") === "sigv4" ? { signing: { algorithm: "AWS4-HMAC-SHA256", credential_scope: "20261111/us-east-2/s3/aws4_request", signed_headers: ["host", "x-amz-date"] } } : {};
		push("request_sent", { request: sample, connection, method: "GET", target: "/http_get/v1/4096", request_bytes: 1386, ...signing });
		used++;
		if (fail?.phase === "first_byte") {
			t += phases.first_byte;
			failed();
			if (!warmup) made++;
			continue;
		}
		t += phases.first_byte;
		push("first_byte", { request: sample, cpu_ns: 14000 });
		if (fail?.phase === "headers") {
			t += phases.headers;
			failed();
			if (!warmup) made++;
			continue;
		}
		t += phases.headers;
		const status = request.status ?? 200;
		push("response_headers", { request: sample, status_line: `HTTP/1.1 ${status} X`, status, headers: [["Content-Length", "4096"]] });
		if (fail?.phase === "body") {
			t += phases.body;
			failed();
			if (!warmup) made++;
			continue;
		}
		t += phases.body;
		const body = status >= 200 && status <= 299 ? { body_sha256: "72f8", fixture: request.mismatch ? "mismatch" : "match", s3_checksum: request.mismatch ? "mismatch" : "match" } : { error_fields: { Code: "SlowDown" } };
		push("response_ended", { request: sample, bytes: 4096, wire_bytes: 4096, framing: "length", ...body });
		push("sample_ended", { sample });
		if (spec.connection === "new") {
			t += 100_000;
			push("connection_closed", { connection, reason: "done", requests: 1 });
		}
		if (!warmup) made++;
	}
	if (spec.connection === "reused") {
		t += 100_000;
		push("connection_closed", { connection, reason: "end_of_run", requests: used });
	}
	t += 100_000;
	const notMade = spec.requests.length - made;
	push("observed", { values: { requests_made: made + 1, requests_not_made: notMade, ended_early: notMade > 0 ? "budget" : null } });
	t += 5_000;
	push("verified", { checksum: "0xbaa446f9e944ecf5" });
	t += 10_000;
	push("finished");
	return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/** The params of the study's sets. */
export const paramsOf = (objectBytes: number, connection: "new" | "reused"): Record<string, string | number> => ({
	object_bytes: objectBytes,
	key: `http_get/v1/${objectBytes}`,
	connection,
	budget_seconds: 240,
	gap_mean_ms: 200,
	timeout_ms: 10000,
	ca_file: "/etc/pki/tls/certs/ca-bundle.crt",
	resolv_conf: "/etc/resolv.conf",
	auth: "sigv4",
});

/** Adds an http_get Run with this stream to `made`. */
export function requestRun(made: HandMade, options: Partial<HandMadeRun> & { startedAt: string; stream: Stream; objectBytes?: number }): ReturnType<HandMade["run"]> {
	const { stream, objectBytes, ...rest } = options;
	return made.run({
		benchmark: "http_get",
		binary: "http_get",
		params: { ...paramsOf(objectBytes ?? 4096, stream.connection), auth: stream.auth ?? "sigv4" },
		samples: stream.requests.length,
		networkSections: true,
		...rest,
		stdout: requestStream(stream),
	});
}

/** n requests over a new connection whose total times are from, from + step, …, set by first_byte. */
export function rampRequests(n: number, from = 10_000_000, step = 1_000_000): Request[] {
	const fixed = DEFAULT_PHASES.dns + DEFAULT_PHASES.connect + DEFAULT_PHASES.tls + DEFAULT_PHASES.send + DEFAULT_PHASES.headers + DEFAULT_PHASES.body;
	return Array.from({ length: n }, (_, i) => ({ phases: { first_byte: from + i * step - fixed } }));
}

export { HandMade };
