/**
 * Method version 1: Runs in, Derivations out.
 *
 *     const gathered = await gather(files, fetchBlob);   // the only I/O: blobs by hash
 *     const derivations = derive(files, gathered);       // pure
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
 * Memory: gather() keeps the dump blobs, which are small and mostly shared,
 * but no stdout. Each Run's stdout is read as it arrives, reduced to what the
 * Derivations need of it (summarizeStream, facts.ts), and let go, so nothing
 * proportional to the total size of the streams stays in memory. That
 * summary is the stream's reduced record (record.ts): given a store of
 * records (methods/records.ts), a stream already summarised is not fetched
 * again, and the Derivations are the same bytes either way.
 *
 * Once Derivations of this version are published, a change to what it
 * outputs is version 2, in methods/v2/, beside this one.
 */

import { basename } from "node:path";

import { type RecordStore, type ReduceCounts, reduceStreams, type StreamReducer } from "../records";
import { canonicalJson, compareText, type FetchBlob, parseDumpIndex, type Run, type RunFile, schemaErrors, schemaValidators } from "../run";
import {
	type BlobMap,
	changedKeys,
	type Facts,
	failureText,
	LEFT_OUT,
	NOT_SPLIT_ON,
	outcome,
	SPLIT_FACTS,
	type StreamSummary,
	seriesId,
	seriesKey,
	seriesKeyText,
	splitFacts,
	UNREAD_SECTIONS,
} from "./facts";
import { median, percentile } from "./numbers";
import { SERIES_RECORD } from "./record";
import type {
	CitedRun,
	DerivationsFile,
	Differed,
	Group,
	MethodName,
	SectionEffect,
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
		"A Run counts when its binary exited 0, every stdout line is an event that matches the events schema (which " +
		"the data API serves at v1/schemas/events.schema.json), and the stream obeys every one of these order rules: " +
		"started first and once (and without quick: true, which marks a developer's trial stream); finished last and " +
		"once; samples numbered from 0 in order, each starting only when none is open and at a t no earlier than the " +
		"previous sample's sample_ended; every sample_ended closing the open sample, of the same number, at a t no " +
		"earlier than its start, and every sample closed; each observed key once; exactly one verified; and as many " +
		"counted samples as the Run asked for. Any other Run is failed: shown, with its reasons (the first 10, each cut " +
		"to its first 500 characters, then how many more there are), and in no percentile.",
	groups:
		"Within a Series, the Runs whose split facts are all equal make one group. Groups are lettered in the order " +
		"each first appears, and may interleave in time. A dump section is compared whole, apart from the per-boot " +
		"values listed as left out; a fact read from such a section is canonical-json-sha256:<hex>, the sha256 of " +
		"what remains as JSON with keys sorted and no whitespace (lscpu's output is re-written that way too).",
	differed:
		"For each pair of consecutive Runs in a Series, every split fact and every dump section of the before-dump " +
		"whose hash changed, split on or not, with the top-level keys that changed for the sections that are read. " +
		"Each changed section is marked: it splits, its change lies only in what is left out, or it is not split on.",
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

/** What derive() reads: the dump blobs by hash, and each stdout blob's summary by its hash. */
export interface Gathered {
	blobs: BlobMap;
	streams: ReadonlyMap<string, StreamSummary>;
	/** How many streams were fetched, and how many summaries were read back from kept records. */
	counts: ReduceCounts;
}

export interface GatherOptions {
	/** Where each stream's summary is kept between runs (methods/records.ts), keyed by SERIES_RECORD_KEY. */
	records?: RecordStore | null;
	/** Fetches stdout blobs, when they come from elsewhere than the dumps (a source that keeps nothing). */
	fetchStream?: FetchBlob;
	concurrency?: number;
}

/**
 * Fetches every blob version 1 reads: each Run's before and after dump
 * indexes and the sections of each before-dump except UNREAD_SECTIONS, which
 * it keeps, and each Run's stdout (its events), which it reads, summarises
 * and lets go: at most `concurrency` streams are in memory at once. A stream
 * whose summary is kept in `records` is not fetched; one that is fetched has
 * its summary kept there. Throws if a Run names a blob that cannot be fetched.
 */
export async function gather(files: readonly RunFile[], fetchBlob: FetchBlob, options: GatherOptions = {}): Promise<Gathered> {
	const concurrency = options.concurrency ?? 16;
	const { runs } = readRuns(files);
	const blobs = new Map<string, Uint8Array>();
	const streams = new Map<string, StreamSummary>();
	const fetchAll = async (hashes: Iterable<string>, keep: (hash: string, bytes: Uint8Array) => void, held: ReadonlyMap<string, unknown>): Promise<void> => {
		const wanted = [...new Set(hashes)].filter((hash) => !held.has(hash)).sort(compareText);
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < wanted.length) {
				const hash = wanted[next++] as string;
				const bytes = await fetchBlob(hash);
				if (bytes === null) throw new Error(`blob ${hash} cannot be fetched`);
				keep(hash, bytes);
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
	};
	const keepBlob = (hash: string, bytes: Uint8Array): void => {
		blobs.set(hash, bytes);
	};

	await fetchAll(runs.flatMap(({ run }) => [run.environment.before, run.environment.after]), keepBlob, blobs);
	const sections: string[] = [];
	for (const { run } of runs) {
		const index = parseDumpIndex(run.environment.before, blobs.get(run.environment.before) as Uint8Array);
		for (const [name, hash] of Object.entries(index.sections)) if (!UNREAD_SECTIONS.has(name)) sections.push(hash);
	}
	await fetchAll(sections, keepBlob, blobs);
	const counts: ReduceCounts = { fetched: 0, kept: 0 };
	const [summaries] = await reduceStreams(
		runs.map(({ run }) => run.stdout),
		[SERIES_RECORD as StreamReducer<unknown>],
		options.fetchStream ?? fetchBlob,
		options.records ?? null,
		concurrency,
		counts,
	);
	return { blobs, streams: summaries as Map<string, StreamSummary>, counts };
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

function analyse({ file, run }: ReadRun, { blobs, streams }: Gathered): Analysed {
	const before = dumpSections(run.environment.before, blobs);
	const after = dumpSections(run.environment.after, blobs);
	const facts = splitFacts(run, before, blobs);
	const stream = streams.get(run.stdout);
	if (stream === undefined) throw new Error(`stdout ${run.stdout} of run ${run.id} was not gathered`);
	const { failures, samples } = outcome(run, stream);
	const counted = failures.length === 0;
	const time = counted ? median(samples.map((sample) => sample.ns_per_repetition)) : null;
	const bytes = counted ? stream.bytesPerRepetition : null;
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
			failure: counted ? null : failureText(failures),
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
		.map((name) => {
			const fact = SECTION_FACT.get(name);
			const effect: SectionEffect =
				fact === undefined ? "not split on" : from.facts[fact] !== to.facts[fact] ? "splits" : "left out";
			return { section: name, effect, keys: changedKeys(name, from.before[name], to.before[name], blobs) };
		});
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
 * The Derivations of version 1 for these Run files, reading only what
 * gather() gathered for them. Pure: the same files and blobs give the same
 * result, whatever order the files come in.
 */
export function derive(files: readonly RunFile[], gathered: Gathered): DerivationsFile {
	const { blobs } = gathered;
	const { runs, unreadable } = readRuns(files);
	const analysed = runs.map((read) => analyse(read, gathered));
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
		left_out: LEFT_OUT,
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
