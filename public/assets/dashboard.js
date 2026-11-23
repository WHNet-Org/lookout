const updateInterval = 60_000;
const snapshot = document.querySelector("[data-snapshot]");
const warning = document.querySelector("[data-refresh-warning]");
const announcement = document.querySelector("[data-announcement]");
const refreshLink = document.querySelector(".page-actions a");
let dashboard = document.querySelector("[data-dashboard]");
let lastAttempt = Date.now();
let timer;
let refreshing = false;

function scheduleRefresh() {
  window.clearTimeout(timer);
  if (!document.hidden && !refreshing) {
    const dueIn = lastAttempt + updateInterval - Date.now();
    timer = window.setTimeout(refreshDashboard, Math.max(0, dueIn));
  }
}

async function refreshDashboard() {
  if (document.hidden || refreshing) return;
  refreshing = true;
  lastAttempt = Date.now();
  try {
    const response = await fetch("/", {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("Status request failed");
    const source = await response.text();
    if (document.hidden) return;
    const nextPage = new DOMParser().parseFromString(source, "text/html");
    const nextDashboard = nextPage.querySelector("[data-dashboard]");
    const nextSnapshot = nextPage.querySelector("[data-snapshot]");
    if (!nextDashboard || !nextSnapshot || !nextDashboard.dataset.renderedAt) throw new Error("Status response is incomplete");

    const active = document.activeElement;
    const restoreFocus = dashboard.contains(active);
    const key = active?.getAttribute("data-focus-key");
    const scroll = { left: window.scrollX, top: window.scrollY };
    const previous = dashboard.dataset.status;
    dashboard.replaceWith(nextDashboard);
    dashboard = nextDashboard;
    snapshot.replaceChildren(...nextSnapshot.childNodes);
    warning.hidden = true;
    warning.textContent = "";
    if (restoreFocus) {
      const replacement = key ? dashboard.querySelector(`[data-focus-key="${CSS.escape(key)}"]`) : null;
      (replacement ?? refreshLink)?.focus({ preventScroll: true });
    }
    window.scrollTo(scroll);
    if (previous !== dashboard.dataset.status) announcement.textContent = dashboard.dataset.statusLabel;
  } catch {
    if (!warning.hidden) return;
    const displayed = new Date(dashboard.dataset.renderedAt).toISOString();
    warning.textContent = `Unable to refresh. Showing the snapshot from ${displayed.slice(0, 10)} ${displayed.slice(11, 16)} UTC.`;
    warning.hidden = false;
  } finally {
    refreshing = false;
    scheduleRefresh();
  }
}

if (dashboard && snapshot && warning && announcement) {
  scheduleRefresh();
  document.addEventListener("visibilitychange", scheduleRefresh);
}
