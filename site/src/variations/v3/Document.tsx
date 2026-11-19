import type { JSX } from "@solidjs/web";

// The whole <html> document around the page. The build adds the page's stylesheet (and its
// client.ts) to <head>.
export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<title>LedgerMath: AWS benchmarks, every Run kept</title>
				<meta
					name="description"
					content="A data report on AWS server benchmarks: 14 benchmarks on 5 machine types in us-east-2, run four times a day, every Run kept with its evidence, published as a JSON data API for agents."
				/>
			</head>
			<body>{props.children}</body>
		</html>
	);
}
