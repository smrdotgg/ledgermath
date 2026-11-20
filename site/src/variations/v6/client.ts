// A [copy] button beside each address marked data-copy, as a receipt would print it. Without
// JavaScript there are none; the addresses read the same and can be selected.
const LABEL = { copy: "[copy]", copied: "[copied]", failed: "[select it]" } as const;
for (const el of document.querySelectorAll<HTMLElement>("[data-copy]")) {
	const text = el.dataset.copy || el.textContent || "";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	const show = (state: keyof typeof LABEL) => (button.textContent = LABEL[state]);
	show("copy");
	button.setAttribute("aria-label", `Copy ${text}`);
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text);
			show("copied");
		} catch {
			show("failed");
		}
		setTimeout(() => show("copy"), 1600);
	});
	if (el.tagName === "SPAN" && !el.textContent) el.replaceWith(button);
	else el.after(button);
}
