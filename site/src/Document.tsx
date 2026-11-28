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
// The script runs before the stylesheet's <link> (the build writes it at the end of <head>), when
// no @font-face is known yet: asked then, document.fonts would say there is nothing to wait for.
// So it hides the page at once and, when the stylesheet has loaded (its load event, caught on the
// way down to the <link>, once), reads the face the stylesheet sets (--pixel on <html>) and waits
// for it; if the stylesheet then sets another face (the reader changed colour scheme meanwhile),
// it waits for that one. Until the stylesheet has loaded, nothing is drawn anyway: the browser
// waits for it, and the rule that hides the body is in it. If the stylesheet fails, the page is
// shown, in the browser's own fonts. The site's stylesheet is told from any other by its address,
// on the site's own origin: a browser extension may add a <link> of its own to the page, from
// another origin, which may load or fail first, and its load or failure changes nothing. The font coming from the browser's cache, as on a repeat visit, is
// ready a few milliseconds after the stylesheet, with no request added (the face is the
// stylesheet's own, which the preload has fetched).
//
// The page is shown HOLD_MS after the stylesheet has loaded if the face is not ready by then, and
// at once if it fails: then with the class font-fallback too, under which --pixel names the
// reader's own monospace font, so that the text is drawn in the frame that shows the page; when
// the face comes later, the class goes and the text changes to it. The browser's own block period
// is not relied on to end at the same moment: it starts when the browser first tries to use the
// face (CSS Fonts 4, "the font display timeline"), which is later than this. 3 s is the block
// period CSS Fonts 4 recommends for font-display: block.
const HOLD_MS = 3000;
const HOLD_UNTIL_FONT = `(()=>{const d=document,r=d.documentElement,c=r.classList;if(!d.fonts)return;let bound=0;const face=()=>"1em "+getComputedStyle(r).getPropertyValue("--pixel"),show=()=>{if(!c.contains("font-loading"))return;clearTimeout(bound);const f=face();if(!d.fonts.check(f)){c.add("font-fallback");d.fonts.load(f).then((l)=>{if(l.length>0&&l.every((x)=>x.status==="loaded"))c.remove("font-fallback")},()=>{})}c.remove("font-loading")},wait=()=>{const f=face();d.fonts.load(f).then(()=>(f===face()?show():wait()),show)},on=(e,go)=>d.addEventListener(e,(v)=>{if(v.target.rel==="stylesheet"&&v.target.href.startsWith(location.origin+"/"))go()},true);c.add("font-loading");on("load",()=>{if(!bound){bound=setTimeout(show,${HOLD_MS});wait()}});on("error",()=>c.remove("font-loading"))})()`;

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
