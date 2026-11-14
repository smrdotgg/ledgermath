import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { HandMade, rampRequests, requestRun } from "./hand-made-requests";

/**
 * scripts/derive.ts, both Methods, on the sample Runs (and, since no sample
 * is an http_get Run, two hand-made http_get Runs as tests/derive-script.test.ts
 * makes them, so that Method requests has Series too): once with blobs from a
 * directory, once with --blobs-url against a local HTTPS stand-in for the
 * distribution that serves the same blobs under a path prefix (given with a
 * trailing slash). The Derivations must be the same bytes. And a stand-in
 * that redirects to another host must be refused, without that host being
 * contacted, though it serves the right bytes.
 *
 * The stand-in's certificate is made by openssl for 127.0.0.1, and the
 * script trusts it through NODE_EXTRA_CA_CERTS; without openssl the tests
 * are skipped.
 */

// The script runs as a process; a loaded machine can take a while.
setDefaultTimeout(180_000);

const ROOT = resolve(import.meta.dir, "..");
const SAMPLES = join(ROOT, "tests", "samples");
const SAMPLE_DIRECTORIES = ["scheduled", "interrupted", "failures", "service"];
const OPENSSL = Bun.which("openssl");
const PREFIX = "/mirror/ledgermath/";
const BLOB_PATH = /^\/blobs\/sha256\/([0-9a-f]{64})$/;

const scratch = mkdtempSync(join(tmpdir(), "lm-public-derive-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Ran {
	code: number;
	stdout: string;
	stderr: string;
}

async function derive(args: string[], env: Record<string, string> = {}): Promise<Ran> {
	const child = Bun.spawn(["bun", join(ROOT, "scripts", "derive.ts"), ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
}

describe.skipIf(OPENSSL === null)("scripts/derive.ts through a public address", () => {
	// Every sample's Runs in one directory, as the Runs repository holds them, and every blob in one place.
	const data = join(scratch, "data");
	const made = new HandMade();
	requestRun(made, { startedAt: "2026-11-11T21:35:00Z", stream: { connection: "new", requests: rampRequests(20) } });
	requestRun(made, { startedAt: "2026-11-12T21:35:00Z", stream: { connection: "reused", requests: rampRequests(20) } });
	made.writeTo(join(scratch, "made"));
	for (const source of [...SAMPLE_DIRECTORIES.map((name) => join(SAMPLES, name)), join(scratch, "made")]) {
		cpSync(join(source, "runs"), join(data, "runs"), { recursive: true });
		cpSync(join(source, "blobs", "sha256"), join(data, "blobs", "sha256"), { recursive: true });
	}
	const blobDirectory = join(data, "blobs", "sha256");

	const certificate = join(scratch, "cert.pem");
	const key = join(scratch, "key.pem");
	if (OPENSSL !== null) {
		const made = Bun.spawnSync(
			[OPENSSL, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (made.exitCode !== 0) throw new Error(`openssl could not make a certificate: ${made.stderr.toString()}`);
	}
	const trust = { NODE_EXTRA_CA_CERTS: certificate };

	function serveBlob(path: string): Response {
		const hex = BLOB_PATH.exec(path)?.[1];
		const file = hex === undefined ? null : join(blobDirectory, hex);
		return file !== null && existsSync(file) ? new Response(readFileSync(file)) : new Response("not found", { status: 404 });
	}

	test("gives the same Derivations, byte for byte, as blobs from a directory", async () => {
		const seen: string[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			tls: { cert: Bun.file(certificate), key: Bun.file(key) },
			fetch(req) {
				const path = new URL(req.url).pathname;
				seen.push(path);
				return path.startsWith(PREFIX) ? serveBlob(path.slice(PREFIX.length - 1)) : new Response("not found", { status: 404 });
			},
		});
		try {
			const local = join(scratch, "local");
			const remote = join(scratch, "remote");
			mkdirSync(local);
			mkdirSync(remote);
			const fromDirectory = await derive(["--runs", data, "--blobs", join(data, "blobs"), "--out", join(local, "derivations.json"), "--requests-out", join(local, "requests-derivations.json")]);
			expect(fromDirectory).toMatchObject({ code: 0 });
			const base = `https://127.0.0.1:${server.port}${PREFIX}`;
			const fromAddress = await derive(
				["--runs", data, "--blobs-url", base, "--blobs-per-second", "1000", "--out", join(remote, "derivations.json"), "--requests-out", join(remote, "requests-derivations.json")],
				trust,
			);
			expect(fromAddress.stderr).toBe("");
			expect(fromAddress.code).toBe(0);
			for (const file of ["derivations.json", "requests-derivations.json"]) {
				const a = readFileSync(join(local, file));
				const b = readFileSync(join(remote, file));
				expect([file, b.equals(a)]).toEqual([file, true]);
			}
			// Both Methods derived something: Series of every kind, and Series of requests.
			const series = JSON.parse(readFileSync(join(local, "derivations.json"), "utf8")) as { derivations: unknown[] };
			const requests = JSON.parse(readFileSync(join(local, "requests-derivations.json"), "utf8")) as { derivations: unknown[] };
			expect(series.derivations.length).toBeGreaterThan(0);
			expect(requests.derivations.length).toBeGreaterThan(0);
			// Every blob came through the stand-in, under the prefix, and only blob addresses were asked for.
			expect(seen.length).toBeGreaterThan(0);
			expect(seen.every((path) => path.startsWith(`${PREFIX}blobs/sha256/`) && BLOB_PATH.test(path.slice(PREFIX.length - 1)))).toBe(true);
			const asked = new Set(seen.map((path) => path.slice(-64)));
			expect(asked.size).toBeGreaterThan(SAMPLE_DIRECTORIES.length);
			expect([...asked].every((hex) => readdirSync(blobDirectory).includes(hex))).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	test("refuses a redirect to another host, without contacting it, though it serves the right bytes", async () => {
		const elsewhere: string[] = [];
		const other = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(req) {
				const path = new URL(req.url).pathname;
				elsewhere.push(path);
				return serveBlob(path);
			},
		});
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			tls: { cert: Bun.file(certificate), key: Bun.file(key) },
			fetch(req) {
				const path = new URL(req.url).pathname;
				return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.port}${path.replace("/redirecting", "")}` } });
			},
		});
		try {
			const out = join(scratch, "redirected");
			mkdirSync(out);
			const ran = await derive(
				["--runs", data, "--blobs-url", `https://127.0.0.1:${server.port}/redirecting/`, "--blobs-per-second", "1000", "--out", join(out, "derivations.json"), "--requests-out", join(out, "requests-derivations.json")],
				trust,
			);
			expect(ran.code).toBe(1);
			expect(ran.stderr).toContain(`https://127.0.0.1:${server.port}/redirecting/blobs/sha256/`);
			expect(ran.stderr).toContain(`HTTP 302 redirect to http://127.0.0.1:${other.port}/blobs/sha256/`);
			expect(ran.stderr).toContain("refused, a blob is read only from the address given");
			expect(elsewhere).toEqual([]);
			expect(existsSync(join(out, "derivations.json"))).toBe(false);
		} finally {
			server.stop(true);
			other.stop(true);
		}
	});
});
