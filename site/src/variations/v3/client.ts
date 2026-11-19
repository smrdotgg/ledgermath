// Adds a "copy" button to each command block; the command reads and selects the same without it.
for (const pre of document.querySelectorAll<HTMLPreElement>("pre[data-copy]")) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.textContent = "copy";
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(pre.dataset.copy ?? "");
			button.textContent = "copied";
		} catch {
			button.textContent = "select to copy";
		}
		setTimeout(() => (button.textContent = "copy"), 1600);
	});
	pre.append(button);
}
