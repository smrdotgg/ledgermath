// Two touches the page reads the same without: a copy button for the API address, and the
// proof chart typed out character by character, which the font turns into bars at the closing brace.

for (const box of document.querySelectorAll<HTMLElement>("[data-copy]")) {
	const text = box.dataset.copy;
	if (!text || !navigator.clipboard) continue;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.textContent = "Copy";
	button.setAttribute("aria-label", `Copy ${text}`);
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

const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!still) {
	for (const el of document.querySelectorAll<HTMLElement>("[data-type-in]")) {
		const full = el.textContent ?? "";
		let n = 0;
		el.textContent = "";
		const tick = () => {
			n += 1;
			el.textContent = full.slice(0, n);
			if (n < full.length) setTimeout(tick, n < 3 ? 260 : 90);
		};
		setTimeout(tick, 700);
	}
}
