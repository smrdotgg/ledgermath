// Copy buttons beside each command. The page reads the same without them.
for (const wrap of document.querySelectorAll<HTMLElement>("[data-copy-wrap]")) {
	const code = wrap.querySelector<HTMLElement>("[data-copy]");
	if (!code || !navigator.clipboard) continue;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.textContent = "Copy";
	button.setAttribute("aria-label", `Copy: ${code.textContent ?? ""}`);
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(code.textContent ?? "");
			button.textContent = "Copied";
		} catch {
			button.textContent = "Select it";
		}
		setTimeout(() => (button.textContent = "Copy"), 1600);
	});
	wrap.append(button);
}
