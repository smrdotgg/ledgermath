/**
 * Method version 1: Runs in, Derivations out.
 *
 *     const blobs = await gather(files, fetchBlob);   // the only I/O: blobs by hash
 *     const derivations = derive(files, blobs);       // pure
 *     writeFileSync(out, serialize(derivations));
 *
 * Series: the Runs that share a benchmark, params, build, instance type and
 * zone ID. One number per Run: the median over its counted samples of
 * (sample_ended.t - sample_started.t) / repetitions, and bytes per second
 * where the benchmark observed bytes_per_repetition. Percentiles (5th, 50th,
 * 95th) across the counted Runs of a Series, and of each group within it.
 * Groups: the Runs whose split facts (facts.ts) are all equal; they may
 * interleave in time. What differed: for each pair of consecutive Runs, every
 * split fact and every before-dump section whose value changed. Failed Runs
 * are shown and in no percentile.
 *
 * Same Run files and blobs in, same bytes out: everything is sorted in byte
 * order and nothing reads a clock or the machine it runs on.
 *
 * Once Derivations of this version are published, a change to what it
 * outputs is version 2, in methods/v2/, beside this one.
 */

import { basename } from "node:path";

import {
	canonicalJson,
	compareText,
	type FetchBlob,
	parseDumpIndex,
	type Run,
	type RunFile,
	schemaErrors,
	schemaValidators,
} from "../run";
import {
	type BlobMap,
	changedKeys,
	type Facts,
	NOT_SPLIT_ON,
	outcome,
	SPLIT_FACTS,
	seriesId,
	seriesKey,
	seriesKeyText,
	splitFacts,
	UNREAD_SECTIONS,
} from "./facts";
import { median, observedBytesPerRepetition, percentile } from "./numbers";
import type {
	CitedRun,
	DerivationsFile,
	Differed,
	Group,
	MethodName,
	Percentiles,
	Point,
	SectionCounts,
	SectionEvidence,
	SeriesDerivation,
	Stat,
} from "./output";

export const METHOD: MethodName = { name: "series", version: 1 };

export const DEFINITIONS: Record<string, string> = {
	series: "The Runs that share a benchmark, params, build, instance type and zone ID.",
	time_per_repetition:
		"Per Run: for each counted sample (warmup samples left out), sample_ended.t minus sample_started.t, divided by " +
		"the sample's repetitions; the Run's number is the median of those (the mean of the two middle values when " +
		"there is an even number of samples).",
	bytes_per_second:
		"Per Run, where the benchmark observed bytes_per_repetition: bytes_per_repetition × 10^9 / the Run's time per " +
		"repetition in nanoseconds.",
	percentiles:
		"5th, 50th and 95th percentiles across the counted Runs of a Series, and of each group, by linear interpolation " +
		"between closest ranks (R type 7): with n values sorted, h = (n − 1) × p / 100 and the percentile is " +
		"x[⌊h⌋] + (h − ⌊h⌋) × (x[⌊h⌋+1] − x[⌊h⌋]). Each number's percentiles are taken over that number's values, " +
		"so the bytes-per-second percentiles are not the time percentiles inverted.",
	counted:
		"A Run counts when its binary exited 0, every stdout line is an event that matches the events schema, and the " +
		"stream obeys every order rule scripts/check-events.py checks: started first and once (not a --quick stream), " +
		"finished last and once, samples numbered from 0, each closed by its own sample_ended before the next starts " +
		"and never ending before it starts, observed keys once, exactly one verified, and as many counted samples as " +
		"the Run asked for. Any other Run is failed: shown, with the reasons, and in no percentile.",
	groups:
		"Within a Series, the Runs whose split facts are all equal make one group. Groups are lettered in the order " +
		"each first appears, and may interleave in time.",
	differed:
		"For each pair of consecutive Runs in a Series, every split fact and every dump section of the before-dump " +
		"whose value changed, split on or not, with the top-level keys that changed for the sections that are read.",
};

interface ReadRun {
	file: RunFile;
	run: Run;
}

