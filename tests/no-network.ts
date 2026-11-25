/**
 * The suite makes no request to any other machine. bunfig.toml (and
 * site/bunfig.toml) preload this file for `bun test`; it refuses, at once, any
 * request to a host that is not this machine:
 * - globalThis.fetch;
 * - node:http and node:https (and so the AWS SDK), at ClientRequest's write,
 *   end and flushHeaders, which every request passes through before Bun sends
 *   it, however the module was imported and whether the host is a name or an
 *   address (169.254.169.254, the instance metadata service, among them);
 * - net.Socket's connect, which node:net and node:tls connect through,
 * in the test process, and in every Bun process a test starts: BUN_OPTIONS
 * names this file as a preload, and a child started with the test's
 * environment inherits it. A child started with an environment of its own
 * (no BUN_OPTIONS) is not covered, and nor is a program that is not Bun's
 * (Python, C): those are given local stand-ins by their tests.
 *
 * This machine is loopback (localhost, 127.0.0.0/8, ::1), the any-address
 * (0.0.0.0, ::), which reaches only this machine, and a Unix socket. Outside
 * `bun test` nothing loads this file, so the tools behave as they always do.
 *
 * No test needs the network, so there is no way to let one through. A test
 * that one day must would be named here, in one visible place.
 */

import http from "node:http";
import net from "node:net";

export function isThisMachine(host: string): boolean {
	const name = host.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
	if (name === "localhost" || name.endsWith(".localhost")) return true;
	if (name === "::1" || name === "0:0:0:0:0:0:0:1" || name === "::" || name === "0.0.0.0") return true;
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
	const guardedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const address = input instanceof Request ? input.url : String(input);
		let url: URL;
		try {
			url = new URL(address);
		} catch {
			return realFetch(input, init);
		}
		if ((url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") && !isThisMachine(url.hostname)) {
			return Promise.reject(refusal("fetch", address, url.hostname));
		}
		return realFetch(input, init);
	};
	globalThis.fetch = Object.assign(guardedFetch, realFetch);

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
