import { Hydration, NoHydration } from "solid-js";
import { HydrationScript, type JSX } from "@solidjs/web";
import circle from "./fonts/GeistPixel-Circle.woff2";
import square from "./fonts/GeistPixel-Square.woff2";
import "./site.css";

// The light scheme is set in Geist Pixel Square and the dark one in Geist Pixel Circle (--pixel
// in site.css). This is the stylesheet's own question, so the preloads and the script below
// choose the same font the stylesheet does.
const LIGHT = "(prefers-color-scheme: light)";

// As on smr.gg: the browser hides text until its font is ready (font-display: block), but the dot
// art and bars are not text and would show first. So while the font loads, hide the whole page and reveal
// it with one class change once the font is ready (or fails), so text and dots appear in the same
// frame. Without JavaScript the browser's own wait applies.
const HOLD_UNTIL_FONT = `(()=>{const f='1em "Geist Pixel '+(matchMedia("${LIGHT}").matches?"Square":"Circle")+'"';if(document.fonts.check(f))return;const r=document.documentElement;r.classList.add("font-loading");document.fonts.load(f).finally(()=>r.classList.remove("font-loading"))})()`;

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