/** The Run files that validate against the Run schema, and those that do not. */
export function readRuns(files: readonly RunFile[]): { runs: ReadRun[]; unreadable: DerivationsFile["unreadable"] } {
	const validate = schemaValidators().run;
	const runs: ReadRun[] = [];
	const unreadable: DerivationsFile["unreadable"] = [];
	for (const file of files) {
		if (validate(file.record)) runs.push({ file, run: file.record });
		else {
			unreadable.push({
				id: basename(file.path, ".json"),
				path: file.path,
				sha256: file.sha256,
				reason: schemaErrors(validate),
			});
		}
	}
	unreadable.sort((a, b) => compareText(a.path, b.path));
	return { runs, unreadable };
}

/**
 * Fetches every blob version 1 reads: each Run's before and after dump
 * indexes, and the sections of each before-dump except UNREAD_SECTIONS.
 * Throws if a Run names a blob that cannot be fetched.
 */
export async function gather(files: readonly RunFile[], fetchBlob: FetchBlob, concurrency = 16): Promise<Map<string, Uint8Array>> {
	const { runs } = readRuns(files);
	const blobs = new Map<string, Uint8Array>();
	const fetchAll = async (hashes: Iterable<string>): Promise<void> => {
		const wanted = [...new Set(hashes)].filter((hash) => !blobs.has(hash)).sort(compareText);
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < wanted.length) {
				const hash = wanted[next++] as string;
				const bytes = await fetchBlob(hash);
				if (bytes === null) throw new Error(`blob ${hash} cannot be fetched`);
				blobs.set(hash, bytes);
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
	};

	await fetchAll(runs.flatMap(({ run }) => [run.environment.before, run.environment.after]));
	const sections: string[] = [];
	for (const { run } of runs) {
		const index = parseDumpIndex(run.environment.before, blobs.get(run.environment.before) as Uint8Array);
		for (const [name, hash] of Object.entries(index.sections)) if (!UNREAD_SECTIONS.has(name)) sections.push(hash);
	}
	await fetchAll(sections);
	return blobs;
}

function dumpSections(hash: string, blobs: BlobMap): Record<string, string> {
	const bytes = blobs.get(hash);
	if (bytes === undefined) throw new Error(`dump index ${hash} was not fetched`);
	return parseDumpIndex(hash, bytes).sections;
}

interface Analysed {
	file: RunFile;
	run: Run;
	keyText: string;
	facts: Facts;
	factsText: string;
	before: Record<string, string>;
	after: Record<string, string>;
	point: (group: string) => Point;
}

function analyse({ file, run }: ReadRun, blobs: BlobMap): Analysed {
	const before = dumpSections(run.environment.before, blobs);
	const after = dumpSections(run.environment.after, blobs);
	const facts = splitFacts(run, before, blobs);
	const { failures, samples } = outcome(run);
	const counted = failures.length === 0;
	const time = counted ? median(samples.map((sample) => sample.ns_per_repetition)) : null;
	const bytes = counted ? observedBytesPerRepetition(run) : null;
	return {
		file,
		run,
		keyText: seriesKeyText(seriesKey(run)),
		facts,
		factsText: JSON.stringify(SPLIT_FACTS.map(({ fact }) => facts[fact] ?? null)),
		before,
		after,
		point: (group) => ({
			run: run.id,
			path: file.path,
			started_at: run.started_at,
			boot: run.boot,
			group,
			counted,
			failure: counted ? null : failures.join("; "),
			samples,
			time_per_repetition_ns: time,
			bytes_per_repetition: bytes,
			bytes_per_second: time !== null && bytes !== null ? (bytes * 1e9) / time : null,
		}),
	};
}

function stat(points: readonly Point[], value: (point: Point) => number | null): Stat | null {
	const used = points.filter((point) => point.counted && value(point) !== null);
	if (used.length === 0) return null;
	const values = used.map((point) => value(point) as number);
	return {
		count: used.length,
		runs: used.map((point) => point.run),
		p5: percentile(values, 5),
		p50: percentile(values, 50),
		p95: percentile(values, 95),
	};
}

