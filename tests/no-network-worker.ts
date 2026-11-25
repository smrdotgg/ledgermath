// A Worker for tests/no-network.test.ts: fetches the address it is sent, and posts back the body or the error.
declare const self: Worker;

self.onmessage = async (event: MessageEvent<string>) => {
	// Asked "order": whether the guard ran before the Worker's own preload (tests/no-network-order.ts).
	if (event.data === "order") return self.postMessage(String((globalThis as Record<string, unknown>).guardRanFirst));
	try {
		self.postMessage(await (await fetch(event.data)).text());
	} catch (error) {
		self.postMessage(error instanceof Error ? error.message : String(error));
	}
};
