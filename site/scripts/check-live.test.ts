// scripts/check-live.ts against stand-in answers, no network. Run with
// `bun test` inside site/.

import { describe, expect, test } from "bun:test";
import { checkLive, checkLiveOnce } from "./check-live";

const URL = "https://example.test/";
const TEXT = ["LedgerMath", "The site is on its way."];
const PAGE = `<!DOCTYPE html><html><head><title>LedgerMath</title></head><body><main><h1>LedgerMath</h1><p>The site is on its way.</p></main></body></html>`;
const HTML = { "content-type": "text/html; charset=utf-8" };

const answer = (body: string, init: ResponseInit = { headers: HTML }) => async () => new Response(body, init);

describe("checkLiveOnce", () => {
	test("passes a 200 HTML page holding every line", async () => {
		expect(await checkLiveOnce(URL, TEXT, answer(PAGE))).toEqual([]);
	});

	test("asks without following redirects or using a cache", async () => {
		let seen: RequestInit | undefined;
		await checkLiveOnce(URL, TEXT, async (_, init) => {
			seen = init;
			return new Response(PAGE, { headers: HTML });
		});
		expect(seen?.redirect).toBe("manual");
		expect(seen?.cache).toBe("no-store");
	});

	test("fails a line missing from the page", async () => {
		expect(await checkLiveOnce(URL, TEXT, answer(PAGE.replace("The site is on its way.", "")))).toEqual([
			`${URL} does not hold, in its body outside any script: "The site is on its way."`,
		]);
	});

	test("fails a line that only a script holds", async () => {
		const page = PAGE.replace("<p>The site is on its way.</p>", '<script>document.write("The site is on its way.")</script>');
		expect(await checkLiveOnce(URL, TEXT, answer(page))).toHaveLength(1);
	});

	test("fails a status other than 200, naming a redirect's target", async () => {
		expect(await checkLiveOnce(URL, TEXT, answer("", { status: 307, headers: { location: "https://www.example.test/" } }))).toEqual([
			`${URL} answered 307 (Location: https://www.example.test/), not 200`,
		]);
		expect(await checkLiveOnce(URL, TEXT, answer(PAGE, { status: 500, headers: HTML }))).toEqual([`${URL} answered 500, not 200`]);
	});

	test("fails a body that is not HTML", async () => {
		expect(await checkLiveOnce(URL, TEXT, answer(PAGE, { headers: { "content-type": "text/plain" } }))).toEqual([
			`${URL} answered with Content-Type "text/plain", not text/html`,
		]);
	});

	test("fails when the request fails", async () => {
		const problems = await checkLiveOnce(URL, TEXT, async () => {
			throw new Error("connection refused");
		});
		expect(problems).toEqual([`${URL}: connection refused`]);
	});
});

describe("checkLive", () => {
	test("tries again after a failed attempt", async () => {
		let calls = 0;
		const get = async () => (++calls === 1 ? new Response("", { status: 503 }) : new Response(PAGE, { headers: HTML }));
		expect(await checkLive(URL, TEXT, { attempts: 3, wait: 0, get })).toEqual([]);
		expect(calls).toBe(2);
	});

	test("gives the last attempt's problems when every attempt fails", async () => {
		let calls = 0;
		const get = async () => {
			calls++;
			return new Response("", { status: 503 });
		};
		expect(await checkLive(URL, TEXT, { attempts: 3, wait: 0, get })).toEqual([`${URL} answered 503, not 200`]);
		expect(calls).toBe(3);
	});
});
