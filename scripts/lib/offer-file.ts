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
 * Reserved terms and anything else are skipped. It does not validate the
 * whole file as JSON: what it hands back is parsed by the caller, and it fails
 * if the file ends inside a container or a string, or holds more than one
 * top-level value.
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

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

const isWhitespace = (byte: number): boolean => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;

export class OfferFileError extends Error {
	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "OfferFileError";
	}
}

type Capture = "header" | "product" | "onDemand";

/** Walks the offer file at path once, calling visitor for each value it cuts. chunkBytes is how much it reads at a time. */
export function scanOfferFile(path: string, visitor: OfferFileVisitor, chunkBytes = CHUNK): void {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const buffer = new Uint8Array(chunkBytes);
	/** 1 for an object, 2 for an array, at each depth (1 is the top level). */
	const kind = new Uint8Array(MAX_DEPTH + 1);
	/** Whether the object at each depth expects a key next. */
	const expectKey = new Uint8Array(MAX_DEPTH + 1);
	/** The key last read at depths 1 to 3, the only ones whose keys matter. */
	const keys: Array<string | null> = [null, null, null, null];
	let depth = 0;
	let topLevelValues = 0;

	let inString = false;
	let escaped = false;
	/** The bytes of a key being read at depth 1 to 3, or null. */
	let keyBytes: number[] | null = null;

	// A value being cut: what it is, its key, the depth it closes at, and the parts read so far.
	let capture: Capture | null = null;
	let captureKey = "";
	let captureDepth = 0;
	let captureParts: Uint8Array[] = [];
	let captureFrom = 0;
	/** At depth 1, after a colon, until the member's value starts. */
	let awaitingTopLevelValue = false;

	/** A value that is not an object where a product or a SKU's terms belong would otherwise be skipped silently. */
	const refuseScalar = (at: number): void => {
		if (at === 2 && keys[1] === "products") throw new OfferFileError(path, `products.${keys[2]} is not an object`);
		if (at === 3 && keys[1] === "terms" && keys[2] === "OnDemand") throw new OfferFileError(path, `terms.OnDemand.${keys[3]} is not an object`);
		if (at === 1 && (keys[1] === "products" || keys[1] === "terms")) throw new OfferFileError(path, `${keys[1]} is not an object`);
	};

	const emit = (text: string): void => {
		const span = { key: captureKey, text };
		if (capture === "header") visitor.header?.(span);
		else if (capture === "product") visitor.product?.(span);
		else if (capture === "onDemand") visitor.onDemand?.(span);
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
		let text: string;
		try {
			text = decoder.decode(bytes);
		} catch {
			throw new OfferFileError(path, `the value under ${JSON.stringify(captureKey)} is not UTF-8`);
		}
		emit(capture === "header" ? text.trimEnd() : text);
		capture = null;
		captureParts = [];
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
					if (keyBytes !== null && (escaped || (byte !== QUOTE && byte !== BACKSLASH))) keyBytes.push(byte);
					if (escaped) escaped = false;
					else if (byte === BACKSLASH) {
						escaped = true;
						if (keyBytes !== null) keyBytes.push(byte);
					} else if (byte === QUOTE) {
						inString = false;
						if (keyBytes !== null) {
							const raw = `"${Buffer.from(keyBytes).toString("utf8")}"`;
							keys[depth] = JSON.parse(raw) as string;
							keyBytes = null;
						}
					}
					continue;
				}
				if (isWhitespace(byte)) continue;

				if (awaitingTopLevelValue) {
					awaitingTopLevelValue = false;
					const key = keys[1] as string;
					if (key !== "products" && key !== "terms" && capture === null) {
						capture = "header";
						captureKey = key;
						captureDepth = 1;
						captureFrom = i;
						captureParts = [];
					}
				}

				switch (byte) {
					case QUOTE:
						inString = true;
						if (depth >= 1 && kind[depth] === 1 && expectKey[depth] === 1) {
							expectKey[depth] = 0;
							// Only the keys that say where a cut value is: top-level members, SKUs under products, terms' kinds, SKUs under a kind of terms.
							if (depth <= 2 || (depth === 3 && keys[1] === "terms")) keyBytes = [];
						} else if (capture === null) refuseScalar(depth);
						break;
					case OPEN_OBJECT:
					case OPEN_ARRAY:
						if (depth === 0) {
							if (++topLevelValues > 1) throw new OfferFileError(path, "more than one top-level value");
							if (byte !== OPEN_OBJECT) throw new OfferFileError(path, "holds something other than one object");
						}
						if (capture === null) {
							if (depth === 2 && keys[1] === "products" && kind[2] === 1) {
								capture = "product";
								captureKey = keys[2] as string;
								captureDepth = 2;
								captureFrom = i;
								captureParts = [];
							} else if (depth === 3 && keys[1] === "terms" && keys[2] === "OnDemand" && kind[3] === 1) {
								capture = "onDemand";
								captureKey = keys[3] as string;
								captureDepth = 3;
								captureFrom = i;
								captureParts = [];
							}
						}
						if (++depth > MAX_DEPTH) throw new OfferFileError(path, `nested deeper than ${MAX_DEPTH}`);
						kind[depth] = byte === OPEN_OBJECT ? 1 : 2;
						expectKey[depth] = byte === OPEN_OBJECT ? 1 : 0;
						if (depth <= 3) keys[depth] = null;
						break;
					case CLOSE_OBJECT:
					case CLOSE_ARRAY:
						if (depth === 0) throw new OfferFileError(path, "a container closes that was never opened");
						if (kind[depth] !== (byte === CLOSE_OBJECT ? 1 : 2)) throw new OfferFileError(path, "a container closes with the wrong bracket");
						if (capture === "header" && depth === 1) finishCapture(chunk, i);
						depth--;
						if (capture !== null && capture !== "header" && depth === captureDepth) finishCapture(chunk, i + 1);
						break;
					case COMMA:
						if (capture === "header" && depth === 1) finishCapture(chunk, i);
						if (depth >= 1 && kind[depth] === 1) expectKey[depth] = 1;
						break;
					case COLON:
						if (depth === 1) awaitingTopLevelValue = true;
						break;
					default:
						if (depth === 0) throw new OfferFileError(path, "holds something other than one object");
						if (capture === null) refuseScalar(depth);
				}
			}
			if (capture !== null) captureParts.push(chunk.slice(captureFrom, length));
			if (keyBytes !== null && keyBytes.length > 4096) throw new OfferFileError(path, "a key longer than 4096 bytes");
		}
	} finally {
		closeSync(descriptor);
	}
	if (inString) throw new OfferFileError(path, "ends inside a string");
	if (depth !== 0) throw new OfferFileError(path, `ends inside ${depth} open container${depth === 1 ? "" : "s"}`);
	if (topLevelValues !== 1) throw new OfferFileError(path, "holds no top-level object");
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
 * Parses a value cut from an offer file and proves the parse lost nothing:
 * written back out, it must be the file's own text with only the whitespace
 * between tokens removed. So its keys keep their order (a key that looks like
 * an array index would not), its numbers keep their digits, and its strings
 * their escapes. Throws, saying where, when that does not hold.
 */
export function parseVerbatim(span: Span, where: string): unknown {
	let value: unknown;
	try {
		value = JSON.parse(span.text);
	} catch (error) {
		throw new Error(`${where}: ${JSON.stringify(span.key)} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
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
