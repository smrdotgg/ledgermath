/**
 * The fields of a recorded boot that identify the machine or the account it ran
 * on, and the example values tests/samples holds in their place.
 * tests/samples/prepare.ts replaces them; tests/schemas.test.ts asserts that
 * every sample holds only these values. tests/samples/README.md lists them.
 *
 * Problems are reported by field and file, never with the value found, so a
 * failing check prints nothing it is meant to hide.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const EXAMPLE = {
	/** AWS's documented example account. */
	accountId: "123456789012",
	/** AWS's documented example instance. */
	instanceId: "i-0123456789abcdef0",
	/** AWS's documented example image. */
	imageId: "ami-0123456789abcdef0",
	/** An RFC 5737 documentation address. */
	privateIp: "192.0.2.10",
	pendingTime: "2026-01-01T00:00:00Z",
	/** The EC2-style name of privateIp. */
	hostname: "ip-192-0-2-10",
	/** AWS's example volume, as an EBS volume's NVMe serial. */
	ebsSerial: "vol0123456789abcdef0",
	/** AWS's example volume. */
	volumeId: "vol-0123456789abcdef0",
	/** Any other device serial. */
	deviceSerial: "AWS0123456789ABCDEF0",
	/** An RFC 7042 documentation MAC address. */
	mac: "00:00:5e:00:53:01",
	/** A partition or filesystem UUID on the kernel command line. */
	uuid: "01234567-89ab-cdef-0123-456789abcdef",
	/** A docker container ID in a mount's source. */
	containerId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
} as const;

/** Fields of the instance identity document that must be null; nothing here can stand in for them. */
const NULL_IDENTITY_FIELDS = ["billingProducts", "devpayProductCodes", "marketplaceProductCodes", "kernelId", "ramdiskId"];

const IMDS = "http://169.254.169.254/latest/";
const NVME_SERIAL = /^\/sys\/class\/nvme\/nvme\d+\/serial$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CONTAINER_ID = /\/var\/lib\/docker\/containers\/([0-9a-f]{64})\//g;

export interface Field {
	/** Where it is, such as "provider: identity document accountId". */
	name: string;
	value: string;
	example: string;
}

function serialExample(serial: string): string {
	return /^vol-?[0-9a-f]{17}$/.test(serial) ? EXAMPLE.ebsSerial : EXAMPLE.deviceSerial;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function commandOutput(section: Record<string, unknown>, prefix: string): string | undefined {
	for (const [key, value] of Object.entries(section)) {
		if (key.startsWith(prefix)) {
			const stdout = asRecord(value).stdout;
			return typeof stdout === "string" ? stdout : undefined;
		}
	}
	return undefined;
}

/** Every identifying field of one dump section, as run.py writes it. */
export function sectionFields(sectionName: string, section: Record<string, unknown>): Field[] {
	const fields: Field[] = [];
	const add = (name: string, value: unknown, example: string): void => {
		if (typeof value === "string" && value !== "") fields.push({ name: `${sectionName}: ${name}`, value, example });
	};

	if (sectionName === "provider") {
		add("meta-data/instance-id", section[`${IMDS}meta-data/instance-id`], EXAMPLE.instanceId);
		add("meta-data/ami-id", section[`${IMDS}meta-data/ami-id`], EXAMPLE.imageId);
		const document = section[`${IMDS}dynamic/instance-identity/document`];
		if (typeof document === "string") {
			const identity = asRecord(JSON.parse(document));
			add("identity document accountId", identity.accountId, EXAMPLE.accountId);
			add("identity document instanceId", identity.instanceId, EXAMPLE.instanceId);
			add("identity document imageId", identity.imageId, EXAMPLE.imageId);
			add("identity document privateIp", identity.privateIp, EXAMPLE.privateIp);
			add("identity document pendingTime", identity.pendingTime, EXAMPLE.pendingTime);
			for (const key of NULL_IDENTITY_FIELDS) {
				if (identity[key] !== null && identity[key] !== undefined) {
					fields.push({ name: `${sectionName}: identity document ${key}`, value: JSON.stringify(identity[key]), example: "null" });
				}
			}
		}
	}

	if (sectionName === "kernel") {
		const uname = commandOutput(section, "$ uname -a");
		add("uname -a nodename", uname?.split(/\s+/)[1], EXAMPLE.hostname);
		const cmdline = section["/proc/cmdline"];
		if (typeof cmdline === "string") {
			for (const match of cmdline.matchAll(UUID)) add("/proc/cmdline UUID", match[0], EXAMPLE.uuid);
		}
	}

	if (sectionName === "devices") {
		for (const [key, value] of Object.entries(section)) {
			if (NVME_SERIAL.test(key) && typeof value === "string") {
				add(key, value.trim(), serialExample(value.trim()));
			}
		}
		const lsblk = commandOutput(section, "$ lsblk ");
		if (lsblk) {
			const walk = (devices: unknown): void => {
				if (!Array.isArray(devices)) return;
				for (const device of devices.map(asRecord)) {
					if (typeof device.serial === "string") {
						add(`lsblk ${String(device.name)} serial`, device.serial.trim(), serialExample(device.serial.trim()));
					}
					if (device.wwn !== undefined && device.wwn !== null) {
						fields.push({ name: `${sectionName}: lsblk ${String(device.name)} wwn`, value: String(device.wwn), example: "null" });
					}
					walk(device.children);
				}
			};
			walk(asRecord(JSON.parse(lsblk)).blockdevices);
		}
		const findmnt = commandOutput(section, "$ findmnt");
		if (findmnt) {
			for (const match of findmnt.matchAll(CONTAINER_ID)) add("findmnt docker container ID", match[1], EXAMPLE.containerId);
		}
	}
	return fields;
}

/** The identifying fields of a Run or a boot summary itself. */
export function recordFields(record: Record<string, unknown>): Field[] {
	const provider = asRecord(record.provider);
	const fields: Field[] = [];
	if (typeof provider.instance_id === "string") {
		fields.push({ name: "provider.instance_id", value: provider.instance_id, example: EXAMPLE.instanceId });
	}
	if (typeof provider.image_id === "string") {
		fields.push({ name: "provider.image_id", value: provider.image_id, example: EXAMPLE.imageId });
	}
	return fields;
}

/**
 * Identifying values found by their shape anywhere in a text, whatever field
 * holds them: MAC addresses, private IPv4 addresses, and instance, image and
 * volume IDs.
 */
export function shapedValues(text: string): Field[] {
	const fields: Field[] = [];
	const scan = (name: string, pattern: RegExp, example: (value: string) => string): void => {
		for (const match of text.matchAll(pattern)) fields.push({ name, value: match[0], example: example(match[0]) });
	};
	scan("a MAC address", /(?<![0-9a-f:])[0-9a-f]{2}(?::[0-9a-f]{2}){5}(?![0-9a-f:])/gi, () => EXAMPLE.mac);
	scan(
		"a private IPv4 address",
		/(?<![0-9.])(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?![0-9.])/g,
		() => EXAMPLE.privateIp,
	);
	scan("an EC2-style host name", /(?<![a-z0-9])ip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}(?![0-9])/g, () => EXAMPLE.hostname);
	scan("an instance ID", /(?<![a-z0-9])i-[0-9a-f]{17}(?![0-9a-f])/g, () => EXAMPLE.instanceId);
	scan("an image ID", /(?<![a-z0-9])ami-[0-9a-f]{8,17}(?![0-9a-f])/g, () => EXAMPLE.imageId);
	scan("a volume ID", /(?<![a-z0-9])vol-?[0-9a-f]{17}(?![0-9a-f])/g, (value) =>
		value.startsWith("vol-") ? EXAMPLE.volumeId : EXAMPLE.ebsSerial,
	);
	return fields;
}

