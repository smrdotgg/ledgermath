/**
 * Method requests, version 1: a stream read request by request. Each sample
 * of a stream whose samples are requests (benchmarks/http_get/README.md, "One
 * request's events") is one request: its phases from the event timestamps,
 * what its connection was (the server's address, the TLS version, cipher and
 * group negotiated), and whether it succeeded or how it failed.
 *
 * The phases, exactly as the binary's README defines each, from the two clock
 * reads that bound it:
 *
 *   dns         name_resolved − sample_started                  (new connection only)
 *   connect     connection_opened − name_resolved               (new connection only)
 *   tls         connection_secured − connection_opened          (new connection only)
 *   send        request_sent − connection_secured; over a reused connection, request_sent − sample_started
 *   first_byte  first_byte − request_sent
 *   headers     response_headers − first_byte
 *   body        response_ended − response_headers
 *   total       sample_ended − sample_started
 *
 * A request over a reused connection has only send, first_byte, headers,
 * body and total: its connection was opened outside any sample.
 */

import type { RunEvent } from "../../run";

export const PHASES = ["dns", "connect", "tls", "send", "first_byte", "headers", "body", "total"] as const;
export type Phase = (typeof PHASES)[number];

/** Each phase in words, for the page and the file. */
export const PHASE_WORDS: Readonly<Record<Phase, { name: string; interval: string }>> = {
	dns: { name: "name lookup", interval: "name_resolved.t − sample_started.t (new connection only)" },
	connect: { name: "connect (TCP)", interval: "connection_opened.t − name_resolved.t (new connection only)" },
	tls: { name: "TLS handshake", interval: "connection_secured.t − connection_opened.t (new connection only)" },
	send: { name: "send the request", interval: "request_sent.t − connection_secured.t; over a reused connection, request_sent.t − sample_started.t" },
	first_byte: { name: "wait for the first byte", interval: "first_byte.t − request_sent.t" },
	headers: { name: "headers", interval: "response_headers.t − first_byte.t" },
	body: { name: "body", interval: "response_ended.t − response_headers.t" },
	total: { name: "whole request", interval: "sample_ended.t − sample_started.t" },
};

/** The facts each request records about its connection, which the pooled figures are broken down by. */
export const REQUEST_FACTS = ["address_block", "cipher", "tls_version", "tls_group"] as const;
export type RequestFact = (typeof REQUEST_FACTS)[number];

export const REQUEST_FACT_WORDS: Readonly<Record<RequestFact, string>> = {
	address_block:
		"the server's address block: the /16 of the IPv4 address connected to (connection_opened.address), written a.b.0.0/16; any other address whole",
	cipher: "the TLS cipher suite negotiated (connection_secured.cipher)",
	tls_version: "the TLS version negotiated (connection_secured.tls)",
	tls_group: "the key-exchange group negotiated (connection_secured.group)",
};

/** A request that succeeded: each of its phases in nanoseconds, and its connection's facts. */
export interface Succeeded {
	phases: Partial<Record<Phase, number>>;
	facts: Record<RequestFact, string>;
}

/** How a request failed: where it was, and what kind of failure. */
export interface Failure {
	/**
	 * request_failed.phase (dns, connect, tls, send, first_byte, headers, body);
	 * "response" for a complete response whose status is not 2xx; "record" for
	 * a request one of whose lines the binary withheld (line_withheld).
	 */
	phase: string;
	/** request_failed.error; status_<code> for a status that is not 2xx; line_withheld. */
	kind: string;
}

export interface ReadRequests {
	/** Every counted request that succeeded, in stream order. */
	succeeded: Succeeded[];
	/** Every counted request that failed, in stream order. */
	failed: Failure[];
	/** How the warmup request failed, or null when it succeeded or there was none. */
	warmupFailure: Failure | null;
	/** Reused-connection setups that failed outside any sample (connection_failed). */
	setupsFailed: Failure[];
	/** Where the stream breaks the request contract; the other fields are not to be used when there is one. */
	problems: string[];
}

/** a.b.0.0/16 for an IPv4 address, any other address as it is. */
export function addressBlock(address: string): string {
	const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
	return match === null ? address : `${match[1]}.${match[2]}.0.0/16`;
}

/**
 * Whether a stream's samples are requests: it holds a response_ended or a
 * request_failed carrying a whole-number `request`, the two ways a request
 * ends in the binary's contract. A Series is the Method's when any of its
 * Runs' streams is.
 */