function percentilesOf(points: readonly Point[]): Percentiles {
	return {
		time_per_repetition_ns: stat(points, (point) => point.time_per_repetition_ns),
		bytes_per_second: stat(points, (point) => point.bytes_per_second),
	};
}

/** A, B, …, Z, AA, AB, … */
export function groupLetter(index: number): string {
	let n = index + 1;
	let letters = "";
	while (n > 0) {
		const remainder = (n - 1) % 26;
		letters = String.fromCharCode(65 + remainder) + letters;
		n = Math.floor((n - 1) / 26);
	}
	return letters;
}

/** Each dump section a split fact is read from, and that fact. */
const SECTION_FACT = new Map(
	SPLIT_FACTS.flatMap(({ fact, section }) => (section === undefined ? [] : [[section, fact] as const])),
);

function countSections(runs: readonly Analysed[]): SectionCounts[] {
	const counts = new Map<string, SectionCounts>();
	const entry = (section: string): SectionCounts => {
		let found = counts.get(section);
		if (found === undefined) {
			found = { section, runs: 0, changed_within_run: 0, pairs: 0, changed_between_runs: 0, split_on: SECTION_FACT.get(section) ?? null };
			counts.set(section, found);
		}
		return found;
	};
	for (const { before, after } of runs) {
		for (const section of new Set([...Object.keys(before), ...Object.keys(after)])) {
			const counted = entry(section);
			counted.runs++;
			if (before[section] !== after[section]) counted.changed_within_run++;
		}
	}
	for (let i = 1; i < runs.length; i++) {
		const from = (runs[i - 1] as Analysed).before;
		const to = (runs[i] as Analysed).before;
		for (const section of new Set([...Object.keys(from), ...Object.keys(to)])) {
			const counted = entry(section);
			counted.pairs++;
			if (from[section] !== to[section]) counted.changed_between_runs++;
		}
	}
	return [...counts.values()].sort((a, b) => compareText(a.section, b.section));
}

function differed(from: Analysed, to: Analysed, blobs: BlobMap): Differed {
	const facts = SPLIT_FACTS.map(({ fact }) => fact).filter((fact) => from.facts[fact] !== to.facts[fact]);
	const names = [...new Set([...Object.keys(from.before), ...Object.keys(to.before)])].sort(compareText);
	const sections = names
		.filter((name) => from.before[name] !== to.before[name])
		.map((name) => ({ section: name, keys: changedKeys(name, from.before[name], to.before[name], blobs) }));
	return { from: from.run.id, to: to.run.id, facts, sections };
}

function deriveSeries(runs: Analysed[], blobs: BlobMap): SeriesDerivation {
	runs.sort((a, b) => compareText(a.run.started_at, b.run.started_at) || compareText(a.run.id, b.run.id));
	const first = runs[0] as Analysed;
	const letters = new Map<string, string>();
	const points: Point[] = runs.map((analysed) => {
		let letter = letters.get(analysed.factsText);
		if (letter === undefined) {
			letter = groupLetter(letters.size);
			letters.set(analysed.factsText, letter);
		}
		return analysed.point(letter);
	});
	const groups: Group[] = [...letters].map(([factsText, id]) => {
		const members = points.filter((point) => point.group === id);
		const facts = (runs.find((analysed) => analysed.factsText === factsText) as Analysed).facts;
		return { id, facts, runs: members.map((point) => point.run), percentiles: percentilesOf(members) };
	});
	const key = seriesKey(first.run);
	const cited: CitedRun[] = runs.map(({ run, file }) => ({ id: run.id, path: file.path, sha256: file.sha256 }));
	return {
		method: METHOD,
		series: {
			id: seriesId(key),
			benchmark: key.benchmark,
			params: key.params,
			build: key.build,
			instance_type: key.instance_type,
			availability_zone_id: key.availability_zone_id,
		},
		runs: cited,
		points,
		percentiles: percentilesOf(points),
		groups,
		differed: runs.slice(1).map((analysed, i) => differed(runs[i] as Analysed, analysed, blobs)),
		sections: countSections(runs),
	};
}

