// Adds a "copy" button to each command block, and on a phone folds the passages marked
// data-fold-on-phone (Table S1, the equations, the notes): open, and the page complete, without this script.
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

if (window.matchMedia("(max-width: 640px)").matches) {
	for (const details of document.querySelectorAll<HTMLDetailsElement>("details[data-fold-on-phone]")) details.open = false;
}
