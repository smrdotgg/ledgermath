/**
 * Reads one of AWS's Price List offer files (the JSON "bulk" files, such as
 * https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/<version>/<region>/index.json)
 * from disk without holding it in memory: the EC2 file for one Region is over
 * 400 MB. It is shaped
 *
 *     { "formatVersion": ..., "disclaimer": ..., "offerCode": ..., "version": ..., "publicationDate": ...,
 *       "products": { "<sku>": { "sku": ..., "productFamily": ..., "attributes": { ... } }, ... },
 *       "terms": { "OnDemand": { "<sku>": { "<sku>.<offerTermCode>": { ... } } }, "Reserved": { ... } },
 *       "attributesList": { } }
 *
 * scanOfferFile walks the bytes once and hands back, as the exact text the
 * file holds:
 *   - every top-level member other than products and terms (the header);
 *   - each product, with the key it is filed under;
 *   - each SKU's On-Demand terms (terms.OnDemand.<sku>), with that key.
 * Reserved terms and anything else are skipped.
 *
 * A price file certifies what was cut from a file, so the reader must never
 * read a file differently from a standard JSON parser. It therefore checks the
 * whole file against JSON's grammar as it walks (RFC 8259: structure, strings
 * and their escapes, UTF-8, numbers and literals, one top-level object and
 * nothing after it), and refuses, where a standard parser would silently keep
 * the last of several: a repeated top-level member, a repeated key directly
 * under products or terms, and a repeated SKU under any kind of terms. Inside
 * a value it hands back, the caller refuses repeated keys (parseVerbatim).
 */

import { closeSync, openSync, readSync } from "node:fs";

/** One value cut from the file: its key and its exact text. */
export interface Span {
	key: string;
	text: string;
}

export interface OfferFileVisitor {
	/** A top-level member other than products and terms. */
	header?(member: Span): void;
	/** products.<key>. */
	product?(product: Span): void;
	/** terms.OnDemand.<key>. */
	onDemand?(terms: Span): void;
	/** Every byte of the file, in order, as read; valid only during the call. */
	bytes?(chunk: Uint8Array): void;
}

const CHUNK = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_KEY_BYTES = 4096;
const MAX_LITERAL_BYTES = 1024;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

const isWhitespace = (byte: number): boolean => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
/** The bytes a number, true, false or null may start with. */
const startsLiteral = (byte: number): boolean => byte === 0x2d || (byte >= 0x30 && byte <= 0x39) || byte === 0x74 || byte === 0x66 || byte === 0x6e;
const LITERAL = /^(-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?|true|false|null)$/;
const isHexDigit = (byte: number): boolean => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
/** The bytes that may follow a backslash, other than u. */
const SIMPLE_ESCAPES = new Set([QUOTE, BACKSLASH, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]);

export class OfferFileError extends Error {
	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "OfferFileError";
	}
}

/** What the grammar allows next, outside a string or a literal. */
const enum Expect {
	/** A value: after a colon, or at the start. */
	Value,
	/** A value or ]: after [. */
	ValueOrClose,
	/** A key or }: after {. */
	KeyOrClose,
	/** A key: after a comma in an object. */
	Key,
	/** A colon: after a key. */
	Colon,
	/** A comma or the close of the container: after a value in it. */
	CommaOrClose,
	/** Nothing but whitespace: after the top-level object. */
	Done,
}

type Capture = "header" | "product" | "onDemand";