export function holdsRequests(events: readonly RunEvent[]): boolean {
	return events.some((event) => (event.event === "response_ended" || event.event === "request_failed") && Number.isInteger(event.request));
}

interface Connection {
	address: string | null;
	tls: string | null;
	cipher: string | null;
	group: string | null;
}

const WORD = /^[a-z][a-z0-9_]*$/;
const NEW_CONNECTION = ["name_resolved", "connection_opened", "connection_secured", "request_sent", "first_byte", "response_headers", "response_ended"];
const REUSED_CONNECTION = ["request_sent", "first_byte", "response_headers", "response_ended"];
/** Events a sample may hold that are not part of its request's sequence. */
const ASIDE = new Set(["certificate"]);

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * Reads the requests of a stream that obeys the contract's order (no problem
 * from the schema or the order rules, which the caller has checked). Each
 * sample is one request:
 *
 * - it failed when it holds a request_failed (phase and error from it), or
 *   its response's status (response_headers.status) is not 2xx; a request
 *   one of whose lines was withheld (line_withheld) is counted apart, as a
 *   failure of the record, and in no time;
 * - it succeeded when its status is 2xx and its body matched the Fixture and
 *   S3's checksum (response_ended.fixture and .s3_checksum "match"). Its events
 *   must then be, in order, name_resolved, connection_opened,
 *   connection_secured, request_sent, first_byte, response_headers,
 *   response_ended (a new connection), or the last four (a reused one, whose
 *   connection was opened and secured before the sample), every phase at
 *   least 0, sample_ended at the same t as response_ended, and every
 *   `request` in the sample the same.
 *
 * Anything else is a problem: the Run breaks the contract and is in no figure.
 */
