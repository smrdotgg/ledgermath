// Lines the picker page (Page.tsx) always shows. On this branch `bun run check`
// (scripts/check-output.ts) fails unless the built index.html holds each of them in its body,
// outside any script, which shows the picker was prerendered. Change them with the page.
export const PICKER_TEXT = [
	"LedgerMath home page: nine variations",
	"An exploration on the branch home-variations, not for merge: main deploys to the public site.",
];
