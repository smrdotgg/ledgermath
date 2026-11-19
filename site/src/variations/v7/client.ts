// Copy buttons for the shell commands and the prompt. The page reads the same without them.
for (const block of document.querySelectorAll<HTMLElement>("[data-copy-block]")) {
	if (!navigator.clipboard) break;
	const source = block.querySelector<HTMLElement>("[data-copy]") ?? block;
	const text = (source.textContent ?? "").replace(/\s+/g, " ").trim();
	const label = "Copy";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy-btn";
	button.textContent = label;
	button.setAttribute("aria-label", `Copy ${block.dataset.copyBlock ?? "this"}`);
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "Copied";
		} catch {
			button.textContent = "Copy failed";
		}
		setTimeout(() => (button.textContent = label), 1600);
	});
	block.append(button);
}

// The answer's sources start folded; a citation opens them.
const sources = document.querySelector<HTMLDetailsElement>("details.sources");
if (sources) for (const cite of document.querySelectorAll<HTMLAnchorElement>("a.cite")) cite.addEventListener("click", () => (sources.open = true));