export function readRequests(events: readonly RunEvent[]): ReadRequests {
	const result: ReadRequests = { succeeded: [], failed: [], warmupFailure: null, setupsFailed: [], problems: [] };
	const connections = new Map<number, Connection>();
	let open: { start: RunEvent; inside: RunEvent[] } | null = null;

	const connectionOf = (id: unknown): Connection => {
		if (!Number.isInteger(id)) return { address: null, tls: null, cipher: null, group: null };
		let found = connections.get(id as number);
		if (found === undefined) {
			found = { address: null, tls: null, cipher: null, group: null };
			connections.set(id as number, found);
		}
		return found;
	};
	const note = (event: RunEvent): void => {
		if (event.event === "connection_opened") connectionOf(event.connection).address = text(event.address);
		else if (event.event === "connection_secured") {
			const connection = connectionOf(event.connection);
			connection.tls = text(event.tls);
			connection.cipher = text(event.cipher);
			connection.group = text(event.group);
		}
	};

	const failure = (where: string, phase: unknown, kind: unknown): Failure | null => {
		if (typeof phase !== "string" || !WORD.test(phase) || typeof kind !== "string" || !WORD.test(kind)) {
			result.problems.push(`${where}: phase and error must be words of a-z, 0-9 and _, got ${JSON.stringify(phase)} and ${JSON.stringify(kind)}`);
			return null;
		}
		return { phase, kind };
	};

	const close = (start: RunEvent, inside: RunEvent[], end: RunEvent): void => {
		const sample = start.sample as number;
		const warmup = start.warmup === true;
		const sequence = inside.filter((event) => !ASIDE.has(event.event));
		const keep = (outcome: Failure | null): void => {
			if (outcome === null) return;
			if (warmup) result.warmupFailure ??= outcome;
			else result.failed.push(outcome);
		};
		const withheld = sequence.find((event) => event.event === "line_withheld");
		if (withheld !== undefined) {
			const kind = typeof withheld.withheld_event === "string" && WORD.test(withheld.withheld_event) ? `line_withheld_${withheld.withheld_event}` : "line_withheld";
			keep({ phase: "record", kind });
			return;
		}
		const failed = sequence.find((event) => event.event === "request_failed");
		if (failed !== undefined) {
			if (sequence.at(-1) !== failed) result.problems.push(`sample ${sample}: request_failed is not the request's last event`);
			if (failed.t !== end.t) result.problems.push(`sample ${sample}: sample_ended is not at request_failed's t`);
			keep(failure(`sample ${sample}: request_failed`, failed.phase, failed.error));
			return;
		}
		const headers = sequence.find((event) => event.event === "response_headers");
		const ended = sequence.find((event) => event.event === "response_ended");
		if (headers === undefined || ended === undefined) {
			result.problems.push(`sample ${sample}: the request neither failed (request_failed) nor ended with a response (response_headers and response_ended)`);
			return;
		}
		const status = headers.status;
		if (!Number.isInteger(status)) {
			result.problems.push(`sample ${sample}: response_headers.status is not a whole number`);
			return;
		}
		if ((status as number) < 200 || (status as number) > 299) {
			if (ended.t !== end.t) result.problems.push(`sample ${sample}: sample_ended is not at response_ended's t`);
			keep({ phase: "response", kind: `status_${status as number}` });
			return;
		}
		if (ended.fixture !== "match" || ended.s3_checksum !== "match") {
			result.problems.push(
				`sample ${sample}: a ${status as number} response whose body did not match (fixture ${JSON.stringify(ended.fixture)}, s3_checksum ${JSON.stringify(ended.s3_checksum)}), which the binary reports with exit code 1`,
			);
			return;
		}
		const names = sequence.map((event) => event.event);
		const isNew = names.length === NEW_CONNECTION.length && names.every((name, i) => name === NEW_CONNECTION[i]);
		const isReused = names.length === REUSED_CONNECTION.length && names.every((name, i) => name === REUSED_CONNECTION[i]);
		if (!isNew && !isReused) {
			result.problems.push(`sample ${sample}: a 2xx response whose events are ${names.join(", ")}, neither a new connection's (${NEW_CONNECTION.join(", ")}) nor a reused one's (${REUSED_CONNECTION.join(", ")})`);
			return;
		}
		const at = (name: string): RunEvent => sequence.find((event) => event.event === name) as RunEvent;
		const requests = new Set(sequence.filter((event) => "request" in event).map((event) => event.request));
		if (requests.size !== 1 || !Number.isInteger([...requests][0])) {
			result.problems.push(`sample ${sample}: its events name ${requests.size === 1 ? "no whole-number request" : `${requests.size} requests`}`);
			return;
		}
		const sent = at("request_sent");
		if (isNew) {
			const opened = at("connection_opened");
			const secured = at("connection_secured");
			if (opened.connection !== secured.connection || secured.connection !== sent.connection) {
				result.problems.push(`sample ${sample}: the connection opened, secured and sent on are not one connection`);
				return;
			}
		}
		const connection = Number.isInteger(sent.connection) ? connections.get(sent.connection as number) : undefined;
		if (connection === undefined || connection.address === null || connection.cipher === null || connection.tls === null || connection.group === null) {
			result.problems.push(`sample ${sample}: request_sent names connection ${JSON.stringify(sent.connection)}, which no connection_opened and connection_secured before it describe`);
			return;
		}
		if (ended.t !== end.t) {
			result.problems.push(`sample ${sample}: sample_ended is not at response_ended's t`);
			return;
		}
		const phases: Partial<Record<Phase, number>> = {};
		const span = (phase: Phase, from: RunEvent, to: RunEvent): void => {
			phases[phase] = to.t - from.t;
		};
		if (isNew) {
			span("dns", start, at("name_resolved"));
			span("connect", at("name_resolved"), at("connection_opened"));
			span("tls", at("connection_opened"), at("connection_secured"));
			span("send", at("connection_secured"), sent);
		} else span("send", start, sent);
		span("first_byte", sent, at("first_byte"));
		span("headers", at("first_byte"), headers);
		span("body", headers, ended);
		span("total", start, end);
		const negative = PHASES.filter((phase) => (phases[phase] ?? 0) < 0);
		if (negative.length > 0) {
			result.problems.push(`sample ${sample}: ${negative.join(", ")} ${negative.length === 1 ? "is" : "are"} less than 0`);
			return;
		}
		if (!warmup) {
			result.succeeded.push({
				phases,
				facts: {
					address_block: addressBlock(connection.address),
					cipher: connection.cipher,
					tls_version: connection.tls,
					tls_group: connection.group,
				},
			});
		}
	};

	for (const event of events) {
		if (event.event === "sample_started") {
			open = { start: event, inside: [] };
			continue;
		}
		if (event.event === "sample_ended") {
			if (open !== null) close(open.start, open.inside, event);
			open = null;
			continue;
		}
		note(event);
		if (open !== null) open.inside.push(event);
		else if (event.event === "connection_failed") {
			const outcome = failure("connection_failed", event.phase, event.error);
			if (outcome !== null) result.setupsFailed.push(outcome);
		}
	}
	return result;
}
