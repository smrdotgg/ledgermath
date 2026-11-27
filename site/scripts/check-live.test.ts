// scripts/check-live.ts against stand-in answers, no network. Run with
// `bun test` inside site/.

import { describe, expect, test } from "bun:test";
import { HEADER_AND_FOOTER, HOME } from "../src/pages.text";
import { checkLive, checkLiveOnce, docsChecks, docsMarkdownUrl, homeCheck, type LiveCheck } from "./check-live";

describe("what is checked", () => {
	test("the home page, with its own fixed words, under any base", () => {
		expect(homeCheck("https://ledgermath.com/")).toEqual({ url: "https://ledgermath.com/", type: "text/html", text: HOME.text });
		expect(homeCheck("https://ledgermath.com").url).toBe("https://ledgermath.com/");
		expect(docsMarkdownUrl("https://preview.example.test")).toBe("https://preview.example.test/docs/index.md");
	});

	test("/docs/, from its Markdown as served: the Markdown, the page holding its title and description, the page as Markdown, and llms.txt", () => {
		const checks = docsChecks("https://ledgermath.com/", "# Documentation\n\nEvery page, by section.\n\n## API reference\n");
		expect(checks).toEqual([
			{ url: "https://ledgermath.com/docs/index.md", type: "text/markdown", text: ["# Documentation\n"] },
			{ url: "https://ledgermath.com/docs/", type: "text/html", text: [...HEADER_AND_FOOTER, "Documentation", "Every page, by section."] },
			{ url: "https://ledgermath.com/docs/", type: "text/markdown", text: ["# Documentation\n"], markdown: true },
			{ url: "https://ledgermath.com/llms.txt", type: "text/plain", text: ["# LedgerMath\n", "https://ledgermath.com/docs/index.md"] },
		]);
	});
});

const URL = "https://example.test/";
const TEXT = ["LedgerMath", "The site is on its way."];
const CHECK: LiveCheck = { url: URL, type: "text/html", text: TEXT };
const PAGE = `<!DOCTYPE html><html><head><title>LedgerMath</title></head><body><main><h1>LedgerMath</h1><p>The site is on its way.</p></main></body></html>`;
const HTML = { "content-type": "text/html; charset=utf-8" };

const answer = (body: string, init: ResponseInit = { headers: HTML }) => async () => new Response(body, init);
/** A 200 HTML answer whose body fails partway through. */
const brokenBody = async () =>
	new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("<!DOCTYPE html><html><body>"));
			},
			pull(controller) {
				controller.error(new Error("connection reset"));
			},
		}),
		{ headers: HTML },
	);

