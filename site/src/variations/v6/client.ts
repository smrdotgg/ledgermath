// Copy buttons beside each command (their words come from the stylesheet, so the page's text is the same with or without them). Without JavaScript the commands read the same and can be selected.
for (const el of document.querySelectorAll<HTMLElement>("[data-copy]")) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.dataset.state = "copy";
	button.setAttribute("aria-label", `Copy: ${el.textContent ?? ""}`);
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(el.textContent ?? "");
			button.dataset.state = "copied";
		} catch {
			button.dataset.state = "failed";
		}
		setTimeout(() => (button.dataset.state = "copy"), 1600);
	});
	el.after(button);
}
// A link to a folded section (the agent prompt) opens it.
for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
	const target = document.getElementById(a.hash.slice(1));
	if (target instanceof HTMLDetailsElement) a.addEventListener("click", () => (target.open = true));
}
