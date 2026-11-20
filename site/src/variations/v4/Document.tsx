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
				<title>LedgerMath · Machine Cards</title>
				<meta name="description" content="Five AWS machine types as trading cards. Every stat measured, four times a day. None rare. Nobody wins." />
			</head>
			<body>{props.children}</body>
		</html>
	);
}