/** Walks the offer file at path once, calling visitor for each value it cuts. chunkBytes is how much it reads at a time. */
export function scanOfferFile(path: string, visitor: OfferFileVisitor, chunkBytes = CHUNK): void {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const buffer = new Uint8Array(chunkBytes);
	/** 1 for an object, 2 for an array, at each depth (1 is the top level). */
	const kind = new Uint8Array(MAX_DEPTH + 1);
	/** The key last read at depths 1 to 3, the only ones whose keys matter. */
	const keys: Array<string | null> = [null, null, null, null];
	/** The keys read so far in the object open at depths 1 to 3, where a repeated key is refused; null where keys are not kept. */
	const seen: Array<Set<string> | null> = [null, null, null, null];
	let depth = 0;
	// A number, not Expect: the closures below assign it, which narrowing would not see.
	let expect: number = Expect.Value;
	let offset = 0;

	// Inside a string: whether it is a key, the key's bytes when it is one that matters,
	// the escape in progress (0 none, 1 after a backslash, 2 to 5 hex digits of \u to come),
	// and the UTF-8 continuation bytes still to come with the range the next one must be in.
	let inString = false;
	let stringIsKey = false;
	let keyBytes: number[] | null = null;
	let escape = 0;
	let continuation = 0;
	let low = 0x80;
	let high = 0xbf;
	// Inside a number, true, false or null: its bytes so far.
	let literal: number[] | null = null;

	// A value being cut: what it is, its key, the depth its container closes back to, and the parts read so far.
	let capture: Capture | null = null;
	let captureKey = "";
	let captureDepth = 0;
	let captureParts: Uint8Array[] = [];
	let captureFrom = 0;

	const fail = (message: string, at: number): never => {
		throw new OfferFileError(path, `${message} (at byte ${offset + at})`);
	};
	const where = (at: number): string =>
		at === 1 ? "the top level" : at === 2 ? (keys[1] as string) : `${keys[1] as string}.${keys[2] as string}`;

	const emit = (text: string): void => {
		const span = { key: captureKey, text };
		if (capture === "header") visitor.header?.(span);
		else if (capture === "product") visitor.product?.(span);
		else if (capture === "onDemand") visitor.onDemand?.(span);
	};
	const startCapture = (what: Capture, key: string, closesTo: number, from: number): void => {
		capture = what;
		captureKey = key;
		captureDepth = closesTo;
		captureFrom = from;
		captureParts = [];
	};
	const finishCapture = (chunk: Uint8Array, end: number): void => {
		captureParts.push(chunk.slice(captureFrom, end));
		const total = captureParts.reduce((sum, part) => sum + part.length, 0);
		const bytes = new Uint8Array(total);
		let at = 0;
		for (const part of captureParts) {
			bytes.set(part, at);
			at += part.length;
		}
		emit(decoder.decode(bytes));
		capture = null;
		captureParts = [];
	};

	/**
	 * A value starts at chunk[i] while the grammar expects one. Starts cutting
	 * it when it is a header member, a product or a SKU's On-Demand terms, and
	 * refuses a product, a SKU's terms, products, terms or a kind of terms that
	 * is not an object, which would otherwise be skipped silently.
	 */
	const valueStarts = (byte: number, i: number): void => {
		if (capture !== null) return;
		const isObject = byte === OPEN_OBJECT;
		if (depth === 1) {
			const key = keys[1] as string;
			if (key === "products" || key === "terms") {
				if (!isObject) fail(`${key} is not an object`, i);
			} else startCapture("header", key, 1, i);
		} else if (depth === 2 && keys[1] === "products") {
			if (!isObject) fail(`products.${keys[2]} is not an object`, i);
			startCapture("product", keys[2] as string, 2, i);
		} else if (depth === 2 && keys[1] === "terms") {
			if (!isObject) fail(`terms.${keys[2]} is not an object`, i);
		} else if (depth === 3 && keys[1] === "terms" && keys[2] === "OnDemand") {
			if (!isObject) fail(`terms.OnDemand.${keys[3]} is not an object`, i);
			startCapture("onDemand", keys[3] as string, 3, i);
		}
	};
	/** A value ended just before chunk[end]: the container it is in now expects a comma or its close. */
	const valueEnds = (chunk: Uint8Array, end: number): void => {
		if (capture !== null && depth === captureDepth) finishCapture(chunk, end);
		expect = depth === 0 ? Expect.Done : Expect.CommaOrClose;
	};
	/** A key has been read at the current depth. */
	const keyRead = (i: number): void => {
		if (keyBytes === null) return;
		const key = JSON.parse(`"${Buffer.from(keyBytes).toString("utf8")}"`) as string;
		keyBytes = null;
		const kept = seen[depth];
		if (kept !== null && kept !== undefined) {
			if (kept.has(key)) fail(`the key ${JSON.stringify(key)} appears twice in ${where(depth)}; a standard JSON parser would keep only the last`, i);
			kept.add(key);
		}
		keys[depth] = key;
	};
	const literalEnds = (chunk: Uint8Array, i: number): void => {
		const text = String.fromCharCode(...(literal as number[]));
		literal = null;
		if (!LITERAL.test(text)) fail(`${JSON.stringify(text)} is not a JSON number, true, false or null`, i);
		valueEnds(chunk, i);
	};

	const descriptor = openSync(path, "r");
	try {
		for (;;) {
			const length = readSync(descriptor, buffer, 0, chunkBytes, null);
			if (length === 0) break;
			const chunk = length === chunkBytes ? buffer : buffer.subarray(0, length);
			visitor.bytes?.(chunk);
			captureFrom = 0;
			for (let i = 0; i < length; i++) {
				const byte = chunk[i] as number;
				if (inString) {
					if (keyBytes !== null) {
						if (byte !== QUOTE || escape !== 0 || continuation !== 0) keyBytes.push(byte);
						if (keyBytes.length > MAX_KEY_BYTES) fail(`a key longer than ${MAX_KEY_BYTES} bytes`, i);
					}
					if (continuation > 0) {
						if (byte < low || byte > high) fail("a string is not UTF-8", i);
						continuation--;
						low = 0x80;
						high = 0xbf;
					} else if (escape === 1) {
						if (byte === 0x75) escape = 5;
						else if (SIMPLE_ESCAPES.has(byte)) escape = 0;
						else fail("a string holds an escape JSON does not have", i);
					} else if (escape > 1) {
						if (!isHexDigit(byte)) fail("a \\u escape is not four hex digits", i);
						escape = escape === 2 ? 0 : escape - 1;
					} else if (byte === QUOTE) {
						inString = false;
						if (stringIsKey) {
							keyRead(i);
							expect = Expect.Colon;
						} else valueEnds(chunk, i + 1);
					} else if (byte === BACKSLASH) escape = 1;
					else if (byte < 0x20) fail("a string holds a control character JSON requires escaped", i);
					else if (byte >= 0x80) {
						if (byte >= 0xc2 && byte <= 0xdf) continuation = 1;
						else if (byte === 0xe0) [continuation, low] = [2, 0xa0];
						else if ((byte >= 0xe1 && byte <= 0xec) || byte === 0xee || byte === 0xef) continuation = 2;
						else if (byte === 0xed) [continuation, high] = [2, 0x9f];
						else if (byte === 0xf0) [continuation, low] = [3, 0x90];
						else if (byte >= 0xf1 && byte <= 0xf3) continuation = 3;
						else if (byte === 0xf4) [continuation, high] = [3, 0x8f];
						else fail("a string is not UTF-8", i);
					}
					continue;
				}
				if (literal !== null) {
					if (startsLiteral(byte) || byte === 0x2e || byte === 0x2b || byte === 0x45 || byte === 0x65 || (byte >= 0x61 && byte <= 0x7a)) {
						literal.push(byte);
						if (literal.length > MAX_LITERAL_BYTES) fail(`a number or literal longer than ${MAX_LITERAL_BYTES} bytes`, i);
						continue;
					}
					literalEnds(chunk, i);
				}
				if (isWhitespace(byte)) continue;

				switch (byte) {
					case QUOTE:
						if (depth === 0) fail(expect === Expect.Done ? "holds something after its top-level object" : "holds something other than one object", i);
						if (expect === Expect.Key || expect === Expect.KeyOrClose) {
							stringIsKey = true;
							// Only the keys that say where a cut value is: top-level members, keys under them, SKUs under a kind of terms.
							keyBytes = depth <= 2 || (depth === 3 && keys[1] === "terms") ? [] : null;
						} else if (expect === Expect.Value || expect === Expect.ValueOrClose) {
							stringIsKey = false;
							valueStarts(byte, i);
						} else fail("a string where JSON does not allow one", i);
						inString = true;
						break;
					case OPEN_OBJECT:
					case OPEN_ARRAY:
						if (expect === Expect.Done) fail("holds something after its top-level object", i);
						if (expect !== Expect.Value && expect !== Expect.ValueOrClose) fail(`${byte === OPEN_OBJECT ? "an object" : "an array"} where JSON does not allow one`, i);
						if (depth === 0 && byte !== OPEN_OBJECT) fail("holds something other than one object", i);
						valueStarts(byte, i);
						if (++depth > MAX_DEPTH) fail(`nested deeper than ${MAX_DEPTH}`, i);
						kind[depth] = byte === OPEN_OBJECT ? 1 : 2;
						if (depth <= 3) {
							keys[depth] = null;
							seen[depth] = byte === OPEN_OBJECT && (depth <= 2 || keys[1] === "terms") ? new Set() : null;
						}
						expect = byte === OPEN_OBJECT ? Expect.KeyOrClose : Expect.ValueOrClose;
						break;
					case CLOSE_OBJECT:
						if (depth === 0 || kind[depth] !== 1 || (expect !== Expect.KeyOrClose && expect !== Expect.CommaOrClose)) fail("a } where JSON does not allow one", i);
						depth--;
						valueEnds(chunk, i + 1);
						break;
					case CLOSE_ARRAY:
						if (depth === 0 || kind[depth] !== 2 || (expect !== Expect.ValueOrClose && expect !== Expect.CommaOrClose)) fail("a ] where JSON does not allow one", i);
						depth--;
						valueEnds(chunk, i + 1);
						break;
					case COMMA:
						if (expect !== Expect.CommaOrClose) fail("a comma where JSON does not allow one", i);
						expect = kind[depth] === 1 ? Expect.Key : Expect.Value;
						break;
					case COLON:
						if (expect !== Expect.Colon) fail("a colon where JSON does not allow one", i);
						expect = Expect.Value;
						break;
					default:
						if (depth === 0) fail(expect === Expect.Done ? "holds something after its top-level object" : "holds something other than one object", i);
						if (!startsLiteral(byte) || (expect !== Expect.Value && expect !== Expect.ValueOrClose)) fail(`the byte 0x${byte.toString(16)} where JSON does not allow it`, i);
						valueStarts(byte, i);
						literal = [byte];
				}
			}
			if (capture !== null) captureParts.push(chunk.slice(captureFrom, length));
			offset += length;
		}
	} finally {
		closeSync(descriptor);
	}
	if (inString) throw new OfferFileError(path, "ends inside a string");
	if (depth !== 0) throw new OfferFileError(path, `ends inside ${depth} open container${depth === 1 ? "" : "s"}`);
	if (expect !== Expect.Done) throw new OfferFileError(path, "holds no top-level object");
}

