/**
 * The Run record as a Method reads it. Shared by every Method version; a
 * version decides for itself what to make of a Run.
 *
 * A Method's input is a directory of Run files (runs/<yyyy>/<mm>/<dd>/<id>.json,
 * as in the bucket and the Runs repository) and the blobs they name, fetched
 * by hash. Nothing else.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

const ROOT = resolve(import.meta.dir, "..");

/** One Run file, as read from a directory of Runs. */
export interface RunFile {
	/** Its path from the root of the directory, with forward slashes: runs/2026/11/10/<id>.json. */
	path: string;
	/** The sha256 of its bytes, in hex. */
	sha256: string;
	/** Its parsed JSON, not yet checked against the schema. */
	record: unknown;
}

export type ParamValue = string | number | boolean;

export interface RunEvent {
	event: string;
	t: number;
	[key: string]: unknown;
}

export type RunExit =
	| { code: number; runner_signal?: number }
	| { signal: number; timeout_seconds?: number; runner_signal?: number };

/** A Run that validates against schemas/run.schema.json. */
export interface Run {
	schema: "ledgermath.run/1";
	id: string;
	boot: string;
	started_at: string;
	ended_at: string;
	benchmark: string;
	params: Record<string, ParamValue>;
	samples: number;
	/** The Service whose inputs were delivered beside the params: those not secret by value, the secret ones by name. */
	service?: { name: string; inputs: Record<string, string>; secret_inputs: string[] };
	source_commit: string;
	source: string;
	binary: { blob: string; build: string; compiler: string; command: string; resolved_flags: string };
	provider: { name: string; [key: string]: string | null };
	environment: { before: string; after: string };
	runner: string;
	exit: RunExit;
	events: RunEvent[];
	events_error?: { line: number; message: string };
	stdout: string;
	stderr: string;
}

/** Fetches a blob by hash: its bytes, or null when there is no such blob. */
export type FetchBlob = (hash: string) => Promise<Uint8Array | null>;

/** A dump index blob: what environment.before and environment.after name. */
export interface DumpIndex {
	schema: "ledgermath.dump/1";
	taken_at: string;
	sections: Record<string, string>;
}

export interface Validators {
	run: ValidateFunction<Run>;
	event: ValidateFunction<RunEvent>;
}

let validators: Validators | undefined;

/** The Run and event schemas, compiled once. */
export function schemaValidators(): Validators {
	if (validators === undefined) {
		const ajv = new Ajv2020({ strict: true, allErrors: true });
		const read = (name: string): object => JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")) as object;
		validators = {
			run: ajv.compile<Run>(read("run.schema.json")),
			event: ajv.compile<RunEvent>(read("events.schema.json")),
		};
	}
	return validators;
}

export function schemaErrors(validate: ValidateFunction): string {
	return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
}

const HASH = /^sha256:[0-9a-f]{64}$/;

/** Parses a dump index blob, or throws saying what it is not. */
export function parseDumpIndex(hash: string, bytes: Uint8Array): DumpIndex {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error(`${hash} is not JSON, so not a dump index`);
	}
	const index = value as Partial<DumpIndex> | null;
	if (
		typeof index !== "object" ||
		index === null ||
		index.schema !== "ledgermath.dump/1" ||
		typeof index.sections !== "object" ||
		index.sections === null ||
		!Object.values(index.sections).every((section) => typeof section === "string" && HASH.test(section))
	) {
		throw new Error(`${hash} is not a ledgermath.dump/1 index`);
	}
	return index as DumpIndex;
}

/** Byte order, never the locale's, so output does not depend on where it is computed. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON with object keys sorted at every depth and no whitespace. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareText(a, b));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
