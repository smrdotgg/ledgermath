/**
 * AWS Signature Version 4 for one request, with node:crypto: the canonical
 * request, the string to sign, the signing key and the Authorization header,
 * as AWS's documentation of SigV4 for S3 defines them. The same rules as
 * benchmarks/harness/c/lm_sigv4.c: header names lower-cased and sorted (the
 * values of one name kept in the order given and joined with commas), each
 * value trimmed with inner runs of spaces made one, and the canonical query
 * taken as given. tests/sigv4.test.ts holds it to AWS's SigV4 test suite (the
 * cases of tests/http-get/sigv4/) and to the S3 User Guide's examples.
 *
 * scripts/lib/s3-create.ts signs its conditional PutObject with it, because
 * Bun's S3 client cannot send If-None-Match.
 */

import { createHash, createHmac } from "node:crypto";

export interface SigV4Request {
	method: string;
	/** Already encoded: encodeUriPath() of the path, for S3. */
	canonicalUri: string;
	/** Already canonical: sorted, encoded name=value pairs joined with &, or "". */
	canonicalQuery: string;
	/** Every header to sign, host and x-amz-date among them, as [name, value]. */
	headers: ReadonlyArray<readonly [string, string]>;
	/** The payload's SHA-256 in hex, or "UNSIGNED-PAYLOAD". */
	payloadSha256: string;
	/** YYYYMMDDTHHMMSSZ, the same value as the x-amz-date header. */
	amzDate: string;
	region: string;
	service: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export interface SigV4Result {
	canonicalRequest: string;
	signedHeaders: string;
	stringToSign: string;
	signature: string;
	authorization: string;
}

export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

/** The time as SigV4 writes it: YYYYMMDDTHHMMSSZ. */
export function amzDate(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** A path as S3 canonicalizes it: every byte of its UTF-8 percent-encoded except A-Z a-z 0-9 - . _ ~ and /, once, never normalized. */
export function encodeUriPath(path: string): string {
	let out = "";
	for (const byte of new TextEncoder().encode(path)) {
		const c = String.fromCharCode(byte);
		out += /[A-Za-z0-9\-._~/]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** A header value as SigV4 canonicalizes it: no whitespace at either end, each inner run of spaces and tabs one space. */
function trimValue(value: string): string {
	return value.replace(/^[ \t]+|[ \t]+$/g, "").replace(/[ \t]+/g, " ");
}

function hmac(key: string | Buffer, data: string): Buffer {
	return createHmac("sha256", key).update(data).digest();
}

export function signV4(request: SigV4Request): SigV4Result {
	if (!/^\d{8}T\d{6}Z$/.test(request.amzDate)) throw new Error(`x-amz-date ${request.amzDate} is not YYYYMMDDTHHMMSSZ`);
	const named = request.headers.map(([name, value], index) => ({ name: name.toLowerCase(), value: trimValue(value), index }));
	// Array.prototype.sort is stable, so the values of one name keep the order given.
	named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index));
	const lines: string[] = [];
	const names: string[] = [];
	for (const header of named) {
		if (names[names.length - 1] === header.name) {
			lines[lines.length - 1] += `,${header.value}`;
		} else {
			names.push(header.name);
			lines.push(`${header.name}:${header.value}`);
		}
	}
	const signedHeaders = names.join(";");
	const canonicalRequest = [request.method, request.canonicalUri, request.canonicalQuery, ...lines.map((line) => line), "", signedHeaders, request.payloadSha256].join("\n");
	const date = request.amzDate.slice(0, 8);
	const scope = `${date}/${request.region}/${request.service}/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", request.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
	const key = hmac(hmac(hmac(hmac(`AWS4${request.secretAccessKey}`, date), request.region), request.service), "aws4_request");
	const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
	const authorization = `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	return { canonicalRequest, signedHeaders, stringToSign, signature, authorization };
}