/**
 * How often each dump section changed, over every Run read: within a Run
 * (before against after), between consecutive Runs of one boot whatever their
 * Series, and between consecutive Runs of one Series.
 */
function sectionEvidence(runs: readonly Analysed[], series: readonly SeriesDerivation[]): SectionEvidence[] {
	const evidence = new Map<string, SectionEvidence>();
	const entry = (section: string): SectionEvidence => {
		let found = evidence.get(section);
		if (found === undefined) {
			found = {
				section,
				runs: 0,
				changed_within_run: 0,
				boot_pairs: 0,
				changed_within_boot: 0,
				series_pairs: 0,
				changed_between_runs: 0,
				split_on: SECTION_FACT.get(section) ?? null,
			};
			evidence.set(section, found);
		}
		return found;
	};
	const byBoot = new Map<string, Analysed[]>();
	for (const analysed of runs) {
		const list = byBoot.get(analysed.run.boot) ?? [];
		list.push(analysed);
		byBoot.set(analysed.run.boot, list);
	}
	for (const list of byBoot.values()) {
		list.sort((a, b) => compareText(a.run.started_at, b.run.started_at) || compareText(a.run.id, b.run.id));
		for (let i = 1; i < list.length; i++) {
			const from = (list[i - 1] as Analysed).before;
			const to = (list[i] as Analysed).before;
			for (const section of new Set([...Object.keys(from), ...Object.keys(to)])) {
				const counted = entry(section);
				counted.boot_pairs++;
				if (from[section] !== to[section]) counted.changed_within_boot++;
			}
		}
	}
	for (const { sections } of series) {
		for (const counts of sections) {
			const sum = entry(counts.section);
			sum.runs += counts.runs;
			sum.changed_within_run += counts.changed_within_run;
			sum.series_pairs += counts.pairs;
			sum.changed_between_runs += counts.changed_between_runs;
		}
	}
	return [...evidence.values()].sort((a, b) => compareText(a.section, b.section));
}

/** The order Series are listed in: benchmark, instance type, zone ID, params, build. */
function seriesOrder(a: SeriesDerivation, b: SeriesDerivation): number {
	const tuple = (d: SeriesDerivation): string[] => [
		d.series.benchmark,
		d.series.instance_type ?? "",
		d.series.availability_zone_id ?? "",
		canonicalJson(d.series.params),
		d.series.build,
	];
	const x = tuple(a);
	const y = tuple(b);
	for (let i = 0; i < x.length; i++) {
		const order = compareText(x[i] as string, y[i] as string);
		if (order !== 0) return order;
	}
	return 0;
}

/**
 * The Derivations of version 1 for these Run files, reading only the blobs
 * given (as gather() fetches them). Pure: the same files and blobs give the
 * same result, whatever order the files come in.
 */
export function derive(files: readonly RunFile[], blobs: BlobMap): DerivationsFile {
	const { runs, unreadable } = readRuns(files);
	const analysed = runs.map((read) => analyse(read, blobs));
	const bySeries = new Map<string, Analysed[]>();
	for (const one of analysed) {
		const list = bySeries.get(one.keyText) ?? [];
		list.push(one);
		bySeries.set(one.keyText, list);
	}
	const derivations = [...bySeries.values()].map((list) => deriveSeries(list, blobs)).sort(seriesOrder);
	return {
		schema: "ledgermath.derivations/1",
		method: METHOD,
		definitions: DEFINITIONS,
		split_on: SPLIT_FACTS,
		not_split_on: NOT_SPLIT_ON,
		runs_read: files.length,
		unreadable,
		sections: sectionEvidence(analysed, derivations),
		derivations,
	};
}

/** The file's bytes: JSON, two-space indented, with a final newline. */
export function serialize(file: DerivationsFile): string {
	return `${JSON.stringify(file, null, 2)}\n`;
}
