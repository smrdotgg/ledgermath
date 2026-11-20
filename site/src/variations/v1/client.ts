// The copy button for the API's command. The page reads the same without this: the button stays hidden.
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
	if (!navigator.clipboard) continue;
	button.hidden = false;
	const label = button.getAttribute("aria-label") ?? "";
	button.addEventListener("click", async () => {
		let done = "Copied";
		try {
			await navigator.clipboard.writeText(button.dataset.copy ?? "");
			button.dataset.state = "done";
		} catch {
			done = "Select it to copy";
			button.dataset.state = "failed";
		}
		button.setAttribute("aria-label", done);
		button.title = done;
		setTimeout(() => {
			delete button.dataset.state;
			button.setAttribute("aria-label", label);
			button.title = label;
		}, 1600);
	});
}
