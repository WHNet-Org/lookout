for (const example of document.querySelectorAll(".embed-example")) {
  const code = example.querySelector("[data-embed-code]");
  const preview = example.querySelector("lookout-status");
  const appearance = example.querySelector(".embed-appearance");
  const button = example.querySelector("[data-embed-copy]");
  const feedback = example.querySelector("[data-embed-feedback]");
  const source = code.textContent.replace(
    /^( *<(?:script type="module" src|a href)=")https:\/\/status\.example\.com(?=\/)/gmu,
    (_match, prefix) => prefix + location.origin,
  );
  let reset;

  function updateAppearance() {
    const variant = appearance.querySelector(":checked").value;
    preview?.setAttribute("variant", variant);
    code.textContent = source.replace(/^(<lookout-status[^\n]*? variant=")(?:badge|card)(?=")/mu,
      (_match, prefix) => prefix + variant);
    clearTimeout(reset);
    feedback.textContent = "";
  }

  updateAppearance();
  appearance.hidden = false;
  appearance.addEventListener("change", updateAppearance);
  button.parentElement.hidden = false;
  button.addEventListener("click", async () => {
    const html = code.textContent;
    let message = "Code copied.";
    try {
      await navigator.clipboard.writeText(html);
      if (code.textContent !== html) return;
    } catch {
      const selection = window.getSelection();
      selection?.selectAllChildren(code);
      message = selection ? "Code selected for copying." : "Select the HTML to copy it.";
    }
    clearTimeout(reset);
    feedback.textContent = message;
    reset = setTimeout(() => { feedback.textContent = ""; }, 2500);
  });
}
