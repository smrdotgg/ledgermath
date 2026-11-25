// A Worker for tests/no-network.test.ts: fetches the address it is sent, and posts back the body or the error.
declare const self: Worker;

self.onmessage = async (event: MessageEvent<string>) => {
	try {
		self.postMessage(await (await fetch(event.data)).text());
	} catch (error) {
		self.postMessage(error instanceof Error ? error.message : String(error));
	}
};
