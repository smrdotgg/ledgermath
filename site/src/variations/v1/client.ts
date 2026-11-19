// Copy buttons for the API's commands. The page reads the same without this: the buttons stay hidden.
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
	if (!navigator.clipboard) continue;
	button.hidden = false;
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(button.dataset.copy ?? "");
			button.textContent = "Copied";
		} catch {
			button.textContent = "Select it";
		}
		setTimeout(() => (button.textContent = "Copy"), 1600);
	});
}

// The accounts bar marks the account being read. Without this, the bar is plain links.
const tabs = new Map<string, HTMLAnchorElement>();
for (const a of document.querySelectorAll<HTMLAnchorElement>(".index-tabs a[data-sec]")) tabs.set(a.dataset.sec ?? "", a);
if (tabs.size > 0 && "IntersectionObserver" in window) {
	const seen = new Set<string>();
	const observer = new IntersectionObserver(
		(entries) => {
			for (const e of entries) e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id);
			const current = [...tabs.keys()].find((id) => seen.has(id));
			for (const [id, a] of tabs) {
				a.classList.toggle("on", id === current);
				if (id === current) a.setAttribute("aria-current", "location");
				else a.removeAttribute("aria-current");
			}
		},
		{ rootMargin: "-15% 0px -70% 0px" },
	);
	for (const id of tabs.keys()) {
		const section = document.getElementById(id);
		if (section) observer.observe(section);
	}
}
