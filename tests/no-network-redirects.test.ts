/**
 * The guarded fetch follows redirects itself (tests/no-network-redirects.ts),
 * so a correct test must see what Bun's own fetch would show it. Each case, a
 * test of its own, sends the same request through both, to servers on this
 * machine that record what they received, and requires the two to agree: on
 * the response (status, address, redirected, body, headers, and the same of a
 * clone) or the error, and on every request every server received (method,
 * path, headers, body), in order. One stated exception: a body that is a
 * stream, on a 301, 302, 307 or 308 that would be followed, is refused by the
 * guard (README, "Tests"); its cases say what Bun does and what the guard does.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { RUNTIME_FETCH } from "./no-network";
import { MOST_REDIRECTS } from "./no-network-redirects";

const runtimeFetch = (globalThis as Record<symbol, unknown>)[RUNTIME_FETCH] as typeof fetch;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

type Received = { server: string; method: string; path: string; headers: string[]; body: string };
const received: Received[] = [];
/** A boundary is chosen afresh for every FormData: the same in both, as a word. */
const sameBoundary = (text: string): string => text.replace(/-*(Bun|WebKit)FormBoundary[0-9A-Za-z]+/g, "BOUNDARY").replace(/boundary=[-0-9A-Za-z]+/g, "boundary=BOUNDARY");

/**
 * /s/<status>?to=<location> answers that status, with that Location when `to`
 * is given; /chain/<n> redirects n times; /loop forever; /slow answers after
 * 200 ms; anything else answers 200 with the method and the body it received.
 */
function serve(name: string): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = sameBoundary(await request.text());
			received.push({ server: name, method: request.method, path: url.pathname + url.search, headers: [...request.headers].map(([n, v]) => sameBoundary(`${n}: ${v}`)).sort(), body });
			const parts = url.pathname.split("/");
			if (parts[1] === "s" && /^\d+$/.test(parts[2] ?? "")) {
				const status = Number(parts[2]);
				const to = url.searchParams.get("to");
				return new Response(status === 304 ? null : "redirect", { status, headers: { "x-from": "redirect", ...(to === null ? {} : { location: to }) } });
			}
			if (parts[1] === "chain" && Number(parts[2]) > 0) return new Response(null, { status: 302, headers: { location: `/chain/${Number(parts[2]) - 1}` } });
			if (parts[1] === "loop") return new Response(null, { status: 302, headers: { location: "/loop" } });
			if (parts[1] === "slow") await Bun.sleep(200);
			return new Response(JSON.stringify([request.method, body]), { headers: { "x-end": name, "content-type": "text/plain" } });
		},
	});
}

let one: ReturnType<typeof Bun.serve>;
let two: ReturnType<typeof Bun.serve>;
let A = ""; // a server
let B = ""; // another: another origin
let AByName = ""; // the first by another name: another origin, the same server
beforeAll(() => {
	one = serve("one");
	two = serve("two");
	A = `http://127.0.0.1:${one.port}`;
	B = `http://127.0.0.1:${two.port}`;
	AByName = `http://localhost:${one.port}`;
});
afterAll(() => {
	one.stop(true);
	two.stop(true);
});

/** A redirect from server one with this status to `to` (none when undefined). */
const via = (status: number, to?: string): string => `${A}/s/${status}${to === undefined ? "" : `?to=${encodeURIComponent(to)}`}`;

type Make = () => [string | URL | Request, RequestInit?];
type Outcome = Record<string, unknown>;

async function outcome(fetcher: typeof fetch, make: Make): Promise<Outcome> {
	const [input, init] = make();
	try {
		const response = await fetcher(input, init);
		const clone = response.clone() as Response;
		const shown = (r: Response) => ({ status: r.status, url: r.url, redirected: r.redirected, headers: [...r.headers].filter(([n]) => n !== "date") });
		return { ...shown(response), clone: shown(clone), body: await response.text(), cloneBody: await clone.text() };
	} catch (error) {
		const e = error as Error & { code?: string };
		return { error: e.name, message: e.message, code: e.code };
	}
}

/** Bun's fetch, then the guarded one: what each showed, and what the servers received. */
async function both(make: Make): Promise<{ runtime: Outcome; runtimeReceived: Received[]; guarded: Outcome; guardedReceived: Received[] }> {
	received.length = 0;
	const runtime = await outcome(runtimeFetch, make);
	const runtimeReceived = received.splice(0);
	const guarded = await outcome(fetch, make);
	const guardedReceived = received.splice(0);
	return { runtime, runtimeReceived, guarded, guardedReceived };
}

