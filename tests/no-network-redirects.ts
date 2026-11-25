/**
 * A fetch that follows redirects itself, so tests/no-network.ts can check each
 * destination before it is asked, and otherwise does what Bun's own fetch does
 * (Bun 1.4; the Fetch standard's "HTTP-redirect fetch" where Bun agrees with it).
 * tests/no-network.test.ts holds it to Bun's fetch, case by case.
 *
 * - Only 301, 302, 303, 307 and 308 with a non-empty Location are followed;
 *   any other answer, or one with redirect "manual" or "error", is Bun's own.
 * - 303 (but for HEAD), and 301 or 302 answering a POST, become a GET with no
 *   body and without the headers that describe one; that carries into later hops.
 * - Across origins, Authorization, Cookie and Proxy-Authorization are dropped.
 * - Up to 126 redirects are followed, as Bun does (the standard says 20); the
 *   127th fails with Bun's TooManyRedirects. A Location that is not a URL, or
 *   not http(s), fails with Bun's errors.
 * - The body is sent again, the same bytes, when the method is kept: a string,
 *   bytes, a Blob, URLSearchParams or FormData, given in init or inside the
 *   Request (whose body is taken, before the first send, from a clone).
 * - A body that is a stream: a 303 is followed, as Bun follows it for every
 *   stream. A 301, 302, 307 or 308 is refused, saying to give redirect
 *   "manual" or another body: Bun follows those for a Blob's stream and
 *   refuses them for most others, and from outside the two look alike.
 * - The signal, from init or the Request, goes with every hop.
 * - The response, and every clone of it, says it was redirected, and gives
 *   the last address.
 */

/** Bun's limit: the 127th redirect of one fetch fails. */
export const MOST_REDIRECTS = 126;

const BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type", "content-length"];
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const STANDARD_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"];

type Body = NonNullable<RequestInit["body"]>;

const bunError =(code: string, message: string): TypeError => Object.assign(new TypeError(message), { code });

/** How a Request holds its body, as Bun shows it: a Blob can be sent again, a stream cannot. */
function requestBody(request: Request): "none" | "blob" | "stream" {
	const shown = Bun.inspect(request);
	if (/\n {2}Blob \(/.test(shown)) return "blob";
	if (/\n {2}ReadableStream \{/.test(shown)) return "stream";
	return "none";
}

function withRedirect(response: Response, url: string): Response {
	const clone = response.clone.bind(response) as () => Response;
	Object.defineProperties(response, {
		url: { value: url },
		redirected: { value: true },
		clone: { value: () => withRedirect(clone(), url) },
	});
	return response;
}

/**
 * `refuses` gives the guard's refusal for an address, or null. The first
 * address is checked by the caller.
 */
export function followingFetch(realFetch: typeof fetch, refuses: (address: string) => Error | null) {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const asRequest = input instanceof Request ? input : undefined;
		const mode = init?.redirect ?? asRequest?.redirect ?? "follow";
		if (mode !== "follow") return realFetch(input, init);

		const given = (init?.method ?? asRequest?.method ?? "GET").toString();
		let method = STANDARD_METHODS.includes(given.toUpperCase()) ? given.toUpperCase() : given;
		const headers = new Headers(init?.headers ?? asRequest?.headers);
		const signal = init?.signal ?? asRequest?.signal;
		let first: RequestInit = { ...init, redirect: "manual" };

		// The body, in a form that can be sent again, made before the first send.
		let again: Body | null | "stream" = null;
		if (init?.body !== undefined && init.body !== null) {
			if (init.body instanceof ReadableStream) again = "stream";
			else if (init.body instanceof FormData) {
				// Encoded once, as a Blob whose type carries the boundary, so every hop sends the same bytes, as Bun does.
				again = await new Response(init.body).blob();
				first = { ...first, body: again };
			} else again = init.body;
		} else if (asRequest !== undefined && init?.body === undefined && !asRequest.bodyUsed) {
			const kind = requestBody(asRequest);
			if (kind === "stream") again = "stream";
			else if (kind === "blob") again = await asRequest.clone().arrayBuffer();
		}

		let address = asRequest?.url ?? String(input);
		let response = await realFetch(input, first);
		let followed = 0;
		for (;;) {
			const location = response.headers.get("location");
			if (![301, 302, 303, 307, 308].includes(response.status) || location === null || location === "") break;
			let to: URL;
			try {
				to = new URL(location, address);
			} catch {
				throw bunError("RedirectURLInvalid", "RedirectURLInvalid: Redirect URL in Location header is invalid.");
			}
			if (to.protocol !== "http:" && to.protocol !== "https:") {
				throw bunError("UnsupportedRedirectProtocol", `UnsupportedRedirectProtocol fetching "${address}". For more information, pass \`verbose: true\` in the second argument to fetch()`);
			}
			if (followed === MOST_REDIRECTS) {
				throw bunError("TooManyRedirects", "TooManyRedirects: The response redirected too many times. For more information, pass `verbose: true` in the second argument to fetch()");
			}
			const refused = refuses(to.href);
			if (refused !== null) throw refused;
			const status = response.status;
			response.body?.cancel().catch(() => undefined);
			// Bun follows a 303 for any stream, which is not sent again; for the others it follows a Blob's stream and refuses most others.
			if (again === "stream" && status !== 303) {
				throw new Error(
					`A test's fetch has a body that is a stream and was answered with a ${status} redirect from ${address} to ${to.href}, which the test guard (tests/no-network.ts) cannot follow as Bun would (Bun follows it for a Blob's stream, and refuses it for most others): give the fetch redirect: "manual", or a body that can be sent again (a string, bytes or a Blob).`,
				);
			}

			let body: Body | undefined;
			if ((status === 303 && method !== "GET" && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) {
				method = "GET";
				again = null;
				for (const name of BODY_HEADERS) headers.delete(name);
			} else if (again !== null) body = again;
			if (new URL(address).origin !== to.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);

			address = to.href;
			followed++;
			response = await realFetch(address, { ...init, method, headers, body, signal, redirect: "manual" });
		}
		return followed === 0 ? response : withRedirect(response, address);
	};
}
