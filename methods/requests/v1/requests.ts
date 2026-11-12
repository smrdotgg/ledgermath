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

/** The facts each succeeded request records, of its connection and of itself, which the pooled figures are broken down by. */
export const REQUEST_FACTS = ["address_block", "cipher", "tls_version", "tls_group", "method", "target", "signing"] as const;
export type RequestFact = (typeof REQUEST_FACTS)[number];

export const REQUEST_FACT_WORDS: Readonly<Record<RequestFact, string>> = {
	address_block:
		"the server's address block: the /16 of the IPv4 address connected to (connection_opened.address), written a.b.0.0/16; any other address whole",
	cipher: "the TLS cipher suite negotiated (connection_secured.cipher)",
	tls_version: "the TLS version negotiated (connection_secured.tls)",
	tls_group: "the key-exchange group negotiated (connection_secured.group)",
	method: "the request's method, as sent (request_sent.method)",
	target: "the request's target, as sent (request_sent.target)",
	signing: "how the request was signed, as sent: request_sent.signing.algorithm, or unsigned when the request carries no signing",
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
	/** A connection_closed for it has been seen. */
	closed: boolean;
}

const WORD = /^[a-z][a-z0-9_]*$/;
const NEW_CONNECTION = ["name_resolved", "connection_opened", "connection_secured", "request_sent", "first_byte", "response_headers", "response_ended"];
const REUSED_CONNECTION = ["request_sent", "first_byte", "response_headers", "response_ended"];

/**
 * Where a request that failed must have got to, by its request_failed.phase,
 * as the binary writes it (benchmarks/http_get/http_get.c, setup_events,
 * setup_failure and exchange_events): the last event before request_failed,
 * or "" for none, over a new connection and over a reused one (null: the
 * phase cannot fail there).
 */
const LAST_BEFORE_FAILURE: Readonly<Record<string, { new: readonly string[]; reused: readonly string[] }>> = {
	dns: { new: ["", "name_resolved"], reused: [] },
	connect: { new: ["connection_opened"], reused: [] },
	tls: { new: ["connection_opened"], reused: [] },
	send: { new: ["connection_secured"], reused: [""] },
	first_byte: { new: ["request_sent"], reused: ["request_sent"] },
	headers: { new: ["first_byte"], reused: ["first_byte"] },
	body: { new: ["response_headers"], reused: ["response_headers"] },
};

const isPrefix = (names: readonly string[], of: readonly string[]): boolean => names.length <= of.length && names.every((name, i) => name === of[i]);
/** Events a sample may hold that are not part of its request's sequence. */
const ASIDE = new Set(["certificate"]);

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/**
 * Reads the requests of a stream that obeys the contract's order (no problem
 * from the schema or the order rules, which the caller has checked). Each
 * sample is one request, and every event in it that names a request names
 * the sample's own number (the binary's request number is its sample's).
 *
 * - It failed when it holds a request_failed: that must be its last event, at
 *   sample_ended's t, and the events before it must be the start of a new
 *   connection's sequence or a reused one's (below), up to where its phase
 *   says the request got (LAST_BEFORE_FAILURE), on one connection. It failed
 *   too when its response is complete and its status (response_headers.status)
 *   is not 2xx. A request one of whose lines was withheld (line_withheld, but
 *   for a certificate's) is counted apart, as a failure of the record. No
 *   failed request is timed.
 * - It succeeded when its status is 2xx and its body matched the Fixture and
 *   S3's checksum (response_ended.fixture and .s3_checksum "match").
 * - A complete response, 2xx or not, must have its events in order:
 *   name_resolved, connection_opened, connection_secured, request_sent,
 *   first_byte, response_headers, response_ended (a new connection, the
 *   three first on one connection), or the last four (a reused one, opened and
 *   secured before the sample and not closed since), every phase at least 0,
 *   and sample_ended at response_ended's t.
 *
 * Anything else is a problem: the Run breaks the contract and is in no figure.
 */
