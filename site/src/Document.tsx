import type { JSX } from "@solidjs/web";
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

// The whole <html> document around a page (design v9's). The build adds the site's stylesheet to <head>.
export default function Document(props: { title: string; description: string; children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="dark light" />
				<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
				<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
				<title>{props.title}</title>
				<meta name="description" content={props.description} />
				<link rel="preload" href={circle} as="font" type="font/woff2" crossorigin="anonymous" media={`not all and ${LIGHT}`} />
				<link rel="preload" href={square} as="font" type="font/woff2" crossorigin="anonymous" media={LIGHT} />
				<script innerHTML={HOLD_UNTIL_FONT} />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
