import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { join, resolve } from "node:path";

import { isThisMachine } from "./no-network";

const ROOT = resolve(import.meta.dir, "..");
const REFUSED = "A test reached for the network";

/** A server on this machine that answers 404 to everything, and remembers what it was asked. */
let server: ReturnType<typeof Bun.serve>;
const asked: string[] = [];
beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			asked.push(new URL(request.url).pathname);
			return new Response("not here", { status: 404 });
		},
	});
});
afterAll(() => server.stop(true));

/** scripts/lookup.ts's about, run as the tests run the tools: a child process with the test's environment. */
async function lookupAbout(location: string): Promise<{ code: number; stderr: string }> {
	const child = Bun.spawn(["bun", join(ROOT, "scripts", "lookup.ts"), "about"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LEDGERMATH_DATA: location } });
	const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	return { code, stderr };
}

describe("the suite makes no request to another machine", () => {
	test("fetch to a public host fails at once, naming the mistake", async () => {
		const started = performance.now();
		await expect(fetch("https://example.com/")).rejects.toThrow(REFUSED);
		await expect(fetch(new Request("http://api.ledgermath.com/v1/index.json"))).rejects.toThrow("asked for api.ledgermath.com, which is not this machine");
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("node:http and node:https to a public host or address fail at once, naming the mistake, however they were imported", async () => {
		const refused = (start: () => http.ClientRequest): Promise<Error> =>
			new Promise<Error>((done) => {
				const request = start();
				request.on("response", () => done(new Error("it answered")));
				request.on("error", done);
				request.end();
			});
		const byName = await refused(() => http.get("http://example.com/"));
		expect(byName.message).toContain(REFUSED);
		expect(byName.message).toContain("asked for example.com, which is not this machine");
		// A named import, and an address no name is looked up for: the instance metadata service, which answers on an EC2 machine.
		const metadata = await refused(() => httpsRequest({ host: "169.254.169.254", port: 443, path: "/latest/meta-data/" }));
		expect(metadata.message).toContain("asked for 169.254.169.254, which is not this machine");
	});

	test("node:net and node:tls to a public host fail at once", async () => {
		for (const start of [() => connect(443, "example.com"), () => tlsConnect({ host: "example.com", port: 443 })]) {
			const error = await new Promise<Error>((done) => {
				const socket = start();
				socket.on("connect", () => done(new Error("it connected")));
				socket.on("error", done);
			});
			expect(error.message).toContain(REFUSED);
			expect(error.message).toContain("example.com:443");
		}
	});

	test("a Bun process a test starts refuses it too: the tools' default address", async () => {
		expect(process.env.BUN_OPTIONS).toContain(join(import.meta.dir, "no-network.ts"));
		const result = await lookupAbout("");
		expect(result.code).toBe(2);
		expect(result.stderr).toContain(REFUSED);
		expect(result.stderr).toContain("https://api.ledgermath.com/v1/index.json");
	});

	test("a server on this machine is reached, from the test and from a child", async () => {
		const local = `http://127.0.0.1:${server.port}`;
		expect((await fetch(`${local}/direct`)).status).toBe(404);
		const status = await new Promise<number | undefined>((done, fail) => http.get(`${local}/node-http`, (response) => done(response.statusCode)).on("error", fail));
		expect(status).toBe(404);
		const result = await lookupAbout(`${local}/`);
		expect(result.stderr).not.toContain(REFUSED);
		expect(asked).toEqual(["/direct", "/node-http", "/v1/index.json"]);
	});

	test("this machine is loopback and the any-address; every other host is not", () => {
		for (const host of ["localhost", "LOCALHOST", "api.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1", "0.0.0.0", "::"]) expect(isThisMachine(host), host).toBe(true);
		for (const host of ["api.ledgermath.com", "example.com", "10.0.0.1", "169.254.169.254", "128.0.0.1", "127.0.0.1.example.com", "localhost.example.com", "::2"]) expect(isThisMachine(host), host).toBe(false);
	});
});
