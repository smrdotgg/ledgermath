import { describe, expect, test } from "bun:test";
import { countWords, describeWords, isFigure, isProse } from "./words";

describe("isFigure", () => {
	test.each(["12", "1,234", "3.2", "$0.0416", "12%", "4.5GB/s", "128ns", "~10", "2026-11-19", "(12", "ms)", "10:30", "3×", "12.5µs", "±0.3", "1/4", "10–20", "$0.0416/hour"].filter((w) => /\d/.test(w)))(
		"%s is a figure",
		(word) => expect(isFigure(word)).toBe(true),
	);
	test.each(["the", "API", "AWS", "m7i.large", "x86_64", "10,000-repetition", "GB/s", "c7g.xlarge,", "SHA-256"])("%s is not a figure", (word) => expect(isFigure(word)).toBe(false));
});

describe("isProse", () => {
	test("needs two letters in a row and must not be a figure", () => {
		expect(isProse("the")).toBe(true);
		expect(isProse("API")).toBe(true);
		expect(isProse("a")).toBe(false);
		expect(isProse("—")).toBe(false);
		expect(isProse("128ns")).toBe(false);
		expect(isProse("m7i.large")).toBe(true);
	});
});

describe("countWords", () => {
	test("counts body text, not the head, scripts, styles, svg or templates", () => {
		const html = `<!DOCTYPE html><html><head><title>Many title words here</title><style>p { color: red }</style></head>
			<body><!-- a comment with words --><h1>Measured machine figures</h1>
			<script>const words = "not these";</script><svg><text>chart label</text></svg>
			<template><p>template words</p></template><p>Each Run takes 12 ms on 5 machines.</p></body></html>`;
		// Measured machine figures (3) + Each Run takes ms on machines. (6 prose; a lone unit is a word); 12 and 5 are figures.
		expect(countWords(html)).toEqual({ all: 11, prose: 9, folded: 0, visible: 9 });
	});

	test("words inside a closed details are folded, its summary is not, an open one is visible", () => {
		const html = `<body><p>Read this</p>
			<details><summary>More about it</summary><p>Hidden prose words</p>
				<details open><summary>inner</summary><p>still hidden</p></details></details>
			<details open><summary>Shown</summary><p>Also shown here</p></details></body>`;
		const count = countWords(html);
		// visible: Read this (2) + More about it (3) + Shown (1) + Also shown here (3) = 9
		// folded: Hidden prose words (3) + inner (1) + still hidden (2) = 6
		expect(count).toEqual({ all: 15, prose: 15, folded: 6, visible: 9 });
	});

	test("decodes entities and splits on tags", () => {
		expect(countWords("<p>R&amp;D&nbsp;costs <b>one</b>two &#8212; 3&nbsp;GB</p>")).toEqual({ all: 7, prose: 4, folded: 0, visible: 4 });
	});

	test("an attribute holding > does not end the tag", () => {
		expect(countWords(`<p title="a > b">two words</p>`).prose).toBe(2);
	});
});

test("describeWords", () => {
	expect(describeWords({ all: 600, prose: 502, folded: 90, visible: 412 })).toBe("412 words (+90 folded)");
	expect(describeWords({ all: 1, prose: 1, folded: 0, visible: 1 })).toBe("1 word");
});
