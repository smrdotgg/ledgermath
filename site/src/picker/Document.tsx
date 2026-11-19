import type { JSX } from "@solidjs/web";

export default function Document(props: { children?: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<meta name="robots" content="noindex" />
				<title>LedgerMath home page: variations</title>
			</head>
			<body>{props.children}</body>
		</html>
	);
}