/** The text of a JSON value with every whitespace byte outside strings removed. */
export function minifyJson(text: string): string {
	let out = "";
	let from = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (inString) {
			if (escaped) escaped = false;
			else if (c === BACKSLASH) escaped = true;
			else if (c === QUOTE) inString = false;
			continue;
		}
		if (c === QUOTE) inString = true;
		else if (isWhitespace(c)) {
			out += text.slice(from, i);
			from = i + 1;
		}
	}
	return out + text.slice(from);
}

/**
 * The first key that appears twice in one object of a JSON text, with the
 * keys of the containers it is in, or null. The text must be valid JSON.
 */
export function repeatedKey(text: string): { key: string; within: string[] } | null {
	// One entry per open container: the keys read in it (null for an array), and the key it is under.
	const stack: Array<{ keys: Set<string> | null; under: string }> = [];
	let expectKey = false;
	let pending = "";
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === QUOTE) {
			let end = i + 1;
			while (text.charCodeAt(end) !== QUOTE) end += text.charCodeAt(end) === BACKSLASH ? 2 : 1;
			const top = stack.at(-1);
			if (expectKey && top?.keys) {
				const key = JSON.parse(text.slice(i, end + 1)) as string;
				if (top.keys.has(key)) return { key, within: stack.slice(1).map((entry) => entry.under) };
				top.keys.add(key);
				pending = key;
				expectKey = false;
			}
			i = end;
		} else if (c === OPEN_OBJECT || c === OPEN_ARRAY) {
			stack.push({ keys: c === OPEN_OBJECT ? new Set() : null, under: pending });
			pending = "";
			expectKey = c === OPEN_OBJECT;
		} else if (c === CLOSE_OBJECT || c === CLOSE_ARRAY) {
			stack.pop();
			expectKey = false;
		} else if (c === COMMA) expectKey = stack.at(-1)?.keys !== null && stack.length > 0;
	}
	return null;
}

