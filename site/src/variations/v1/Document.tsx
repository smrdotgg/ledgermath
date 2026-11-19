import type { JSX } from "@solidjs/web";
import serif from "./fonts/source-serif-4-latin-wght-normal.woff2";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts) to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<meta name="theme-color" content="#f4efe2" media="(prefers-color-scheme: light)" />
				<meta name="theme-color" content="#101417" media="(prefers-color-scheme: dark)" />
				<title>LedgerMath: a book of record for cloud servers</title>
				<meta
					name="description"
					content="14 benchmarks on 5 AWS machine types, run four times a day. Every Run kept with its evidence, each median printed to every digit, all of it a static JSON API for agents."
				/>
				<link rel="preload" href={serif} as="font" type="font/woff2" crossorigin="anonymous" />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