export function readRequests(events: readonly RunEvent[]): ReadRequests {
	const result: ReadRequests = { succeeded: [], failed: [], warmupFailure: null, setupsFailed: [], problems: [] };
	const connections = new Map<number, Connection>();
	let open: { start: RunEvent; inside: RunEvent[] } | null = null;

	const connectionOf = (id: unknown): Connection => {
		if (!Number.isInteger(id)) return { address: null, tls: null, cipher: null, group: null, closed: false };
		let found = connections.get(id as number);
		if (found === undefined) {
			found = { address: null, tls: null, cipher: null, group: null, closed: false };
			connections.set(id as number, found);
		}
		return found;
	};
	const note = (event: RunEvent): void => {
		if (event.event === "connection_opened") {
			const connection = connectionOf(event.connection);
			connection.address = text(event.address);
			connection.closed = false;
		} else if (event.event === "connection_secured") {
			const connection = connectionOf(event.connection);
			connection.tls = text(event.tls);
			connection.cipher = text(event.cipher);
			connection.group = text(event.group);
		} else if (event.event === "connection_closed") connectionOf(event.connection).closed = true;
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
		const where = `sample ${sample}`;
		const problem = (words: string): void => {
			result.problems.push(`${where}: ${words}`);
		};
		// A withheld line stands for the event it replaced: a certificate's is aside like the certificate.
		const sequence = inside.filter((event) => !ASIDE.has(event.event) && !(event.event === "line_withheld" && ASIDE.has(String(event.withheld_event))));
		const keep = (outcome: Failure | null): void => {
			if (outcome === null) return;
			if (warmup) result.warmupFailure ??= outcome;
			else result.failed.push(outcome);
		};
		const stranger = inside.find((event) => "request" in event && event.request !== sample);
		if (stranger !== undefined) return problem(`${stranger.event} names request ${JSON.stringify(stranger.request)}, not the sample's ${sample}`);
		const withheld = sequence.find((event) => event.event === "line_withheld");
		if (withheld !== undefined) {
			const kind = typeof withheld.withheld_event === "string" && WORD.test(withheld.withheld_event) ? `line_withheld_${withheld.withheld_event}` : "line_withheld";
			keep({ phase: "record", kind });
			return;
		}
		const names = sequence.map((event) => event.event);
		const at = (name: string): RunEvent | undefined => sequence.find((event) => event.event === name);
		/**
		 * The connection a request went over: opened and secured in the sample
		 * (new), or before it and not closed since (reused). "unsent" when the
		 * request was never sent (and what the sample opened is one connection);
		 * null, with a problem, when the events do not say one open connection.
		 */
		const connectionFor = (isNew: boolean): Connection | "unsent" | null => {
			const opened = at("connection_opened");
			const secured = at("connection_secured");
			const sent = at("request_sent");
			if (isNew && secured !== undefined && opened?.connection !== secured.connection) {
				problem("the connection opened and the connection secured are not one connection");
				return null;
			}
			if (sent === undefined) return "unsent";
			if (isNew && sent.connection !== opened?.connection) {
				problem("the request was sent on another connection than the one the sample opened");
				return null;
			}
			const connection = Number.isInteger(sent.connection) ? connections.get(sent.connection as number) : undefined;
			if (connection === undefined || connection.address === null || connection.cipher === null || connection.tls === null || connection.group === null) {
				problem(`request_sent names connection ${JSON.stringify(sent.connection)}, which no connection_opened and connection_secured before it describe`);
				return null;
			}
			if (connection.closed) {
				problem(`request_sent names connection ${JSON.stringify(sent.connection)}, which a connection_closed before it closed`);
				return null;
			}
			return connection;
		};

		const failedAt = names.indexOf("request_failed");
		if (failedAt >= 0) {
			const failed = sequence[failedAt] as RunEvent;
			if (failedAt !== names.length - 1) return problem("request_failed is not the request's last event");
			if (failed.t !== end.t) return problem("sample_ended is not at request_failed's t");
			const outcome = failure(`${where}: request_failed`, failed.phase, failed.error);
			if (outcome === null) return;
			const before = names.slice(0, failedAt);
			const last = before.at(-1) ?? "";
			const expected = LAST_BEFORE_FAILURE[outcome.phase];
			if (expected === undefined) return problem(`request_failed's phase ${JSON.stringify(outcome.phase)} is none of ${Object.keys(LAST_BEFORE_FAILURE).join(", ")}`);
			const asNew = isPrefix(before, NEW_CONNECTION.slice(0, -1)) && expected.new.includes(last);
			const asReused = isPrefix(before, REUSED_CONNECTION.slice(0, -1)) && expected.reused.includes(last);
			if (!asNew && !asReused) {
				return problem(
					`a request that failed in phase ${outcome.phase} after ${before.length === 0 ? "no event" : before.join(", ")}: that is not where a new connection's (${NEW_CONNECTION.join(", ")}) or a reused one's (${REUSED_CONNECTION.join(", ")}) request fails in that phase`,
				);
			}
			// What it opened is one connection, and a request that got as far as being sent went over an open one.
			if (connectionFor(asNew) === null) return;
			keep(outcome);
			return;
		}

		const isNew = names.length === NEW_CONNECTION.length && names.every((name, i) => name === NEW_CONNECTION[i]);
		const isReused = names.length === REUSED_CONNECTION.length && names.every((name, i) => name === REUSED_CONNECTION[i]);
		if (!isNew && !isReused) {
			return problem(
				`a request that neither failed (request_failed) nor has a complete response's events in order: ${names.length === 0 ? "none" : names.join(", ")}, neither a new connection's (${NEW_CONNECTION.join(", ")}) nor a reused one's (${REUSED_CONNECTION.join(", ")})`,
			);
		}
		const connection = connectionFor(isNew);
		if (connection === null || connection === "unsent") return;
		const sent = at("request_sent") as RunEvent;
		const headers = at("response_headers") as RunEvent;
		const ended = at("response_ended") as RunEvent;
		if (ended.t !== end.t) return problem("sample_ended is not at response_ended's t");
		const phases: Partial<Record<Phase, number>> = {};
		const span = (phase: Phase, from: RunEvent, to: RunEvent): void => {
			phases[phase] = to.t - from.t;
		};
		if (isNew) {
			span("dns", start, at("name_resolved") as RunEvent);
			span("connect", at("name_resolved") as RunEvent, at("connection_opened") as RunEvent);
			span("tls", at("connection_opened") as RunEvent, at("connection_secured") as RunEvent);
			span("send", at("connection_secured") as RunEvent, sent);
		} else span("send", start, sent);
		span("first_byte", sent, at("first_byte") as RunEvent);
		span("headers", at("first_byte") as RunEvent, headers);
		span("body", headers, ended);
		span("total", start, end);
		const negative = PHASES.filter((phase) => (phases[phase] ?? 0) < 0);
		if (negative.length > 0) return problem(`${negative.join(", ")} ${negative.length === 1 ? "is" : "are"} less than 0`);
		const status = headers.status;
		if (!Number.isInteger(status)) return problem("response_headers.status is not a whole number");
		if ((status as number) < 200 || (status as number) > 299) {
			keep({ phase: "response", kind: `status_${status as number}` });
			return;
		}
		if (ended.fixture !== "match" || ended.s3_checksum !== "match") {
			return problem(
				`a ${status as number} response whose body did not match (fixture ${JSON.stringify(ended.fixture)}, s3_checksum ${JSON.stringify(ended.s3_checksum)}), which the binary reports with exit code 1`,
			);
		}
		if (!warmup) {
			const signing = sent.signing as { algorithm?: unknown } | undefined;
			result.succeeded.push({
				phases,
				facts: {
					address_block: addressBlock(connection.address as string),
					cipher: connection.cipher as string,
					tls_version: connection.tls as string,
					tls_group: connection.group as string,
					method: text(sent.method) ?? "(none)",
					target: text(sent.target) ?? "(none)",
					signing: signing === undefined ? "unsigned" : (text(signing.algorithm) ?? "(no algorithm)"),
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
