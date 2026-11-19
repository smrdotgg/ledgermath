// Copy buttons for the curl lines. The page reads the same without them.
for (const box of document.querySelectorAll<HTMLElement>("[data-copy]")) {
	const text = box.dataset.copy;
	if (!text || !navigator.clipboard) continue;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.textContent = "Copy";
	button.setAttribute("aria-label", `Copy: ${text}`);
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "Copied";
		} catch {
			button.textContent = "Select it";
		}
		setTimeout(() => (button.textContent = "Copy"), 1600);
	});
	box.append(button);
}
