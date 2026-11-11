/**
 * Where the lookup tool and the answer checker read LedgerMath's data from:
 * a location holding derivations.json (Method output), runs/ (the Run files)
 * and prices/ (the price files), laid out as the Runs repository lays them
 * out. A location is a directory (a clone of the Runs repository with a
 * derivations file beside runs/) or a base web address serving the same
 * paths.
 *
 * A web address cannot be listed, so the newest price file there is found by
 * asking for prices/<yyyy>/<mm>/<dd>/aws.json for each of the last
 * PRICE_PROBE_DAYS days, newest first.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { DerivationsFile } from "../../methods/v1/output";
import { checkPriceFile } from "./price-file-check";
import { PRICE_FILE_PATH, type PriceFile } from "./prices";

export type Fetch = (url: string) => Promise<Response>;

export const PRICE_PROBE_DAYS = 14;

export interface DataLocation {
	/** As given: a directory or a base web address. */
	base: string;
	isUrl: boolean;
	/** A file's bytes by its path in the location, or null when there is none. */
	read(path: string): Promise<Uint8Array | null>;
	/** The price files' paths, oldest first. */
	priceFilePaths(): Promise<string[]>;
	/** How a file is shown: its path in a directory, its address under a web address. */
	link(path: string): string;
}

/** A path inside a location: relative, forward slashes, no "." or ".." parts. */
export function isInsidePath(path: string): boolean {
	return path.length > 0 && !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function directoryLocation(base: string): DataLocation {
	const root = resolve(base);
	return {
		base,
		isUrl: false,
		async read(path) {
			if (!isInsidePath(path)) return null;
			const full = join(root, ...path.split("/"));
			if (!existsSync(full)) return null;
			return new Uint8Array(readFileSync(full));
		},
		async priceFilePaths() {
			const directory = join(root, "prices");
			if (!existsSync(directory)) return [];
			return readdirSync(directory, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
				.filter((path) => PRICE_FILE_PATH.test(path))
				.sort();
		},
		link: (path) => path,
	};
}

function urlLocation(base: string, fetchFile: Fetch, today: Date): DataLocation {
	const prefix = base.endsWith("/") ? base : `${base}/`;
	const read = async (path: string): Promise<Uint8Array | null> => {
		if (!isInsidePath(path)) return null;
		const response = await fetchFile(`${prefix}${path}`);
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`${prefix}${path}: HTTP ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	};
	return {
		base,
		isUrl: true,
		read,
		async priceFilePaths() {
			for (let day = 0; day < PRICE_PROBE_DAYS; day++) {
				const iso = new Date(today.getTime() - day * 86_400_000).toISOString();
				const path = `prices/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/aws.json`;
				if ((await read(path)) !== null) return [path];
			}
			return [];
		},
		link: (path) => `${prefix}${path}`,
	};
}

export function openLocation(base: string, options: { fetch?: Fetch; today?: Date } = {}): DataLocation {
	if (/^https?:\/\//.test(base)) return urlLocation(base, options.fetch ?? ((url) => fetch(url)), options.today ?? new Date());
	return directoryLocation(base);
}

/** A derivations file as the tool reads it. `synthetic`, when present, says the file is made up, and why. */
export type Derivations = DerivationsFile & { synthetic?: string };

export interface LoadedPrices {
	path: string;
	/** yyyy-mm-dd, from the path. */
	date: string;
	file: PriceFile;
}

export interface LedgerData {
	location: DataLocation;
	/** What derivations were read from: a path in the location, or a file given apart. */
	derivationsFrom: string;
	derivations: Derivations;
	/** Every price file found, oldest first. */
	priceFiles: string[];
	/** The price file in use: the newest, or the one asked for. */
	prices: LoadedPrices | null;
	/** Price files read, by path, for citations of any date. */
	readPrices(path: string): Promise<LoadedPrices | null>;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function parseDerivations(text: string, from: string): Derivations {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`${from} is not JSON`);
	}
	const file = value as Partial<Derivations> | null;
	if (file === null || typeof file !== "object" || file.schema !== "ledgermath.derivations/1") {
		throw new Error(`${from} is not a ledgermath.derivations/1 file`);
	}
	if (file.method?.name !== "series" || file.method.version !== 1 || !Array.isArray(file.derivations)) {
		throw new Error(`${from} is not the output of Method series version 1, the only version this tool reads`);
	}
	return file as Derivations;
}

export function datePart(path: string): string {
	const match = PRICE_FILE_PATH.exec(path);
	return match === null ? "" : `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Reads the derivations and the price file in use. `derivations` reads them
 * from a local file instead of the location's derivations.json; `pricesDate`
 * (yyyy-mm-dd) picks a price file other than the newest.
 */
export async function loadLedger(location: DataLocation, options: { derivations?: string; pricesDate?: string } = {}): Promise<LedgerData> {
	let derivationsFrom: string;
	let text: string;
	if (options.derivations !== undefined) {
		derivationsFrom = options.derivations;
		if (!existsSync(options.derivations)) throw new Error(`no derivations file at ${options.derivations}`);
		text = readFileSync(options.derivations, "utf8");
	} else {
		derivationsFrom = location.link("derivations.json");
		const bytes = await location.read("derivations.json");
		if (bytes === null) throw new Error(`no derivations.json at ${location.base}`);
		text = decode(bytes);
	}
	const derivations = parseDerivations(text, derivationsFrom);

	const cache = new Map<string, LoadedPrices | null>();
	const readPrices = async (path: string): Promise<LoadedPrices | null> => {
		if (!PRICE_FILE_PATH.test(path)) return null;
		if (cache.has(path)) return cache.get(path) ?? null;
		const bytes = await location.read(path);
		let loaded: LoadedPrices | null = null;
		if (bytes !== null) {
			let value: unknown;
			try {
				value = JSON.parse(decode(bytes));
			} catch {
				throw new Error(`${location.link(path)} is not JSON`);
			}
			const problems = checkPriceFile(value, path);
			if (problems.length > 0) throw new Error(`${location.link(path)} is not a valid price file: ${problems.join("; ")}`);
			loaded = { path, date: datePart(path), file: value as PriceFile };
		}
		cache.set(path, loaded);
		return loaded;
	};

	const priceFiles = await location.priceFilePaths();
	let prices: LoadedPrices | null = null;
	if (options.pricesDate !== undefined) {
		const [year, month, day] = options.pricesDate.split("-");
		const path = `prices/${year}/${month}/${day}/aws.json`;
		prices = await readPrices(path);
		if (prices === null) throw new Error(`no price file for ${options.pricesDate} at ${location.base} (${path})`);
		if (!priceFiles.includes(path)) priceFiles.push(path);
		priceFiles.sort();
	} else if (priceFiles.length > 0) {
		prices = await readPrices(priceFiles[priceFiles.length - 1] as string);
	}
	return { location, derivationsFrom, derivations, priceFiles, prices, readPrices };
}
