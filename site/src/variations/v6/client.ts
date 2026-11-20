// Copy buttons beside each command: an icon (two sheets) that turns to a tick once copied, or says "select it" when the
// browser refuses. Without JavaScript there are none; the commands read the same and can be selected.
const SVG = (d: string) =>
	`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">${d}</svg>`;
const ICON = {
	copy: SVG('<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5"/><path d="M10.75 3.25v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/>'),
	copied: SVG('<path d="M3 8.5l3.25 3.25L13 4.75" stroke-linecap="round"/>'),
} as const;
for (const el of document.querySelectorAll<HTMLElement>("[data-copy]")) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.title = "Copy";
	const show = (state: "copy" | "copied" | "failed") => {
		if (state === "failed") button.textContent = "select it";
		else button.innerHTML = ICON[state];
	};
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
// An opened median or chart label closes on a click elsewhere or on Escape (without JavaScript, on itself or by opening another).
const closeFigures = (except?: Element | null) => {
	for (const d of document.querySelectorAll<HTMLDetailsElement>("details.fig[open], details.lbl[open]")) if (d !== except) d.open = false;
};
document.addEventListener("click", (e) => closeFigures(e.target instanceof Element ? e.target.closest("details.fig, details.lbl") : null));
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") closeFigures();
});
// A link to a folded section (the agent prompt) opens it.
for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
	const target = document.getElementById(a.hash.slice(1));
	if (target instanceof HTMLDetailsElement) a.addEventListener("click", () => (target.open = true));
}
