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

// A figure's details: one open at a time, closed by Escape or a click elsewhere. Without this
// script each one still opens and closes on its own.
const cells = [...document.querySelectorAll<HTMLDetailsElement>("details.cell")];
for (const cell of cells) {
	cell.addEventListener("toggle", () => {
		if (cell.open) for (const other of cells) if (other !== cell && other.open) other.open = false;
	});
}
document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	const open = cells.find((c) => c.open);
	if (!open) return;
	open.open = false;
	open.querySelector("summary")?.focus();
});
document.addEventListener("click", (event) => {
	const target = event.target as Node;
	for (const cell of cells) if (cell.open && !cell.contains(target)) cell.open = false;
});
