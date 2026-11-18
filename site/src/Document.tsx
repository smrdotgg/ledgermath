import { HydrationScript } from "@solidjs/web";
import type { JSX } from "@solidjs/web";

export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<title>LedgerMath</title>
				<meta name="description" content="Cloud server benchmarks, run every day, every Run recorded." />
				<HydrationScript />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
