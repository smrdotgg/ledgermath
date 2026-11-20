// A copy button, drawn as a mark, beside each address. The page reads the same without it.
const COPY = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>`;
const DONE = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>`;

for (const box of document.querySelectorAll<HTMLElement>("[data-copy]")) {
	const text = box.dataset.copy;
	if (!text || !navigator.clipboard) continue;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.innerHTML = COPY;
	button.setAttribute("aria-label", `Copy ${text}`);
	button.title = "Copy";
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.innerHTML = DONE;
			button.setAttribute("aria-label", "Copied");
		} catch {
			button.setAttribute("aria-label", "Select it to copy");
		}
		setTimeout(() => {
			button.innerHTML = COPY;
			button.setAttribute("aria-label", `Copy ${text}`);
		}, 1600);
	});
	box.append(button);
}
