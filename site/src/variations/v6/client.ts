// Copy buttons beside each command, their label as text in the button. Without JavaScript there are none; the commands read the same and can be selected.
const LABEL = { copy: "copy", copied: "copied", failed: "select it" } as const;
for (const el of document.querySelectorAll<HTMLElement>("[data-copy]")) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	const show = (state: keyof typeof LABEL) => (button.textContent = LABEL[state]);
	show("copy");
	button.setAttribute("aria-label", `Copy: ${el.textContent ?? ""}`);
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(el.textContent ?? "");
			show("copied");
		} catch {
			show("failed");
		}
		setTimeout(() => show("copy"), 1600);
	});
	el.after(button);
}
// An opened median closes on a click elsewhere or on Escape (without JavaScript, on its own figure or by opening another).
const closeFigures = (except?: Element | null) => {
	for (const d of document.querySelectorAll<HTMLDetailsElement>("details.fig[open]")) if (d !== except) d.open = false;
};
document.addEventListener("click", (e) => closeFigures(e.target instanceof Element ? e.target.closest("details.fig") : null));
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") closeFigures();
});
// A link to a folded section (the agent prompt) opens it.
for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
	const target = document.getElementById(a.hash.slice(1));
	if (target instanceof HTMLDetailsElement) a.addEventListener("click", () => (target.open = true));
}
