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
