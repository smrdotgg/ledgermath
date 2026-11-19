import type { JSX } from "@solidjs/web";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts, if it has one) to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<title>LedgerMath</title>
				<meta name="description" content="Cloud server benchmarks, run four times a day, every Run recorded." />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
