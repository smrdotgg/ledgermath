// Adds a copy button to the command. A mark, not a word: its name is its aria-label. The page
// reads the same without it.
for (const item of document.querySelectorAll<HTMLElement>(".cmd")) {
	const text = item.querySelector(".cmd-text")?.textContent?.trim();
	if (!text || !navigator.clipboard) continue;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.textContent = "⧉";
	button.title = "Copy";
	button.setAttribute("aria-label", `Copy: ${text}`);
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "✓";
			button.dataset.done = "";
			setTimeout(() => {
				button.textContent = "⧉";
				delete button.dataset.done;
			}, 1600);
		} catch {
			button.title = "Select the command to copy it";
		}
	});
	item.append(button);
}
