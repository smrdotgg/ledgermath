/**
 * The suite makes no request to any other machine. bunfig.toml (and
 * site/bunfig.toml) preload this file for `bun test`; it refuses, at once, any
 * request to a host that is not this machine:
 * - globalThis.fetch, and every redirect it would follow, which
 *   tests/no-network-redirects.ts follows as Bun's fetch does;
 * - node:http and node:https (and so the AWS SDK), at ClientRequest's write,
 *   end and flushHeaders, which every request passes through before Bun sends
 *   it, however the module was imported and whether the host is a name or an
 *   address (169.254.169.254, the instance metadata service, among them);
 * - net.Socket's connect, which node:net, node:tls and node:http2 connect through,
 * in the test process, in every Worker it starts (the Worker is given this
 * file as a preload), and in every Bun process a test starts: BUN_OPTIONS
 * names this file as a preload, and a child started with the test's
 * environment inherits it. Not covered (README, "Tests"): a child started with
 * an environment of its own (no BUN_OPTIONS), a program that is not Bun's
 * (Python, C, curl), node:worker_threads, Bun.connect, WebSocket, node:dgram
 * and DNS lookups.
 *
 * This machine is localhost and *.localhost, 127.0.0.0/8 (also mapped into
 * IPv6), ::1, the any-address (0.0.0.0, ::), which reaches only this machine,
 * and a Unix socket. Other names /etc/hosts may give loopback (ip6-localhost)
 * are refused, so a test passes or fails alike on every machine. Outside
 * `bun test` nothing loads this file, so the tools behave as they always do.
 *
 * No test needs the network, so there is no way to let one through. A test
 * that one day must would be named here, in one visible place.
 */

import http from "node:http";
import net from "node:net";

import { followingFetch } from "./no-network-redirects";

/** Where the guard keeps Bun's own fetch, for its test. */
export const RUNTIME_FETCH = Symbol.for("ledgermath.no-network.runtime-fetch");

export function isThisMachine(host: string): boolean {
	const name = host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
	if (name === "localhost" || name.endsWith(".localhost")) return true;
	if (name === "::1" || name === "0:0:0:0:0:0:0:1" || name === "::" || name === "0.0.0.0") return true;
	// 127.0.0.0/8, also mapped into IPv6, as written (::ffff:127.0.0.1) or as a URL spells it (::ffff:7f00:1).
	if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(name)) return true;
	const v4 = name.replace(/^::ffff:/, "");
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

export function refusal(what: string, address: string, host: string): Error {
	return new Error(
		`A test reached for the network: ${what} ${address} asked for ${host}, which is not this machine. The suite makes no request to any other machine (tests/no-network.ts): give the code under test a directory, a server on 127.0.0.1, or a fetch of its own.`,
	);
}

const GUARDED = Symbol.for("ledgermath.no-network");
const scope = globalThis as typeof globalThis & { [GUARDED]?: true };

if (scope[GUARDED] !== true) {
	scope[GUARDED] = true;

	// Every Bun process a test starts with this environment loads this file first.
	// BUN_OPTIONS is split at whitespace, with no quoting, so a path holding a space cannot be passed on.
	if (/\s/.test(import.meta.path)) {
		throw new Error(`tests/no-network.ts is at ${import.meta.path}, a path with a space, which BUN_OPTIONS cannot carry to the processes the tests start: check the repository out at a path without one.`);
	}
	const preload = `--preload=${import.meta.path}`;
	const options = process.env.BUN_OPTIONS ?? "";
	if (!options.includes(preload)) process.env.BUN_OPTIONS = `${options} ${preload}`.trim();

	const realFetch = globalThis.fetch;
	/** The refusal for an address, or null when it may be asked. */
	const refuses = (address: string): Error | null => {
		let url: URL;
		try {
			url = new URL(address);
		} catch {
			return null;
		}
		const web = url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:";
		return web && !isThisMachine(url.hostname) ? refusal("fetch", address, url.hostname) : null;
	};
	// Redirects are followed by tests/no-network-redirects.ts, as Bun's fetch would, each destination checked first.
	const following = followingFetch(realFetch, refuses);
	const guardedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const refused = refuses(input instanceof Request ? input.url : String(input));
		if (refused !== null) throw refused;
		return following(input, init);
	};
	globalThis.fetch = Object.assign(guardedFetch, realFetch);
	// Bun's own fetch, for tests/no-network.test.ts to hold the guarded one to; nothing else uses it.
	(globalThis as Record<symbol, unknown>)[RUNTIME_FETCH] = realFetch;

	// A Worker is a separate global scope: it loads this file first too, before any preload of its own.
	const RealWorker = globalThis.Worker;
	if (RealWorker !== undefined) {
		globalThis.Worker = class extends RealWorker {
			constructor(url: string | URL, options?: WorkerOptions) {
				const given = (options as { preload?: string | string[] } | undefined)?.preload;
				const preload = [import.meta.path, ...(given === undefined ? [] : Array.isArray(given) ? given : [given])];
				super(url, { ...options, preload } as WorkerOptions);
			}
		} as typeof Worker;
	}

	// Bun's node:http sends a request from native code, past fetch and net; each passes these first.
	type Outgoing = http.ClientRequest & { host?: string; protocol?: string };
	const clientRequest = http.ClientRequest.prototype as unknown as Record<string, (this: Outgoing, ...args: unknown[]) => unknown>;
	for (const method of ["write", "end", "flushHeaders"]) {
		const real = clientRequest[method];
		if (real === undefined) continue;
		clientRequest[method] = function (this: Outgoing, ...args: unknown[]): unknown {
			const header = this.getHeader("host");
			const host = this.host ?? (typeof header === "string" ? header.replace(/:\d+$/, "") : "localhost");
			if (!isThisMachine(host)) {
				this.destroy(refusal("node:http", `${this.protocol ?? "http:"}//${host}${this.path}`, host));
				return method === "write" ? false : this;
			}
			return real.apply(this, args);
		};
	}

	const realConnect = net.Socket.prototype.connect as (this: net.Socket, ...args: unknown[]) => net.Socket;
	/** The host and port a connect call names, or null for a Unix socket. net.connect passes its arguments as one array. */
	const targetOf = (args: unknown[]): { host: string; port: unknown } | null => {
		const [first, second] = args;
		if (Array.isArray(first)) return targetOf(first);
		if (typeof first === "object" && first !== null) {
			const options = first as { path?: unknown; host?: unknown; hostname?: unknown; port?: unknown };
			if (typeof options.path === "string" && options.host === undefined && options.hostname === undefined) return null;
			const host = options.host ?? options.hostname;
			return { host: typeof host === "string" && host !== "" ? host : "localhost", port: options.port };
		}
		if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) return { host: typeof second === "string" && second !== "" ? second : "localhost", port: first };
		return null;
	};
	net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
		const target = targetOf(args);
		if (target !== null && !isThisMachine(target.host)) {
			const error = refusal("a connection to", `${target.host}:${String(target.port)}`, target.host);
			// As a connection that fails does: the error comes after connect returns.
			process.nextTick(() => this.destroy(error));
			return this;
		}
		return realConnect.apply(this, args);
	} as typeof net.Socket.prototype.connect;
}
