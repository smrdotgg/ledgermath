// The browser's entry (scripts/build.ts writes it as the page's one <script type="module">, which
// runs once the HTML is parsed): Solid takes over the page the build rendered, without rendering
// it again (the body is the application's island; Document.tsx), and from then on Solid Router
// does the navigation (src/app.tsx).
//
// It takes over only once the reader has seen the page: after the browser reports the page's
// first contentful paint, which comes when the inline script in <head> stops holding the page
// for the font. Hydration takes the main thread for its whole length (tens of milliseconds on a
// phone), so started any earlier it would put off the first frame the reader sees (ADR-0036).
// Until it has run, a link is an ordinary link. The marks "hydrate" and "hydrated" say when it
// started and ended (scripts/check-browser.ts and measure-navigation.ts read them).
import { hydrate } from "@solidjs/web";
import { App } from "./app";

/** Resolves once the page has had its first contentful paint (in a browser without Paint Timing, once it has loaded and painted a frame). */
function painted(): Promise<void> {
	return new Promise((resolve) => {
		if (performance.getEntriesByName("first-contentful-paint").length > 0) return resolve();
		if (!PerformanceObserver.supportedEntryTypes?.includes("paint")) {
			const after = () => requestAnimationFrame(() => setTimeout(resolve));
			return document.readyState === "complete" ? after() : addEventListener("load", after, { once: true });
		}
		const observer = new PerformanceObserver((list) => {
			if (list.getEntriesByName("first-contentful-paint").length === 0) return;
			observer.disconnect();
			resolve();
		});
		observer.observe({ type: "paint", buffered: true });
	});
}

painted().then(() => {
	performance.mark("hydrate");
	hydrate(() => <App />, document.body);
	performance.mark("hydrated");
});
