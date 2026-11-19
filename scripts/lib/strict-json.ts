/**
 * JSON read as strictly as the strictest reader of it would: the bytes must
 * be UTF-8 (RFC 8259 §8.1), with no byte-order mark, and no object may hold
 * the same member name twice (§4 leaves a reader free to reject such an
 * object, keep the first value or keep the last, so a file that holds one
 * means different things to different readers).
 *
 * With `exactNumbers`, no number may lose its value either. JavaScript reads
 * a number as an IEEE 754 double, and writes back the shortest digits that
 * read as that double again (JSON.stringify); §6 leaves a reader free to set
 * limits on range and precision, and a figure past them would be changed,
 * silently, on its way through. So every number token is read as text, and
 * refused unless its decimal value is exactly the value of what JavaScript
 * writes back for it: 9007199254740993 (past 2^53: it reads as ...992),
 * 1e400 (past a double's range: Infinity, which JSON.stringify writes as
 * null), 1e-400 (below it: 0) and 0.10000000000000001 (more digits than a
 * double holds: 0.1) are refused; 1e3 is written 1000 and 1.50 is written
 * 1.5, the same values, and pass. -0 passes and is written 0: it is the
 * value zero, which is all a decimal number says; the sign of a zero is a
 * double's, not a figure's (JSON.stringify writes -0 as 0, so no Method
 * emits it).
 *
 * TextDecoder with `fatal` and JSON.parse see to the bytes and the syntax.
 * JSON.parse keeps the last of two equal names and says nothing, so the text
 * is then scanned for them: names are compared as JSON.parse decodes them, so
 * "a" and "a" are the same name. The same scan reads each number token.
 */

/** Why a text is not strict JSON: the problem, without the file's name. */
export class StrictJsonError extends Error {}

