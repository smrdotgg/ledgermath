import type { JSX } from "@solidjs/web";
import pixel from "./fonts/GeistPixel-Circle.woff2";

// As on smr.gg: the browser hides text until its font is ready (font-display: block), but the dot
// art and bars are not text and would show first. So while the font loads, hide the whole page and reveal
// it with one class change once the font is ready (or fails), so text and dots appear in the same
// frame. Without JavaScript the browser's own wait applies.
const HOLD_UNTIL_FONT = `(()=>{const f='1em "Geist Pixel Circle"';if(document.fonts.check(f))return;const r=document.documentElement;r.classList.add("font-loading");document.fonts.load(f).finally(()=>r.classList.remove("font-loading"))})()`;

// The whole <html> document around the page. The build adds the page's stylesheet to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="dark light" />
				<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
				<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
				<title>LedgerMath: independent cloud benchmarks</title>
				<meta name="description" content="Open-source benchmarks, run on real cloud machines every day. Every number links to the Runs behind it." />
				<link rel="preload" href={pixel} as="font" type="font/woff2" crossorigin="anonymous" />
				<script innerHTML={HOLD_UNTIL_FONT} />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
