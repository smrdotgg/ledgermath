import { Hydration, NoHydration } from "solid-js";
import { HydrationScript, type JSX } from "@solidjs/web";
import circle from "./fonts/GeistPixel-Circle.woff2";
import square from "./fonts/GeistPixel-Square.woff2";
import "./site.css";

// The light scheme is set in Geist Pixel Square and the dark one in Geist Pixel Circle (--pixel
// in site.css). Each preload carries its scheme as its media, so a browser fetches only the one
// its scheme uses; the script below asks the stylesheet itself which face it uses.
const LIGHT = "(prefers-color-scheme: light)";

// As on smr.gg: the browser hides text until its font is ready (font-display: block), but the dot
// art and bars are not text and would show first. So the whole page is hidden (the class
// font-loading on <html>, site.css) from before the body is read, and shown with one class change,
// so that text and dots appear in the same frame. Without JavaScript nothing is hidden, and the
// browser's own wait applies.
//
// The guarantee is not the script's: the rule that hides the body (site.css) ends the hiding by
// itself, 3.5 s after it first applies, with an animation, whatever the script sees or misses.
//
// The script runs before the stylesheet's <link> (the build writes one for each CSS file at the
// end of <head>), when no @font-face is known yet: asked then, document.fonts would say there is
// nothing to wait for. So it hides the page at once and acts on the load and error events of any
// <link rel="stylesheet">, caught on the way down to it, without asking whose it is. Until the
// stylesheets have loaded nothing is drawn anyway: the browser waits for them.
// - At the first such event, the bound starts: the class goes HOLD_MS later whatever has happened.
//   Another stylesheet (a browser extension's) that loads or fails first only starts it a little
//   early. If the site's own stylesheet fails, the rule that hides the body never comes, the body
//   is visible, and the bound takes the class away for the application's sake.
// - At the first event after which --pixel (on <html>) names a face, the script waits for that
//   face. When the wait settles it reads --pixel again: if it names another face (the reader
//   changed colour scheme meanwhile), it waits for that one; if the face it waited for was not
//   known at all (a stylesheet named the family and a later one brings its @font-face), the next
//   stylesheet event starts the wait again; else, loaded or failed, the page is shown.
// Showing the page takes the class away first, so that nothing that throws afterwards can leave
// the page hidden. If the face is not ready then (it failed, or the bound came first), the class
// font-fallback is set in the same task, under which --pixel names the reader's own monospace font,
// so that the text is drawn in the frame that shows the page; when the face comes later, the class
// goes and the text changes to it. The script's bound comes before the animation's, so that in the
// arrangement the build writes the text is drawn when the page is shown.
//
// What is not handled: around a change of colour scheme during the hold the page may wait for the
// old face to settle, or the bound, before it is shown; a change once the page is shown in its face
// is left to the browser, which hides the text in the new face for its own block period, as on any
// change of scheme; while the class font-fallback is set the text stays in the fallback font, and
// the class goes when the face it was set for comes, so that after a change of scheme meanwhile
// the browser then hides the text in the new face for its own block period.
//
// The font coming from the browser's cache, as on a repeat visit, is ready a few milliseconds after
// the stylesheet, with no request added (the face is the stylesheet's own, which the preload has
// fetched). 3 s is the block period CSS Fonts 4 recommends for font-display: block. Its block
// period starts when the browser first tries to use the face ("the font display timeline"); the
// script does not rely on when that is.
const HOLD_MS = 3000;
const HOLD_UNTIL_FONT = `(()=>{const d=document,r=d.documentElement,c=r.classList;if(!d.fonts)return;let bound=0,waiting=0;const face=()=>getComputedStyle(r).getPropertyValue("--pixel"),show=()=>{if(!c.contains("font-loading"))return;c.remove("font-loading");clearTimeout(bound);const p=face();if(p&&!d.fonts.check("1em "+p)){c.add("font-fallback");d.fonts.load("1em "+p).then((l)=>{if(l.length>0&&l.every((x)=>x.status==="loaded"))c.remove("font-fallback")},()=>{})}},wait=()=>{const p=face(),settled=(l)=>(p!==face()?wait():l&&l.length===0?(waiting=0):show());d.fonts.load("1em "+p).then(settled,()=>settled())},go=(v)=>{if(!/stylesheet/i.test(v.target.rel))return;bound=bound||setTimeout(show,${HOLD_MS});if(!waiting&&face()){waiting=1;wait()}};c.add("font-loading");d.addEventListener("load",go,true);d.addEventListener("error",go,true)})()`;

// The site has no logo yet. A page that names no icon gets the browser's own placeholder in its
// tab (Chrome's globe) and a request for /favicon.ico; so each page names an icon that shows
// nothing: a 1x1 transparent PNG, carried in the page, which costs no request. The tab still keeps
// the icon's place: that is the browser's, and no page can take it away.
const NO_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";

// A page's feature flags (pages.text.ts): for each that the address names as a parameter, as in
// /?napkin, set data-<flag> on <html>, before the body is read, so that site.css shows the part
// the flag hides from the first frame on. Without JavaScript the part stays hidden. After a page
// change inside the application, src/app.tsx sets them by the same rule.
const setFlags = (flags: readonly string[]) =>
	flags.length === 0 ? "" : `for(const f of ${JSON.stringify(flags)})if(new URLSearchParams(location.search).has(f))document.documentElement.dataset[f]="";`;

// The whole <html> document around a page (design v9's). It is the build's, the same on every page
// but for the flags: Solid renders it once into the page's HTML and the browser never hydrates it
// (<NoHydration>). The body's content is the application (src/app.tsx), which the browser
// hydrates (<Hydration>, src/entry-client.tsx); it puts the page's <title> and description in
// <head> (useHead). The build adds the stylesheet and the application's script to <head>.
export default function Document(props: { flags?: readonly string[]; children?: JSX.Element }) {
	return (
		<NoHydration>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<meta name="color-scheme" content="dark light" />
					<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
					<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
					<link rel="icon" type="image/png" href={NO_ICON} />
					<link rel="preload" href={circle} as="font" type="font/woff2" crossorigin="anonymous" media={`not all and ${LIGHT}`} />
					<link rel="preload" href={square} as="font" type="font/woff2" crossorigin="anonymous" media={LIGHT} />
					<script innerHTML={setFlags(props.flags ?? []) + HOLD_UNTIL_FONT} />
					<HydrationScript />
				</head>
				<body>
					<Hydration>{props.children}</Hydration>
				</body>
			</html>
		</NoHydration>
	);
}
