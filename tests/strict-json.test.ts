import { describe, expect, test } from "bun:test";

import { duplicateMember, parseStrictJson } from "../scripts/lib/strict-json";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const problem = (input: Uint8Array): string => {
	try {
		parseStrictJson(input);
	} catch (error) {
		return (error as Error).message;
	}
	return "none";
};

describe("strict JSON", () => {
	test("reads what JSON.parse reads, when every name in an object is its own", () => {
		const text = '{"a":1,"b":{"a":2,"c":[{"a":3},{"a":4}]},"d":"\\"a\\":5","e":[]}';
		expect(parseStrictJson(bytes(text))).toEqual(JSON.parse(text));
		expect(duplicateMember(text)).toBeNull();
	});

	test("rejects a name twice in one object, keeping neither: at the top, nested, and in an array", () => {
		expect(duplicateMember('{"count":999,"count":187}')).toEqual({ at: "/", name: "count" });
		expect(duplicateMember('{"a":{"b":1,"c":{"d":1,"d":2}}}')).toEqual({ at: "/a/c", name: "d" });
		expect(duplicateMember('{"series":[{"id":"x"},{"id":"y","url":"u","id":"z"}]}')).toEqual({ at: "/series/1", name: "id" });
		expect(duplicateMember('[1,[2,{"a/b~":{"k":1,"k":2}}]]')).toEqual({ at: "/1/1/a~1b~0", name: "k" });
		expect(problem(bytes('{"count": 999, "count": 187}'))).toBe('the object at / holds the member "count" twice');
	});

	test("finds a name twice in an object of many members, as in one of few", () => {
		const members = Array.from({ length: 1000 }, (_, i) => `"k${i}":${i}`);
		expect(duplicateMember(`{${members.join(",")}}`)).toBeNull();
		expect(duplicateMember(`{"wide":{${members.join(",")},"k3":0}}`)).toEqual({ at: "/wide", name: "k3" });
		expect(duplicateMember(`{"wide":{${members.join(",")},"k999":0}}`)).toEqual({ at: "/wide", name: "k999" });
	});

	test("compares names as they decode: an escaped name is the same name", () => {
		expect(duplicateMember('{"a":1,"\\u0061":2}')).toEqual({ at: "/", name: "a" });
		expect(duplicateMember('{"a\\/b":1,"a/b":2}')).toEqual({ at: "/", name: "a/b" });
		expect(duplicateMember('{"\\\\":1,"\\u005c":2}')).toEqual({ at: "/", name: "\\" });
		expect(duplicateMember('{"a\\"":1,"a":2}')).toBeNull();
	});

	test("takes no string inside a value, nor a name of another object, for a member", () => {
		expect(duplicateMember('{"a":"a","b":"\\"a\\":1,","c":["a","a"]}')).toBeNull();
		expect(duplicateMember('{"a":{"a":{"a":1}},"b":[{"a":1},{"a":2}]}')).toBeNull();
		expect(duplicateMember('{"x":"\\\\","x2":"{\\"y\\":1,\\"y\\":2}"}')).toBeNull();
		expect(duplicateMember('{"k":{"p":1},"j":{"p":2}}')).toBeNull();
	});

	test("rejects bytes that are not UTF-8, saying which byte, where a lenient decoder would put U+FFFD", () => {
		const good = bytes('{"about":"x"}');
		const bad = new Uint8Array([...good.subarray(0, 10), 0xff, ...good.subarray(10)]);
		expect(new TextDecoder().decode(bad)).toContain("�");
		expect(problem(bad)).toBe("it is not UTF-8: byte 10 is 0xff");
		expect(problem(new Uint8Array([...bytes('{"a":"'), 0xc0, 0xaf, ...bytes('"}')]))).toBe("it is not UTF-8: byte 6 is 0xc0");
		expect(problem(new Uint8Array([...bytes('{"a":"'), 0xed, 0xa0, 0x80, ...bytes('"}')]))).toBe("it is not UTF-8: byte 7 is 0xa0");
		expect(problem(new Uint8Array([...bytes('"'), 0xe2, 0x82]))).toBe("it is not UTF-8: the last character is cut off");
		expect(parseStrictJson(bytes('{"a":"€ ü 𝄞"}'))).toEqual({ a: "€ ü 𝄞" });
	});

	test("rejects a byte-order mark, and what is not JSON", () => {
		expect(problem(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("{}")]))).toBe("it begins with a byte-order mark");
		expect(problem(bytes('{"a":1,}'))).toStartWith("it is not JSON: ");
	});
});
