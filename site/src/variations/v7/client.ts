// A copy button beside the way in: an icon, its name in its label. The page reads the same without it.
const COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>';
const DONE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>';

for (const block of document.querySelectorAll<HTMLElement>("[data-copy-block]")) {
	if (!navigator.clipboard) break;
	const source = block.querySelector<HTMLElement>("[data-copy]") ?? block;
	const text = source.dataset.copy || (source.textContent ?? "").replace(/\s+/g, " ").trim();
	const name = `Copy ${block.dataset.copyBlock ?? "this"}`;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy-btn";
	button.innerHTML = COPY;
	button.title = name;
	button.setAttribute("aria-label", name);
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.innerHTML = DONE;
			button.setAttribute("aria-label", "Copied");
		} catch {
			button.setAttribute("aria-label", "Copy failed");
		}
		setTimeout(() => {
			button.innerHTML = COPY;
			button.setAttribute("aria-label", name);
		}, 1600);
	});
	block.append(button);
}
