import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import { connect as http2Connect } from "node:http2";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { join, resolve } from "node:path";

import { isThisMachine } from "./no-network";

const ROOT = resolve(import.meta.dir, "..");
const REFUSED = "A test reached for the network";

/**
 * A server on this machine, which remembers what it was asked: /to-public
 * redirects to a public host, /to-local to the other server, and everything
 * else is 404. The other server answers "landed".
 */
let server: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
const asked: string[] = [];
beforeAll(() => {
	other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("landed") });
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			asked.push(path);
			if (path === "/to-public") return new Response("moved", { status: 302, headers: { location: "https://example.com/" } });
			if (path === "/to-local") return new Response("moved", { status: 302, headers: { location: `http://127.0.0.1:${other.port}/landed` } });
			return new Response("not here", { status: 404 });
		},
	});
});
afterAll(() => {
	server.stop(true);
	other.stop(true);
});

/** scripts/lookup.ts's about, run as the tests run the tools: a child process with the test's environment. */
async function lookupAbout(location: string): Promise<{ code: number; stderr: string }> {
	const child = Bun.spawn(["bun", join(ROOT, "scripts", "lookup.ts"), "about"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LEDGERMATH_DATA: location } });
	const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	return { code, stderr };
}

/** What tests/no-network-worker.ts, in a Worker, got from fetching `address`: the body, or the error's message. */
function fetchInWorker(address: string): Promise<string> {
	const worker = new Worker(join(import.meta.dir, "no-network-worker.ts"));
	return new Promise<string>((done) => {
		worker.onmessage = (event: MessageEvent<string>) => {
			worker.terminate();
			done(event.data);
		};
		worker.postMessage(address);
	});
}

describe("the suite makes no request to another machine", () => {
	test("fetch to a public host fails, naming the mistake", async () => {
		await expect(fetch("https://example.com/")).rejects.toThrow(REFUSED);
		await expect(fetch(new Request("http://api.ledgermath.com/v1/index.json"))).rejects.toThrow("asked for api.ledgermath.com, which is not this machine");
	});

	test("fetch follows no redirect to a public host, follows one to this machine, and hands a manual caller the redirect itself", async () => {
		const local = `http://127.0.0.1:${server.port}`;
		await expect(fetch(`${local}/to-public`)).rejects.toThrow("fetch https://example.com/ asked for example.com, which is not this machine");
		const landed = await fetch(`${local}/to-local`);
		expect([landed.status, await landed.text(), landed.redirected, landed.url]).toEqual([200, "landed", true, `http://127.0.0.1:${other.port}/landed`]);
		const manual = await fetch(`${local}/to-public`, { redirect: "manual" });
		expect([manual.status, manual.headers.get("location"), await manual.text(), manual.redirected]).toEqual([302, "https://example.com/", "moved", false]);
	});

	test("node:http and node:https to a public host or address fail, naming the mistake, however they were imported", async () => {
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

	test("node:net, node:tls and node:http2 (which connects through node:tls) to a public host fail", async () => {
		const starts: Array<() => { on(event: string, listener: (error?: Error) => void): unknown; destroy(): void }> = [
			() => connect(443, "example.com"),
			() => tlsConnect({ host: "example.com", port: 443 }),
			() => http2Connect("https://example.com"),
		];
		for (const start of starts) {
			const error = await new Promise<Error>((done) => {
				const socket = start();
				socket.on("connect", () => {
					socket.destroy();
					done(new Error("it connected"));
				});
				socket.on("error", (failure) => done(failure ?? new Error("no error")));
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

	test("a Worker a test starts refuses it too, and reaches this machine", async () => {
		expect(await fetchInWorker("https://example.com/")).toContain(REFUSED);
		expect(await fetchInWorker(`http://127.0.0.1:${other.port}/`)).toBe("landed");
	});

	test("a server on this machine is reached, from the test, by node:http, through an IPv4-mapped address, and from a child", async () => {
		asked.length = 0;
		const local = `http://127.0.0.1:${server.port}`;
		expect((await fetch(`${local}/direct`)).status).toBe(404);
		const status = await new Promise<number | undefined>((done, fail) => http.get(`${local}/node-http`, (response) => done(response.statusCode)).on("error", fail));
		expect(status).toBe(404);
		// The URL parser spells [::ffff:127.0.0.1] as [::ffff:7f00:1].
		expect((await fetch(`http://[::ffff:127.0.0.1]:${server.port}/mapped`)).status).toBe(404);
		const result = await lookupAbout(`${local}/`);
		expect(result.stderr).not.toContain(REFUSED);
		expect(asked).toEqual(["/direct", "/node-http", "/mapped", "/v1/index.json"]);
	});

	test("this machine is loopback and the any-address; every other host is not", () => {
		for (const host of ["localhost", "LOCALHOST", "api.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:7f12:3456]", "0.0.0.0", "::"]) {
			expect(isThisMachine(host), host).toBe(true);
		}
		const others = ["api.ledgermath.com", "example.com", "10.0.0.1", "169.254.169.254", "128.0.0.1", "127.0.0.1.example.com", "localhost.example.com", "::2", "::ffff:c000:201", "::ffff:8000:1"];
		// Names /etc/hosts may give loopback count as other machines, so a test passes or fails alike everywhere.
		for (const host of [...others, "ip6-localhost", "localhost6"]) expect(isThisMachine(host), host).toBe(false);
	});
});
