// The desk's keys: F10 (and the COPY button) copies the command line; F2–F4, F6, F7 jump to their
// panes. F5 is left alone: the figures refresh four times a day, not when you press it. The page
// reads the same without this script.
const line = document.querySelector<HTMLInputElement>("#cmdline");
const cmd = document.querySelector<HTMLElement>("#cmd");

async function copy(button?: HTMLElement) {
	if (!line) return;
	try {
		await navigator.clipboard.writeText(line.value);
		if (button) {
			button.textContent = "COPIED";
			setTimeout(() => (button.textContent = "COPY"), 1600);
		}
	} catch {
		line.select();
	}
}

let button: HTMLButtonElement | undefined;
if (cmd && line && navigator.clipboard) {
	button = document.createElement("button");
	button.type = "button";
	button.className = "copy";
	button.textContent = "COPY";
	button.setAttribute("aria-label", `Copy: ${line.value}`);
	button.addEventListener("click", () => copy(button));
	cmd.append(button);
}

document.querySelector(".copy-key")?.addEventListener("click", (event) => {
	event.preventDefault();
	void copy(button);
});

const jumps: Record<string, string> = { F2: "monitor", F3: "mutex", F4: "ticks", F6: "issuers", F7: "news" };
document.addEventListener("keydown", (event) => {
	if (event.altKey || event.ctrlKey || event.metaKey) return;
	if (event.key === "F10") {
		event.preventDefault();
		void copy(button);
		return;
	}
	const target = jumps[event.key];
	if (target) {
		event.preventDefault();
		document.getElementById(target)?.scrollIntoView({ block: "start" });
	}
});
