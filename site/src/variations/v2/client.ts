// Adds a copy button to each command in SYNOPSIS. The page reads the same without it.
for (const item of document.querySelectorAll<HTMLElement>(".cmd")) {
	const text = item.querySelector(".cmd-text")?.textContent?.trim();
	if (!text || !navigator.clipboard) continue;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.textContent = "copy";
	button.setAttribute("aria-label", `Copy: ${text}`);
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "copied";
			button.dataset.done = "";
			setTimeout(() => {
				button.textContent = "copy";
				delete button.dataset.done;
			}, 1600);
		} catch {
			button.textContent = "select it";
		}
	});
	item.append(button);
}
