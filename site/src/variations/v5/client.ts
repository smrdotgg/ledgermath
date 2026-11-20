// Design v5, "Ward monitors": a copy button beside the records desk's address. The page reads the same without it.
for (const box of document.querySelectorAll<HTMLElement>("[data-copy]")) {
	const text = box.dataset.copy;
	if (!text || !navigator.clipboard) continue;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.textContent = "Copy";
	button.setAttribute("aria-label", `Copy: ${text}`);
	button.addEventListener("click", () => {
		navigator.clipboard.writeText(text).then(
			() => {
				button.textContent = "Copied";
				setTimeout(() => (button.textContent = "Copy"), 1600);
			},
			() => (button.textContent = "Select it"),
		);
	});
	box.classList.add("has-copy");
	box.append(button);
}
