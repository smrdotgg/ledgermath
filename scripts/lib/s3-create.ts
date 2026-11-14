/**
 * One S3 PutObject that only ever creates: If-None-Match: *, signed here with
 * SigV4 (scripts/lib/sigv4.ts), because Bun's S3 client cannot send that
 * header. S3 then writes the object only if the key does not exist, and
 * answers 412 when it does, so an object is never replaced, whoever wrote it
 * and whenever. The payload's SHA-256 is signed too, so S3 refuses a body
 * that is not the bytes hashed, and the Content-Type is signed, so it arrives
 * exactly as given.
 *
 * scripts/publish-third-party-source.ts creates its source packages with it,
 * and scripts/lib/bucket.ts (the bucket copy) every object it writes.
 *
 * Path-style addressing (https://s3.<region>.amazonaws.com/<bucket>/<key>),
 * as Bun's S3 client uses by default. A key is encoded once and never
 * normalized here, but the URL is: a key with a "." or ".." segment would be
 * sent as another key, so it is refused.
 */

import { amzDate, encodeUriPath, signV4 } from "./sigv4";

/** Keys for S3, held in memory only. */
export interface S3Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** The credentials Bun's S3 client would read: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and, if set, AWS_SESSION_TOKEN. */
export function credentialsFromEnvironment(environment: Record<string, string | undefined> = process.env): S3Credentials {
	const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken } = environment;
	if (!accessKeyId || !secretAccessKey) {
		throw new Error(
			'no AWS credentials in the environment: give this command keys in a subshell, ( eval "$(aws configure export-credentials --profile PROFILE --format env)" && COMMAND ), so the shell keeps none',
		);
	}
	return { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined };
}

/** A key a URL would carry as another: one with a "." or ".." path segment. */
export function hasDotSegment(key: string): boolean {
	return key.split("/").some((segment) => segment === "." || segment === "..");
}

export interface CreateObjectRequest {
	/** https://s3.<region>.amazonaws.com, or a stand-in's address in tests. */
	endpoint: string;
	bucket: string;
	key: string;
	region: string;
	credentials: S3Credentials;
	contentType: string;
	body: Uint8Array | Blob;
	/** The body's SHA-256 in hex. */
	payloadSha256: string;
	fetcher?: Fetch;
	now?: () => Date;
}

/**
 * What S3 answered: "created" (200), "exists" (412: the key exists, nothing
 * was written) or "conflict" (409: a conflicting write or delete of the key
 * was in progress, nothing was written).
 */
export type CreateAnswer = "created" | "exists" | "conflict";

/** Any other answer: S3's status, error code and message, never a URL, a header or the rest of the body (which can name the key ID). */
export class CreateRefused extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "CreateRefused";
	}
}

/** The text of an XML element in an S3 error body, or null. */
function xmlElement(body: string, name: string): string | null {
	return new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? null;
}

/**
 * Sends one PutObject with If-None-Match: *. Throws CreateRefused for an
 * answer other than 200, 412 or 409, and whatever fetch throws when no
 * answer arrives (S3 may then have written the object, or not).
 */
export async function createObject(request: CreateObjectRequest): Promise<CreateAnswer> {
	if (hasDotSegment(request.key)) throw new Error(`${request.key}: a key with a "." or ".." segment cannot be sent by name`);
	const canonicalUri = `/${encodeUriPath(request.bucket)}/${encodeUriPath(request.key)}`;
	const url = new URL(`${request.endpoint.replace(/\/+$/, "")}${canonicalUri}`);
	const date = amzDate((request.now ?? (() => new Date()))());
	const headers: Array<[string, string]> = [
		["host", url.host],
		["content-type", request.contentType],
		["if-none-match", "*"],
		["x-amz-content-sha256", request.payloadSha256],
		["x-amz-date", date],
	];
	if (request.credentials.sessionToken) headers.push(["x-amz-security-token", request.credentials.sessionToken]);
	const signed = signV4({
		method: "PUT",
		canonicalUri,
		canonicalQuery: "",
		headers,
		payloadSha256: request.payloadSha256,
		amzDate: date,
		region: request.region,
		service: "s3",
		accessKeyId: request.credentials.accessKeyId,
		secretAccessKey: request.credentials.secretAccessKey,
	});
	const sent: Record<string, string> = Object.fromEntries(headers.filter(([name]) => name !== "host"));
	sent.authorization = signed.authorization;
	const response = await (request.fetcher ?? fetch)(url, { method: "PUT", headers: sent, body: request.body });
	const text = await response.text().catch(() => "");
	if (response.status === 200) return "created";
	if (response.status === 412) return "exists";
	if (response.status === 409) return "conflict";
	const code = xmlElement(text, "Code") ?? "no error code";
	const message = xmlElement(text, "Message") ?? "";
	throw new CreateRefused(
		response.status,
		`PUT s3://${request.bucket}/${request.key} (If-None-Match: *) answered ${response.status}, ${code}${message === "" ? "" : `: ${message}`}`,
	);
}
