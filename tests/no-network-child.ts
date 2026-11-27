// A process for tests/no-network.test.ts to start: fetches the address it is given, prints the status, and on an error prints it to stderr and exits 2.
const address = process.argv[2];
if (address === undefined) {
	console.error("usage: bun tests/no-network-child.ts ADDRESS");
	process.exit(2);
}
try {
	const response = await fetch(address);
	console.log(response.status);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}
