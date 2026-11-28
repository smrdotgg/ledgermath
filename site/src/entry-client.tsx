// The browser's entry (scripts/build.ts writes it as the page's one <script type="module">, which
// runs once the HTML is parsed): Solid takes over the page the build rendered, without rendering
// it again (the body is the application's island; Document.tsx), and from then on Solid Router
// does the navigation (src/app.tsx).
//
// It takes over only once the reader has seen the page: after the browser reports the page's
// first contentful paint (painted() says what it waits for where the browser cannot report it).
// Hydration takes the main thread for its whole length (tens of milliseconds on a phone), so
// started any earlier it would put off the first frame the reader sees (ADR-0036).
// Until it has run, a link is an ordinary link. The marks "hydrate" and "hydrated" say when it
// started and ended (scripts/check-browser.ts and measure-navigation.ts read them); the second is
// set by the application once its first render has settled (src/app.tsx). On a documentation
// page that is after the page's body has loaded: the page's own chunk (its lazy() body, which the
// page's <head> has already asked for, modulepreload) is loaded first, and only then does
// hydrate() take the page over. If that chunk cannot be loaded (a deploy since the HTML was
// served replaced it, or the network is down), the application does not take the page over at
// all: the page stays the complete static page it is, every link an ordinary link (the mark
// "static" says so), rather than a page that looks whole and whose links the router holds; and
// "Copy page", which only the application can work, is never shown (site.css).
import { hydrate } from "@solidjs/web";
import { App, landingBodyLoaded } from "./app";

/**
 * Resolves once the body is shown: when the inline script in <head> (Document.tsx) has taken away
 * its class "font-loading" (the font of the reader's colour scheme is ready or has failed, the
 * stylesheet has failed, or its bound has passed), or at once if it never set it (a browser
 * without document.fonts).
 */
function shown(): Promise<void> {
	return new Promise((resolve) => {
		const root = document.documentElement;
		if (!root.classList.contains("font-loading")) return resolve();
		const observer = new MutationObserver(() => {
			if (root.classList.contains("font-loading")) return;
			observer.disconnect();
			resolve();
		});
		observer.observe(root, { attributes: true, attributeFilter: ["class"] });
	});
}

/**
 * Resolves once the page has had its first contentful paint. In a browser without Paint Timing,
 * once a frame has been painted with the page's text: the body is shown only once the font the
 * text waits for (font-display: block in site.css) is ready or will not come (shown()); then a
 * callback of the frame after the next (an animation frame asked for inside one) runs only once
 * the next has been painted.
 */
function painted(): Promise<void> {
	return new Promise((resolve) => {
		if (performance.getEntriesByName("first-contentful-paint").length > 0) return resolve();
		if (!PerformanceObserver.supportedEntryTypes?.includes("paint")) {
			return void shown().then(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		}
		const observer = new PerformanceObserver((list) => {
			if (list.getEntriesByName("first-contentful-paint").length === 0) return;
			observer.disconnect();
			resolve();
		});
		observer.observe({ type: "paint", buffered: true });
	});
}

painted()
	.then(landingBodyLoaded)
	.then((loaded) => {
		if (!loaded) {
			performance.mark("static");
			console.warn("This page's script could not be loaded: it stays as it is, and its links load each page whole.");
			return;
		}
		performance.mark("hydrate");
		hydrate(() => <App />, document.body);
	});