const custom = (): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			controller.enqueue(encode("pay"));
			controller.enqueue(encode("load"));
			controller.close();
		},
	});
const form = (): FormData => {
	const data = new FormData();
	data.set("field", "value");
	return data;
};

const REDIRECTS = [301, 302, 303, 307, 308];
const groups: Array<[string, Array<[string, Make]>]> = [];
const group = (name: string, cases: Array<[string, Make]>): void => void groups.push([name, cases]);

group(
	"each status, with and without a Location",
	[200, 201, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309].flatMap((status): Array<[string, Make]> => [
		[`${status} to /end`, () => [via(status, "/end")]],
		[`${status} without a Location`, () => [via(status)]],
	]),
);
groups[0]?.[1].push(["302 with an empty Location", () => [via(302, "")]]);

group(
	"each method, through each redirect",
	REDIRECTS.flatMap((status): Array<[string, Make]> => [
		...["GET", "HEAD", "DELETE", "OPTIONS", "get", "delete"].map((method): [string, Make] => [`${method} ${status}`, () => [via(status, "/end"), { method, headers: { "content-type": "text/plain", "x-ordinary": "kept" } }]]),
		...["POST", "PUT", "PATCH", "post", "put", "patch", "PROPFIND"].map((method): [string, Make] => [
			`${method} ${status} with a body`,
			() => [via(status, "/end"), { method, body: "payload", headers: { "content-type": "text/plain", "content-language": "en", "x-ordinary": "kept" } }],
		]),
	]),
);

group("a method rewritten once stays rewritten", [
	["POST through a 302, then a 307", () => [via(302, `/s/307?to=${encodeURIComponent("/end")}`), { method: "POST", body: "payload", headers: { "content-type": "text/plain" } }]],
	["PUT through a 303, then a 308", () => [via(303, `/s/308?to=${encodeURIComponent("/end")}`), { method: "PUT", body: "payload", headers: { "content-type": "text/plain" } }]],
	["PUT through a 307, a 303, then a 307", () => [via(307, `/s/303?to=${encodeURIComponent(`/s/307?to=${encodeURIComponent("/end")}`)}`), { method: "PUT", body: "payload" }]],
]);

const BODIES: Array<[string, () => NonNullable<RequestInit["body"]>]> = [
	["a string", () => "payload"],
	["bytes", () => encode("payload")],
	["an ArrayBuffer", () => encode("payload").buffer as ArrayBuffer],
	["a Blob", () => new Blob(["payload"], { type: "application/octet-stream" })],
	["URLSearchParams", () => new URLSearchParams({ a: "1", b: "two" })],
	["FormData", form],
	["an empty string", () => ""],
];
group(
	"every kind of body that can be sent again, in init and inside a Request",
	REDIRECTS.flatMap((status): Array<[string, Make]> => [
		...BODIES.flatMap(([kind, body]): Array<[string, Make]> => [
			[`${status}, POST, ${kind} in init`, () => [via(status, "/end"), { method: "POST", body: body() }]],
			[`${status}, PUT, ${kind} in init`, () => [via(status, "/end"), { method: "PUT", body: body() }]],
			[`${status}, POST, ${kind} in a Request`, () => [new Request(via(status, "/end"), { method: "POST", body: body() })]],
			[`${status}, PUT, ${kind} in a Request`, () => [new Request(via(status, "/end"), { method: "PUT", body: body() })]],
		]),
		[`${status}, a Request's body replaced by init's`, () => [new Request(via(status, "/end"), { method: "PUT", body: "from the Request" }), { body: "from init" }]],
		[`${status}, a Request's method and headers replaced by init's`, () => [new Request(via(status, "/end"), { method: "PUT", body: "payload", headers: { "x-ordinary": "request" } }), { method: "POST", headers: { "x-ordinary": "init" } }]],
	]),
);

