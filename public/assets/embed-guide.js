const feedback = document.querySelector("[data-embed-feedback]");
for (const example of document.querySelectorAll(".embed-example")) {
  const code = example.querySelector("[data-embed-code]");
  code.textContent = code.textContent.replaceAll("https://status.example.com", location.origin);
  if (!navigator.clipboard?.writeText) continue;
  const button = example.querySelector("[data-embed-copy]");
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      feedback.textContent = "Embed code copied.";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      feedback.textContent = "Code selected for copying.";
    }
  });
}
