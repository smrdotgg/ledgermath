import { describe, expect, test } from "bun:test";

import { decimalValue, duplicateMember, inexactNumber, inexactNumberIn, parseStrictJson } from "../scripts/lib/strict-json";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const problem = (input: Uint8Array, exactNumbers = false): string => {
	try {
		parseStrictJson(input, { exactNumbers });
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

	test("with exactNumbers, refuses a number whose value a double does not hold, naming where it is and what would be written", () => {
		const refused = (token: string): string => problem(bytes(`{"a":[1,{"b":${token}}]}`), true);
		expect(refused("9007199254740993")).toBe("the number at /a/1/b is 9007199254740993, which a double does not hold exactly: it would be written 9007199254740992, another value");
		expect(refused("1e400")).toBe("the number at /a/1/b is 1e400, past the range of a double: JavaScript reads it as Infinity, which JSON writes as null");
		expect(refused("-1e400")).toBe("the number at /a/1/b is -1e400, past the range of a double: JavaScript reads it as -Infinity, which JSON writes as null");
		expect(refused("1e-400")).toBe("the number at /a/1/b is 1e-400, which a double does not hold exactly: it would be written 0, another value");
		expect(refused("0.10000000000000001")).toBe("the number at /a/1/b is 0.10000000000000001, which a double does not hold exactly: it would be written 0.1, another value");
		// Without the option, as JSON.parse reads them.
		expect(problem(bytes('{"a":9007199254740993}'))).toBe("none");
		// At the top, and in an array at the top.
		expect(inexactNumberIn("9007199254740993")).toEqual({ at: "/", token: "9007199254740993", written: "9007199254740992" });
		expect(inexactNumberIn("[0,1,1e400]")).toEqual({ at: "/2", token: "1e400", written: "null" });
	});

	test("with exactNumbers, passes a number written otherwise with the same value, and reads -0 as zero, written 0", () => {
		for (const token of ["1e3", "1E3", "1.50", "0.1", "100e-2", "1e+21", "1e21", "5e-324", "1.7976931348623157e308", "9007199254740992", "-0", "-0.0", "0e999", "123456789012345e-3"]) {
			expect(problem(bytes(`{"a":${token}}`), true)).toBe("none");
		}
		expect(JSON.stringify(parseStrictJson(bytes('{"a":-0,"b":1e3}'), { exactNumbers: true }))).toBe('{"a":0,"b":1000}');
		expect(decimalValue("-0")).toBe("0");
		expect(decimalValue("1.50e+1")).toBe("15e0");
		expect(decimalValue("0.0012300")).toBe("123e-5");
		expect(decimalValue("1e+21")).toBe(decimalValue("1000000000000000000000"));
	});

	test("takes no digit inside a string, or of a name, for a number", () => {
		expect(inexactNumberIn('{"9007199254740993":"9007199254740993","b":["1e400"]}')).toBeNull();
		expect(problem(bytes('{"9007199254740993":"1e400"}'), true)).toBe("none");
	});

	test("the fast path is exact: a token of at most 15 characters with no exponent is written back with its value", () => {
		// A seeded walk through such tokens: whole numbers, decimals, tiny and large, negative.
		let state = 7;
		const next = (n: number): number => {
			state = (state * 1103515245 + 12345) % 2 ** 31;
			return state % n;
		};
		for (let k = 0; k < 20_000; k++) {
			const digits = Array.from({ length: 1 + next(14) }, (_, i) => String(i === 0 ? 1 + next(9) : next(10))).join("");
			const point = next(digits.length + 1);
			let token = point === digits.length ? digits : point === 0 ? `0.${"0".repeat(next(14 - digits.length + 1))}${digits}` : `${digits.slice(0, point)}.${digits.slice(point)}`;
			if (next(2) === 1) token = `-${token}`;
			if (token.length > 15) continue;
			expect(decimalValue(String(Number(token)))).toBe(decimalValue(token));
			expect(inexactNumber(token)).toBeNull();
		}
	});
});