/**
 * Parses a value cut from an offer file and proves the parse lost nothing:
 * no key in it appears twice in one object (a standard parser would keep only
 * the last), and, written back out, it is the file's own text with only the
 * whitespace between tokens removed. So its keys keep their order (a key that
 * looks like an array index would not), its numbers keep their digits, and its
 * strings their escapes. Throws, saying where, when that does not hold.
 */
export function parseVerbatim(span: Span, where: string): unknown {
	let value: unknown;
	try {
		value = JSON.parse(span.text);
	} catch (error) {
		throw new Error(`${where}: ${JSON.stringify(span.key)} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const repeated = repeatedKey(span.text);
	if (repeated !== null) {
		const path = [span.key, ...repeated.within].map((part) => JSON.stringify(part)).join(" > ");
		throw new Error(`${where}: the key ${JSON.stringify(repeated.key)} appears twice in one object under ${path}; a standard JSON parser would keep only the last`);
	}
	const written = JSON.stringify(value);
	const original = minifyJson(span.text);
	if (written !== original) {
		let at = 0;
		while (at < written.length && written[at] === original[at]) at++;
		throw new Error(
			`${where}: ${JSON.stringify(span.key)} cannot be kept verbatim: parsed and written back it differs from the file's text at character ${at} ` +
				`(file ${JSON.stringify(original.slice(Math.max(0, at - 20), at + 20))}, written ${JSON.stringify(written.slice(Math.max(0, at - 20), at + 20))})`,
		);
	}
	return value;
}
