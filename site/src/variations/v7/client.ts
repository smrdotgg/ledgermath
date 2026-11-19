// Copy buttons for the shell commands and the prompt, and, on a phone, the answer's two
// audit trails folded so the numbers come sooner. The page reads the same without any of it.
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

if (window.matchMedia("(max-width: 600px)").matches) {
	for (const fold of document.querySelectorAll<HTMLDetailsElement>("details.fold")) fold.open = false;
}
