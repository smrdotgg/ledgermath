// A copy button beside the command: a mark, named for screen readers. The page reads the same without it.
const ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const ICON_DONE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

for (const wrap of document.querySelectorAll<HTMLElement>("[data-copy-wrap]")) {
	const code = wrap.querySelector<HTMLElement>("[data-copy]");
	if (!code || !navigator.clipboard) continue;
	const text = code.textContent ?? "";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.innerHTML = ICON_COPY;
	button.setAttribute("aria-label", `Copy ${text}`);
	button.title = "Copy";
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(code.dataset.copy || text);
			button.innerHTML = ICON_DONE;
			button.setAttribute("aria-label", "Copied");
		} catch {
			code.focus();
		}
		setTimeout(() => {
			button.innerHTML = ICON_COPY;
			button.setAttribute("aria-label", `Copy ${text}`);
		}, 1600);
	});
	wrap.append(button);
}
