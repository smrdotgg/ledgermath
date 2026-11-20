// Design v5: a copy mark on every command. The page reads the same without it.
// The mark is drawn, not written: its name is its aria-label, so it adds no word to the page.
const NS = "http://www.w3.org/2000/svg";

function icon(paths: string[]): SVGSVGElement {
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	for (const d of paths) {
		const path = document.createElementNS(NS, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

const COPY = ["M5.5 5.5h8v8h-8z", "M10.5 5.5v-3h-8v8h3"];
const DONE = ["M3 8.5l3.2 3.2L13 4.8"];

for (const box of document.querySelectorAll<HTMLElement>("[data-copy]")) {
	const text = box.dataset.copy;
	if (!text || !navigator.clipboard) continue;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.setAttribute("aria-label", `Copy: ${text}`);
	button.append(icon(COPY));
	button.addEventListener("click", () => {
		navigator.clipboard.writeText(text).then(
			() => {
				button.replaceChildren(icon(DONE));
				button.setAttribute("aria-label", "Copied");
				setTimeout(() => {
					button.replaceChildren(icon(COPY));
					button.setAttribute("aria-label", `Copy: ${text}`);
				}, 1600);
			},
			() => button.setAttribute("aria-label", "Copy failed: select the command"),
		);
	});
	box.classList.add("has-copy");
	box.append(button);
}
