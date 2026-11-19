/**
 * JSON read as strictly as the strictest reader of it would: the bytes must
 * be UTF-8 (RFC 8259 §8.1), with no byte-order mark, and no object may hold
 * the same member name twice (§4 leaves a reader free to reject such an
 * object, keep the first value or keep the last, so a file that holds one
 * means different things to different readers).
 *
 * TextDecoder with `fatal` and JSON.parse see to the bytes and the syntax.
 * JSON.parse keeps the last of two equal names and says nothing, so the text
 * is then scanned for them: names are compared as JSON.parse decodes them, so
 * "a" and "a" are the same name.
 */

/** Why a text is not strict JSON: the problem, without the file's name. */
export class StrictJsonError extends Error {}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The value of strict JSON bytes; throws StrictJsonError saying why when they are not. */
export function parseStrictJson(bytes: Uint8Array): unknown {
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
	const duplicate = duplicateMember(text);
	if (duplicate !== null) throw new StrictJsonError(`the object at ${duplicate.at} holds the member ${JSON.stringify(duplicate.name)} twice`);
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

/**
 * The first object, in the order of the text, that holds a member name a
 * second time: where it is, as a JSON Pointer, and the name. Null when there
 * is none. The text must be JSON (JSON.parse has read it): the scan reads
 * strings, the structural characters and nothing else, and a string inside a
 * value, or a name of a nested object, is never taken for a member of the
 * object around it.
 */
export function duplicateMember(text: string): { at: string; name: string } | null {
	const stack: Frame[] = [];
	/** The JSON Pointer of the object or array on top of the stack: each enclosing one's key of what is being read. */
	const pointer = (): string =>
		stack
			.slice(0, -1)
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
					if (names.includes(name)) return { at: pointer(), name };
					names.push(name);
					if (names.length > SMALL) top.names = new Set(names);
				} else {
					if (names.has(name)) return { at: pointer(), name };
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
		}
	}
	return null;
}
