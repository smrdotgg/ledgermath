// Copy buttons for the shell lines. The page reads the same without them.
const scope = document.querySelector<HTMLElement>("[data-copy-scope]");
const bar = scope?.querySelector<HTMLElement>(".term-bar");
if (scope && bar && navigator.clipboard) {
	const lines = [...scope.querySelectorAll<HTMLElement>("[data-copy]")].map((el) => el.textContent ?? "");
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy-btn";
	button.textContent = "Copy first line";
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(lines[0] ?? "");
			button.textContent = "Copied";
		} catch {
			button.textContent = "Copy failed";
		}
		setTimeout(() => (button.textContent = "Copy first line"), 1600);
	});
	bar.append(button);
}