describe("checkLiveOnce", () => {
	test("passes a 200 HTML page holding every line", async () => {
		expect(await checkLiveOnce(CHECK, answer(PAGE))).toEqual([]);
	});

	test("asks without following redirects or using a cache", async () => {
		let seen: RequestInit | undefined;
		await checkLiveOnce(CHECK, async (_, init) => {
			seen = init;
			return new Response(PAGE, { headers: HTML });
		});
		expect(seen?.redirect).toBe("manual");
		expect(seen?.cache).toBe("no-store");
	});

	test("fails a line missing from the page", async () => {
		expect(await checkLiveOnce(CHECK, answer(PAGE.replace("The site is on its way.", "")))).toEqual([`${URL} does not hold, in its body outside any script: "The site is on its way."`]);
	});

	test("fails a line that only a script holds", async () => {
		const page = PAGE.replace("<p>The site is on its way.</p>", '<script>document.write("The site is on its way.")</script>');
		expect(await checkLiveOnce(CHECK, answer(page))).toHaveLength(1);
	});

	test("fails a status other than 200, naming a redirect's target", async () => {
		expect(await checkLiveOnce(CHECK, answer("", { status: 307, headers: { location: "https://www.example.test/" } }))).toEqual([`${URL} answered 307 (Location: https://www.example.test/), not 200`]);
		expect(await checkLiveOnce(CHECK, answer(PAGE, { status: 500, headers: HTML }))).toEqual([`${URL} answered 500, not 200`]);
	});

	test("fails a body that is not HTML", async () => {
		expect(await checkLiveOnce(CHECK, answer(PAGE, { headers: { "content-type": "text/plain" } }))).toEqual([`${URL} answered with Content-Type "text/plain", not text/html`]);
	});

	test("takes the media type before any parameter, in any case", async () => {
		expect(await checkLiveOnce(CHECK, answer(PAGE, { headers: { "content-type": "TEXT/HTML ; charset=utf-8" } }))).toEqual([]);
		expect(await checkLiveOnce(CHECK, answer(PAGE, { headers: { "content-type": "text/html" } }))).toEqual([]);
	});

	test("fails a media type that only starts with text/html", async () => {
		expect(await checkLiveOnce(CHECK, answer(PAGE, { headers: { "content-type": "text/htmlish" } }))).toEqual([`${URL} answered with Content-Type "text/htmlish", not text/html`]);
	});

	test("fails, rather than throws, when the body breaks off while being read", async () => {
		expect(await checkLiveOnce(CHECK, brokenBody)).toEqual([`${URL}: reading the body: connection reset`]);
	});

	test("fails when the request fails", async () => {
		const problems = await checkLiveOnce(CHECK, async () => {
			throw new Error("connection refused");
		});
		expect(problems).toEqual([`${URL}: connection refused`]);
	});
});

describe("checkLiveOnce, for Markdown", () => {
	const MARKDOWN: LiveCheck = { url: URL, type: "text/markdown", text: ["# Documentation\n"], markdown: true };
	const md = { "content-type": "text/markdown; charset=utf-8", vary: "Accept" };

	test("asks with Accept: text/markdown, and passes the Markdown with Vary: Accept", async () => {
		let accept: string | null = null;
		const get = async (_: string, init: RequestInit) => {
			accept = new Headers(init.headers).get("accept");
			return new Response("# Documentation\n\nText.\n", { headers: md });
		};
		expect(await checkLiveOnce(MARKDOWN, get)).toEqual([]);
		expect(accept as string | null).toBe("text/markdown");
	});

	test("fails the HTML instead, an answer without Vary: Accept, or Markdown without its title", async () => {
		expect(await checkLiveOnce(MARKDOWN, answer(PAGE))).toEqual([`${URL} (Accept: text/markdown) answered with Content-Type "text/html; charset=utf-8", not text/markdown`]);
		expect(await checkLiveOnce(MARKDOWN, answer("# Documentation\n", { headers: { "content-type": "text/markdown" } }))).toEqual([
			`${URL} (Accept: text/markdown) answered without Vary: Accept, so a cache could give it to a reader who asked for HTML`,
		]);
		expect(await checkLiveOnce(MARKDOWN, answer("# Something else\n", { headers: md }))).toEqual([`${URL} (Accept: text/markdown) does not hold "# Documentation\\n"`]);
	});
});

describe("checkLive", () => {
	test("tries again after a failed attempt", async () => {
		let calls = 0;
		const get = async () => (++calls === 1 ? new Response("", { status: 503 }) : new Response(PAGE, { headers: HTML }));
		expect(await checkLive(CHECK, { attempts: 3, wait: 0, get })).toEqual([]);
		expect(calls).toBe(2);
	});

	test("tries again after a body that broke off", async () => {
		let calls = 0;
		const get = async () => (++calls === 1 ? brokenBody() : new Response(PAGE, { headers: HTML }));
		expect(await checkLive(CHECK, { attempts: 3, wait: 0, get })).toEqual([]);
		expect(calls).toBe(2);
	});

	test("gives the last attempt's problems when every attempt fails", async () => {
		let calls = 0;
		const get = async () => {
			calls++;
			return new Response("", { status: 503 });
		};
		expect(await checkLive(CHECK, { attempts: 3, wait: 0, get })).toEqual([`${URL} answered 503, not 200`]);
		expect(calls).toBe(3);
	});
});
