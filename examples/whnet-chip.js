const labels = {
  operational: "All systems operational",
  degraded: "Services degraded",
  outage: "Service outage",
  unknown: "Status unknown",
  unavailable: "Status unavailable",
};

const chip = document.querySelector("[data-lookout-summary]");

if (chip) {
  const updateInterval = 60_000;
  let pending = false;
  let lastAttempt = Date.now() - updateInterval;
  let timer;

  function scheduleRefresh() {
    window.clearTimeout(timer);
    if (!document.hidden && !pending) {
      const dueIn = lastAttempt + updateInterval - Date.now();
      timer = window.setTimeout(refresh, Math.max(0, dueIn));
    }
  }

  async function refresh() {
    if (document.hidden || pending) return;
    pending = true;
    lastAttempt = Date.now();
    let state = "unavailable";
    try {
      const response = await fetch(chip.dataset.lookoutSummary, {
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const { status, online } = await response.json();
        if (Object.hasOwn(labels, status) && online === (status === "operational")) state = status;
      }
    } catch {
      // The link remains usable when the endpoint is unavailable.
    } finally {
      pending = false;
      scheduleRefresh();
    }
    chip.dataset.status = state;
    const label = chip.querySelector("[data-lookout-label]") ?? chip;
    if (label.textContent !== labels[state]) label.textContent = labels[state];
  }
  scheduleRefresh();
  document.addEventListener("visibilitychange", scheduleRefresh);
}