group("a body that is a stream, where Bun and the guard agree", [
	["a stream, no redirect", () => [`${A}/end`, { method: "POST", body: custom() }]],
	["a Blob's stream, no redirect", () => [`${A}/end`, { method: "POST", body: new Blob(["payload"]).stream() }]],
	["a stream in a Request, no redirect", () => [new Request(`${A}/end`, { method: "POST", body: custom() })]],
	["a stream, a 300", () => [via(300, "/end"), { method: "POST", body: custom() }]],
	["a stream, a 304", () => [via(304, "/end"), { method: "POST", body: custom() }]],
	// A 303 sends no body on: Bun follows it for every stream, and so does the guard.
	["POST 303, a stream in init", () => [via(303, "/end"), { method: "POST", body: custom() }]],
	["PUT 303, a stream in init", () => [via(303, "/end"), { method: "PUT", body: custom() }]],
	["POST 303, a Blob's stream in init", () => [via(303, "/end"), { method: "POST", body: new Blob(["payload"]).stream() }]],
	["POST 303, a stream in a Request", () => [new Request(via(303, "/end"), { method: "POST", body: custom() })]],
	["a stream, redirect manual", () => [via(307, "/end"), { method: "POST", body: custom(), redirect: "manual" }]],
	["a stream, redirect error", () => [via(307, "/end"), { method: "POST", body: custom(), redirect: "error" }]],
]);

const CREDENTIALS = { authorization: "Bearer fixture", cookie: "a=1", "proxy-authorization": "Basic fixture", "x-ordinary": "kept", "content-type": "text/plain" };
const DESTINATIONS: Array<[string, () => string]> = [
	["the same origin", () => "/end"],
	["the same origin, written out", () => `${A}/end`],
	["another port", () => `${B}/end`],
	["another name for the same server", () => `${AByName}/end`],
];
group("credentials do not cross origins; other headers do, and everything stays within one", [
	...REDIRECTS.flatMap((status) =>
		DESTINATIONS.flatMap(([where, to]): Array<[string, Make]> => [
			[`${status} to ${where}`, () => [via(status, to()), { headers: CREDENTIALS }]],
			[`${status} to ${where}, headers in a Request`, () => [new Request(via(status, to()), { headers: CREDENTIALS })]],
			[`${status} to ${where}, PUT`, () => [via(status, to()), { method: "PUT", body: "payload", headers: CREDENTIALS }]],
		]),
	),
	["to another origin and back", () => [via(302, `${AByName}/s/302?to=${encodeURIComponent(`${A}/end`)}`), { headers: CREDENTIALS }]],
]);

const LOCATIONS: Array<() => string> = [
	() => "./end",
	() => "../end",
	() => "/end",
	() => "end?x=1",
	() => "?query=1",
	() => "/end#fragment",
	() => `//127.0.0.1:${one.port}/end`,
	() => `${A}/end?a=1&b=2`,
	() => " /end ",
	() => "http://[bad",
	() => "ftp://127.0.0.1/end",
	() => "mailto:a@b",
];
group(
	"each kind of Location, and an address with a fragment",
	LOCATIONS.flatMap((location, index): Array<[string, Make]> => [
		[`Location ${index}`, () => [via(302, location())]],
		[`Location ${index}, from an address with a fragment`, () => [`${via(302, location())}#start`]],
	]),
);

group("chains, Bun's limit of 126 redirects, and a loop", [
	...[1, 5, 20, 21, MOST_REDIRECTS, MOST_REDIRECTS + 1].map((length): [string, Make] => [`a chain of ${length}`, () => [`${A}/chain/${length}`]]),
	["a loop", () => [`${A}/loop`]],
	["a chain across both servers", () => [via(307, `${B}/s/308?to=${encodeURIComponent(`${A}/chain/3`)}`), { method: "POST", body: "payload" }]],
]);

group(
	"a signal, in init and in the Request, fired before and during",
	[302, 307].flatMap((status): Array<[string, Make]> => [
		[`${status}, aborted before, in init`, () => [via(status, "/end"), { signal: AbortSignal.abort() }]],
		[`${status}, aborted before, in a Request`, () => [new Request(via(status, "/end"), { signal: AbortSignal.abort() })]],
		[`${status}, fired while the destination answers, in init`, () => [via(status, "/slow"), { signal: AbortSignal.timeout(60) }]],
		[`${status}, fired while the destination answers, in a Request`, () => [new Request(via(status, "/slow"), { signal: AbortSignal.timeout(60) })]],
		[`${status}, in a Request, with init's own that never fires`, () => [new Request(via(status, "/slow"), { signal: AbortSignal.timeout(60) }), { signal: new AbortController().signal }]],
		[`${status}, a signal that never fires`, () => [new Request(via(status, "/end"), { signal: new AbortController().signal })]],
	]),
);

