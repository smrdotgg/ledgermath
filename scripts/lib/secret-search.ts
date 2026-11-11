/**
 * Searches files for secret values: what a boot wrote must hold none of the
 * keys runner/run.py gave a benchmark. Used by tests/service.test.ts and
 * scripts/box-in-container/expect.ts.
 *
 * Each value is looked for, ignoring case, as it is and in the forms a writer
 * could have put it in: hexadecimal, base64 and base64url (at each of the
 * three alignments it can have inside a longer encoded text), percent-encoded,
 * and as a JSON string's contents.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function base64Forms(value: Buffer): string[] {
	const forms: string[] = [];
	for (let offset = 0; offset < 3; offset++) {
		const total = offset + value.length;
		let text = Buffer.concat([Buffer.alloc(offset), value]).toString("base64");
		// Drop the first quantum when it mixes in the bytes before, and the
		// last when it mixes in the bytes after.
		if (total % 3 !== 0) text = text.slice(0, -4);
		if (offset > 0) text = text.slice(4);
		if (text.length >= 8) forms.push(text, text.replaceAll("+", "-").replaceAll("/", "_"));
	}
	return forms;
}

/** The forms of a secret that are looked for, each in lower case. */
export function secretForms(value: string): string[] {
	const bytes = Buffer.from(value, "utf8");
	const forms = [
		value,
		bytes.toString("hex"),
		encodeURIComponent(value),
		[...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
		JSON.stringify(value).slice(1, -1),
		...base64Forms(bytes),
	];
	return [...new Set(forms.map((form) => form.toLowerCase()))];
}

export interface SecretFound {
	path: string;
	secret: string;
	form: string;
}

/** Every regular file under each path (a file or a directory), recursively; symbolic links are not followed. */
export function filesUnder(...paths: string[]): string[] {
	const found: string[] = [];
	const walk = (path: string): void => {
		const stat = lstatSync(path);
		if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
		else if (stat.isFile()) found.push(path);
	};
	for (const path of paths) if (existsSync(path)) walk(path);
	return found;
}

/** Each place a secret, named by its key in `secrets`, is found in a file under `paths`. */
export function findSecrets(paths: string[], secrets: Record<string, string>): SecretFound[] {
	const forms = Object.entries(secrets).flatMap(([secret, value]) => secretForms(value).map((form) => ({ secret, form })));
	const found: SecretFound[] = [];
	for (const path of filesUnder(...paths)) {
		const text = readFileSync(path).toString("latin1").toLowerCase();
		for (const { secret, form } of forms) if (text.includes(form)) found.push({ path, secret, form });
	}
	return found;
}