export interface StrictJsonOptions {
	/** Refuse a number whose value is not exactly the value of what JavaScript writes back for it (exactNumber). */
	exactNumbers?: boolean;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The value of strict JSON bytes; throws StrictJsonError saying why when they are not. */
export function parseStrictJson(bytes: Uint8Array, options: StrictJsonOptions = {}): unknown {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new StrictJsonError("it begins with a byte-order mark");
	let text: string;
	try {
		text = decoder.decode(bytes);
	} catch {
		throw new StrictJsonError(`it is not UTF-8: ${firstBadByte(bytes)}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new StrictJsonError(`it is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const problem = scan(text, options.exactNumbers === true);
	if (problem !== null) {
		if (problem.kind === "member") throw new StrictJsonError(`the object at ${problem.at} holds the member ${JSON.stringify(problem.name)} twice`);
		throw new StrictJsonError(
			problem.written === "null"
				? `the number at ${problem.at} is ${problem.token}, past the range of a double: JavaScript reads it as ${String(Number(problem.token))}, which JSON writes as null`
				: `the number at ${problem.at} is ${problem.token}, which a double does not hold exactly: it would be written ${problem.written}, another value`,
		);
	}
	return value;
}

/** Where the first byte that is not UTF-8 is (RFC 3629 §4: no overlong form, no surrogate, nothing past U+10FFFF), and what it is. */
function firstBadByte(bytes: Uint8Array): string {
	const at = (i: number): string => (i < bytes.length ? `byte ${i} is 0x${(bytes[i] as number).toString(16).padStart(2, "0")}` : "the last character is cut off");
	let i = 0;
	while (i < bytes.length) {
		const b = bytes[i] as number;
		if (b < 0x80) {
			i++;
			continue;
		}
		// The length of the sequence b begins, and the range its second byte must be in.
		const [length, low, high] =
			b >= 0xc2 && b <= 0xdf ? [2, 0x80, 0xbf]
			: b === 0xe0 ? [3, 0xa0, 0xbf]
			: b === 0xed ? [3, 0x80, 0x9f]
			: b >= 0xe1 && b <= 0xef ? [3, 0x80, 0xbf]
			: b === 0xf0 ? [4, 0x90, 0xbf]
			: b >= 0xf1 && b <= 0xf3 ? [4, 0x80, 0xbf]
			: b === 0xf4 ? [4, 0x80, 0x8f]
			: [0, 0, 0];
		if (length === 0) return at(i);
		for (let k = 1; k < length; k++) {
			const next = bytes[i + k];
			if (next === undefined || next < (k === 1 ? low : 0x80) || next > (k === 1 ? high : 0xbf)) return at(i + k);
		}
		i += length;
	}
	return "it does not decode";
}

/**
 * The decimal value a JSON number token, or JavaScript's text of a number
 * (String(n), as 1e+21 or 1.5e-7), stands for, as one text per value: the
 * sign, the significant digits without leading or trailing zeros, and the
 * power of ten of the last one; "0" for zero, whatever its sign or exponent.
 */
export function decimalValue(text: string): string {
	const negative = text.charCodeAt(0) === 0x2d;
	const e = text.search(/[eE]/);
	const mantissa = text.slice(negative ? 1 : 0, e < 0 ? text.length : e);
	const dot = mantissa.indexOf(".");
	const digits = dot < 0 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
	const first = digits.search(/[1-9]/);
	if (first < 0) return "0";
	let last = digits.length;
	while (digits.charCodeAt(last - 1) === 0x30) last--;
	const exponent = (e < 0 ? 0n : BigInt(text.slice(e + 1))) - BigInt(dot < 0 ? 0 : mantissa.length - dot - 1) + BigInt(digits.length - last);
	return `${negative ? "-" : ""}${digits.slice(first, last)}e${exponent}`;
}

/**
 * What JavaScript writes back for a JSON number token, when its value is not
 * exactly the token's; null when it is. A token of at most 15 characters with
 * no exponent has at most 15 significant digits and lies between 1e-14 and
 * 1e15, where every such decimal is the shortest text of the double nearest
 * it (a double holds 15 significant decimal digits, DBL_DIG): it is exact,
 * and is not converted at all. Nor is a longer one that JavaScript writes back
 * as it is.
 */
export function inexactNumber(token: string): string | null {
	if (token.length <= 15) {
		let plain = true;
		for (let i = 0; i < token.length; i++) {
			const c = token.charCodeAt(i);
			if (c === 0x65 || c === 0x45) {
				plain = false;
				break;
			}
		}
		if (plain) return null;
	}
	const value = Number(token);
	if (!Number.isFinite(value)) return "null";
	const written = String(value);
	if (written === token || decimalValue(written) === decimalValue(token)) return null;
	return written;
}

const QUOTE = 0x22;
/** An object's names are kept in an array up to this many, then in a Set. */
const SMALL = 16;
const BACKSLASH = 0x5c;

interface Frame {
	/**
	 * The names seen so far, for an object; null for an array. An array while
	 * there are few, since most objects have few members and a Set for each
	 * costs more than the search; a Set past SMALL, so a wide object costs no
	 * more than a Set does.
	 */
	names: string[] | Set<string> | null;
	/** For an object: whether the next string is a name. */
	expectName: boolean;
	/** The member or index being read, for a JSON Pointer. */
	key: string | number;
}

type Problem = { kind: "member"; at: string; name: string } | { kind: "number"; at: string; token: string; written: string };

/** The first object, in the order of the text, that holds a member name a second time: where it is, as a JSON Pointer, and the name. Null when there is none. */
export function duplicateMember(text: string): { at: string; name: string } | null {
	const problem = scan(text, false);
	return problem?.kind === "member" ? { at: problem.at, name: problem.name } : null;
}

/** The first number, in the order of the text, whose value JavaScript would not write back exactly: where it is, as a JSON Pointer, the token and what would be written. Null when there is none. */
export function inexactNumberIn(text: string): { at: string; token: string; written: string } | null {
	const problem = scan(text, true);
	return problem?.kind === "number" ? { at: problem.at, token: problem.token, written: problem.written } : null;
}

/**
 * The first problem in the order of the text: an object that holds a member
 * name a second time, or, with `numbers`, a number that would not be written
 * back with its value (inexactNumber). Null when there is none. The text must
 * be JSON (JSON.parse has read it): the scan reads strings, numbers, the
 * structural characters and nothing else, and a string inside a value, or a
 * name of a nested object, is never taken for a member of the object around it.
 */
function scan(text: string, numbers: boolean): Problem | null {
	const stack: Frame[] = [];
	/** The JSON Pointer of the object or array on top of the stack: each enclosing one's key of what is being read. */
	const pointer = (depth: number): string =>
		stack
			.slice(0, depth)
			.map((frame) => `/${String(frame.key).replaceAll("~", "~0").replaceAll("/", "~1")}`)
			.join("") || "/";
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === QUOTE) {
			// The closing quote: the first one not escaped, that is, after an even number of backslashes.
			let end = i + 1;
			for (;;) {
				const quote = text.indexOf('"', end);
				let backslashes = 0;
				for (let j = quote - 1; j > i && text.charCodeAt(j) === BACKSLASH; j--) backslashes++;
				if (backslashes % 2 === 0) {
					end = quote;
					break;
				}
				end = quote + 1;
			}
			const top = stack[stack.length - 1];
			if (top?.names != null && top.expectName) {
				const raw = text.slice(i + 1, end);
				const name = raw.includes("\\") ? (JSON.parse(`"${raw}"`) as string) : raw;
				const names = top.names;
				if (Array.isArray(names)) {
					if (names.includes(name)) return { kind: "member", at: pointer(stack.length - 1), name };
					names.push(name);
					if (names.length > SMALL) top.names = new Set(names);
				} else {
					if (names.has(name)) return { kind: "member", at: pointer(stack.length - 1), name };
					names.add(name);
				}
				top.key = name;
				top.expectName = false;
			}
			i = end;
		} else if (c === 0x7b /* { */) {
			stack.push({ names: [], expectName: true, key: "" });
		} else if (c === 0x5b /* [ */) {
			stack.push({ names: null, expectName: false, key: 0 });
		} else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
			stack.pop();
		} else if (c === 0x2c /* , */) {
			const top = stack[stack.length - 1];
			if (top === undefined) continue;
			if (top.names === null) top.key = (top.key as number) + 1;
			else top.expectName = true;
		} else if (c === 0x2d /* - */ || (c >= 0x30 && c <= 0x39)) {
			// A number: up to the first character no number holds.
			let end = i + 1;
			for (; end < text.length; end++) {
				const d = text.charCodeAt(end);
				if (!((d >= 0x30 && d <= 0x39) || d === 0x2e || d === 0x65 || d === 0x45 || d === 0x2b || d === 0x2d)) break;
			}
			if (numbers) {
				const token = text.slice(i, end);
				const written = inexactNumber(token);
				if (written !== null) return { kind: "number", at: pointer(stack.length), token, written };
			}
			i = end - 1;
		}
	}
	return null;
}