group(
	"redirect left at its default, follow, manual and error, in init and in the Request",
	REDIRECTS.flatMap((status): Array<[string, Make]> => [
		...([undefined, "follow", "manual", "error"] as const).flatMap((redirect): Array<[string, Make]> => [
			[`${status}, redirect ${redirect} in init`, () => [via(status, "/end"), redirect === undefined ? {} : { redirect }]],
			[`${status}, redirect ${redirect} in a Request`, () => [new Request(via(status, "/end"), redirect === undefined ? {} : { redirect })]],
		]),
		[`${status}, manual in the Request, follow in init`, () => [new Request(via(status, "/end"), { redirect: "manual" }), { redirect: "follow" }]],
		[`${status}, follow in the Request, manual in init`, () => [new Request(via(status, "/end"), { redirect: "follow" }), { redirect: "manual" }]],
	]),
);

group("HEAD keeps its method and headers through a 303", [
	["HEAD 303", () => [via(303, "/end"), { method: "HEAD", headers: { "content-type": "text/plain", "content-language": "en" } }]],
	["HEAD 303 in a Request", () => [new Request(via(303, "/end"), { method: "HEAD", headers: { "content-type": "text/plain" } })]],
]);

group("an address given as a URL object", [["a URL", () => [new URL(via(307, "/end")), { method: "POST", body: "payload" }]]]);

describe("the guarded fetch shows a test what Bun's fetch shows it", () => {
	for (const [name, cases] of groups) {
		describe(name, () => {
			for (const [label, make] of cases) {
				test(label, async () => {
					const { runtime, runtimeReceived, guarded, guardedReceived } = await both(make);
					expect({ outcome: guarded, received: guardedReceived }).toEqual({ outcome: runtime, received: runtimeReceived });
				});
			}
		});
	}
});

describe("the stated exception: a body that is a stream, on a 301, 302, 307 or 308 that would be followed, is refused by the guard after the first request", () => {
	const REPLAY = "Request body is a ReadableStream and cannot be replayed for this redirect";
	for (const status of [301, 302, 307, 308]) {
		// Bun follows these for a Blob's stream, and refuses them for another stream: from outside, the two look alike.
		const cases: Array<[string, Make, "followed" | "refused"]> = [
			[`POST ${status}, a Blob's stream in init`, () => [via(status, "/end"), { method: "POST", body: new Blob(["payload"]).stream() }], "followed"],
			[`PUT ${status}, a Blob's stream in init`, () => [via(status, "/end"), { method: "PUT", body: new Blob(["payload"]).stream() }], "followed"],
			[`POST ${status}, a stream in init`, () => [via(status, "/end"), { method: "POST", body: custom() }], "refused"],
			[`POST ${status}, a stream in a Request`, () => [new Request(via(status, "/end"), { method: "POST", body: custom() })], "refused"],
			[`PUT ${status}, a stream in init`, () => [via(status, "/end"), { method: "PUT", body: custom() }], "refused"],
		];
		for (const [label, make, bun] of cases) {
			test(`${label}: Bun ${bun} it`, async () => {
				const { runtime, runtimeReceived, guarded, guardedReceived } = await both(make);
				if (bun === "followed") expect([runtime.status, runtimeReceived.length]).toEqual([200, 2]);
				else expect([runtime.message, runtimeReceived.length]).toEqual([REPLAY, 1]);
				// The guard: the first request, as Bun sent it, then its own refusal, saying what to do.
				expect(guarded.message).toContain('give the fetch redirect: "manual", or a body that can be sent again');
				expect(guardedReceived).toEqual(runtimeReceived.slice(0, 1));
			});
		}
	}
});

test("the guard keeps Bun's limit, 126 redirects, not the standard's 20", async () => {
	expect(MOST_REDIRECTS).toBe(126);
	const longest = await fetch(`${A}/chain/${MOST_REDIRECTS}`);
	expect([longest.status, longest.redirected]).toEqual([200, true]);
	await expect(fetch(`${A}/chain/${MOST_REDIRECTS + 1}`)).rejects.toThrow("TooManyRedirects");
});
