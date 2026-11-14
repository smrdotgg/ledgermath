import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { amzDate, encodeUriPath, sha256Hex, signV4 } from "../scripts/lib/sigv4";

// scripts/lib/sigv4.ts, the TypeScript signer of the publish script's
// conditional PutObject, against the same cases as the C signer
// (tests/http-get.test.ts): AWS's SigV4 test suite as aws-c-auth publishes it
// (Apache-2.0), the cases whose path S3 would encode the same way, once and
// unnormalized; and the S3 User Guide's examples.

const VECTORS = join(import.meta.dir, "http-get", "sigv4");
const cases = readdirSync(VECTORS).sort();

describe("signV4 (scripts/lib/sigv4.ts)", () => {
	test("there are AWS test-suite cases to check", () => {
		expect(cases.length).toBeGreaterThanOrEqual(15);
	});

	for (const name of cases) {
		test(`AWS's test suite: ${name}`, () => {
			const read = (file: string) => readFileSync(join(VECTORS, name, file), "utf8");
			const context = JSON.parse(read("context.json")) as {
				credentials: { access_key_id: string; secret_access_key: string; token?: string };
				region: string;
				service: string;
				sign_body: boolean;
				timestamp: string;
			};
			const [head, body = ""] = read("request.txt").split(/\n\n/);
			const [requestLine, ...headerLines] = (head as string).split("\n");
			const method = (requestLine as string).slice(0, (requestLine as string).indexOf(" "));
			const target = (requestLine as string).slice(method.length + 1, (requestLine as string).lastIndexOf(" HTTP/"));
			const path = target.split("?")[0] as string;
			const headers: Array<[string, string]> = headerLines
				.filter((line) => line !== "")
				.map((line) => {
					const colon = line.indexOf(":");
					return [line.slice(0, colon), line.slice(colon + 1)];
				});
			const date = context.timestamp.replace(/[-:]/g, "");
			headers.push(["X-Amz-Date", date]);
			if (context.credentials.token) headers.push(["X-Amz-Security-Token", context.credentials.token]);
			const payload = sha256Hex(body);
			if (context.sign_body) headers.push(["X-Amz-Content-Sha256", payload]);
			const expected = read("header-canonical-request.txt");
			const result = signV4({
				method,
				canonicalUri: encodeUriPath(path),
				canonicalQuery: expected.split("\n")[2] as string,
				headers,
				payloadSha256: payload,
				amzDate: date,
				region: context.region,
				service: context.service,
				accessKeyId: context.credentials.access_key_id,
				secretAccessKey: context.credentials.secret_access_key,
			});
			expect(result.canonicalRequest).toBe(expected);
			expect(result.stringToSign).toBe(read("header-string-to-sign.txt"));
			expect(result.signature).toBe(read("header-signature.txt").trim());
		});
	}

	test("the S3 User Guide's examples: GET Object (Range signed) and GET Bucket (a query)", () => {
		// "Signature Calculations for the Authorization Header: Transferring
		// Payload in a Single Chunk", Examples: Signature Calculations; the same
		// values tests/http-get.test.ts holds the C signer to.
		const payload = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		const common = {
			method: "GET",
			payloadSha256: payload,
			amzDate: "20130524T000000Z",
			region: "us-east-1",
			service: "s3",
			accessKeyId: "AKIAIOSFODNN7EXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		};
		const object = signV4({
			...common,
			canonicalUri: encodeUriPath("/test.txt"),
			canonicalQuery: "",
			headers: [
				["Host", "examplebucket.s3.amazonaws.com"],
				["Range", "bytes=0-9"],
				["x-amz-content-sha256", payload],
				["x-amz-date", common.amzDate],
			],
		});
		expect(object.stringToSign).toBe(
			"AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
		);
		expect(object.authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
		);
		const bucket = signV4({
			...common,
			canonicalUri: "/",
			canonicalQuery: "max-keys=2&prefix=J",
			headers: [
				["Host", "examplebucket.s3.amazonaws.com"],
				["x-amz-content-sha256", payload],
				["x-amz-date", common.amzDate],
			],
		});
		expect(bucket.signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
	});

	test("amzDate and encodeUriPath", () => {
		expect(amzDate(new Date("2026-11-14T09:07:05.123Z"))).toBe("20261114T090705Z");
		expect(encodeUriPath("/bucket/blobs/sha256/5c14")).toBe("/bucket/blobs/sha256/5c14");
		expect(encodeUriPath("/test$file.text")).toBe("/test%24file.text");
		expect(encodeUriPath("/example space/ሴ")).toBe("/example%20space/%E1%88%B4");
	});

	test("refuses a date that is not YYYYMMDDTHHMMSSZ", () => {
		expect(() =>
			signV4({ method: "GET", canonicalUri: "/", canonicalQuery: "", headers: [], payloadSha256: "", amzDate: "2013-05-24", region: "r", service: "s", accessKeyId: "a", secretAccessKey: "b" }),
		).toThrow(/YYYYMMDDTHHMMSSZ/);
	});
});