export interface SampleFiles {
	/** Run files and boot summaries, by path. */
	records: Map<string, Record<string, unknown>>;
	/** Every blob that is text, by path. */
	texts: Map<string, string>;
	/** Each dump section blob reachable from a Run, by path, with its section name. */
	sections: Map<string, string>;
}

function filesUnder(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

export function asText(bytes: Buffer): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function readSample(directory: string): SampleFiles {
	const records = new Map<string, Record<string, unknown>>();
	for (const path of [...filesUnder(join(directory, "runs")), ...filesUnder(join(directory, "boots"))]) {
		records.set(path, asRecord(JSON.parse(readFileSync(path, "utf8"))));
	}
	const texts = new Map<string, string>();
	for (const path of filesUnder(join(directory, "blobs"))) {
		const text = asText(readFileSync(path));
		if (text !== null) texts.set(path, text);
	}
	const sections = new Map<string, string>();
	for (const record of records.values()) {
		for (const moment of Object.values(asRecord(record.environment))) {
			if (typeof moment !== "string") continue;
			const index = texts.get(join(directory, "blobs", "sha256", moment.slice("sha256:".length)));
			if (index === undefined) continue;
			for (const [name, hash] of Object.entries(asRecord(asRecord(JSON.parse(index)).sections))) {
				if (typeof hash === "string") sections.set(join(directory, "blobs", "sha256", hash.slice("sha256:".length)), name);
			}
		}
	}
	return { records, texts, sections };
}

/** Every identifying field and shaped value in a sample directory, wherever it is. */
export function allFields(directory: string): Array<Field & { file: string }> {
	const sample = readSample(directory);
	const found: Array<Field & { file: string }> = [];
	const at = (file: string, fields: Field[]): void => {
		for (const field of fields) found.push({ ...field, file: relative(directory, file) });
	};
	for (const [path, record] of sample.records) {
		at(path, recordFields(record));
		at(path, shapedValues(JSON.stringify(record)));
	}
	for (const [path, text] of sample.texts) {
		const name = sample.sections.get(path);
		if (name !== undefined) at(path, sectionFields(name, JSON.parse(text) as Record<string, unknown>));
		at(path, shapedValues(text));
	}
	return found;
}

/** Each identifying field in a sample directory that does not hold its example value. */
export function identifyingProblems(directory: string): string[] {
	return allFields(directory)
		.filter((field) => field.value !== field.example)
		.map((field) => `${field.file}: ${field.name} does not hold its example value`);
}
