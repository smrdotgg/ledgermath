// Adds a copy button, an icon with an accessible name, to each command block; the command reads and selects the same without it.
const SVG = "http://www.w3.org/2000/svg";
function icon(paths: string[]) {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	for (const d of paths) {
		const path = document.createElementNS(SVG, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}
const COPY = ["M5.5 5.5h7v8h-7z", "M3.5 10.5v-8h7"];
const DONE = ["M3 8.5l3 3 7-7"];

for (const pre of document.querySelectorAll<HTMLPreElement>("pre[data-copy]")) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.setAttribute("aria-label", "Copy");
	button.title = "Copy";
	button.append(icon(COPY));
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(pre.dataset.copy ?? "");
			button.replaceChildren(icon(DONE));
			button.setAttribute("aria-label", "Copied");
		} catch {
			// Nothing copied: select the command, so it can be copied by hand.
			const range = document.createRange();
			range.selectNodeContents(pre.querySelector("code") ?? pre);
			getSelection()?.removeAllRanges();
			getSelection()?.addRange(range);
		}
		setTimeout(() => {
			button.replaceChildren(icon(COPY));
			button.setAttribute("aria-label", "Copy");
		}, 1600);
	});
	// Beside its block where there is a place for it, else in the block.
	(pre.parentElement?.querySelector(".copy-slot") ?? pre).append(button);
}
