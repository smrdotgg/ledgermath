import type { JSX } from "@solidjs/web";
import datatype from "./fonts/Datatype.woff2";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts) to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<meta name="theme-color" content="#0b3d91" media="(prefers-color-scheme: light)" />
				<meta name="theme-color" content="#06142b" media="(prefers-color-scheme: dark)" />
				<title>LedgerMath Weather: us-east-2, measured</title>
				<meta
					name="description"
					content="The weather report for AWS us-east-2: five machine types, 14 benchmarks, booted fresh four times a day. Every figure measured, none forecast. Data as static JSON at api.ledgermath.com."
				/>
				<link rel="preload" href={datatype} as="font" type="font/woff2" crossorigin="anonymous" />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
