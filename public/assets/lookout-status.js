const states = {
  operational: ["✓", "Operational"],
  degraded: ["!", "Degraded"],
  outage: ["×", "Outage"],
  unknown: ["–", "Status unknown"],
  unavailable: ["–", "Status unavailable"],
};
const refreshInterval = 60_000;
const moduleOrigin = new URL(import.meta.url).origin;
const stylesheet = new URL("./lookout-status.css", import.meta.url).href;
const scopes = new Map();
let timer;

function schedule() {
  clearTimeout(timer);
  if (document.hidden) return;
  const now = Date.now();
  let next = Infinity;
  for (const [url, scope] of scopes) {
    if (scope.pending) continue;
    const due = scope.lastAttempt + refreshInterval;
    if (scope.listeners.size || due > now) next = Math.min(next, due);
    else scopes.delete(url);
  }
  if (next !== Infinity) timer = setTimeout(refresh, Math.max(0, next - now));
}

function refresh() {
  if (document.hidden) return;
  const now = Date.now();
  for (const [url, scope] of scopes) {
    if (scope.listeners.size && !scope.pending && now - scope.lastAttempt >= refreshInterval) {
      void fetchStatus(url, scope);
    }
  }
  schedule();
}

async function fetchStatus(url, scope) {
  scope.pending = true;
  scope.lastAttempt = Date.now();
  let state = "unavailable";
  try {
    const result = await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (result.ok) {
      const { online, status } = await result.json();
      if (typeof status === "string" && status !== "unavailable" &&
          Object.hasOwn(states, status) && online === (status === "operational")) state = status;
    }
  } catch {
    // The detail link remains available when a status request fails.
  }
  scope.pending = false;
  scope.state = state;
  for (const listen of scope.listeners) listen(state);
  schedule();
}

function subscribe(url, listener) {
  let scope = scopes.get(url);
  if (!scope) {
    scope = { state: "unknown", lastAttempt: -Infinity, pending: false, listeners: new Set() };
    scopes.set(url, scope);
  }
  scope.listeners.add(listener);
  listener(scope.state);
  schedule();
  return () => {
    scope.listeners.delete(listener);
    schedule();
  };
}

function statusOrigin(value) {
  if (value === null) return moduleOrigin;
  const url = URL.parse(value);
  if (url && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash) return url.origin;
  return null;
}

function statusScope(element) {
  const origin = statusOrigin(element.getAttribute("origin"));
  const check = element.getAttribute("check");
  const group = element.getAttribute("group");
  const validId = (value) => value === null || /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
  if (!origin || (check !== null && group !== null) || !validId(check) || !validId(group)) return null;
  const endpoint = new URL("/api/v1/status", origin);
  if (check) endpoint.searchParams.set("check", check);
  if (group) endpoint.searchParams.set("group", group);
  const path = check ? `/monitors/${encodeURIComponent(check)}` : group ? `/#group-${encodeURIComponent(group)}` : "/";
  return { endpoint: endpoint.href, destination: new URL(path, origin).href };
}

class LookoutStatus extends HTMLElement {
  static observedAttributes = ["check", "group", "origin", "variant", "label"];
  #frame;
  #label;
  #mark;
  #value;
  #stop;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = stylesheet;
    this.#frame = document.createElement("a");
    this.#frame.className = "frame";
    this.#frame.setAttribute("part", "frame");
    this.#label = document.createElement("span");
    this.#label.className = "label";
    this.#label.setAttribute("part", "label");
    const status = document.createElement("span");
    status.className = "status";
    status.setAttribute("part", "status");
    status.setAttribute("role", "status");
    this.#mark = document.createElement("span");
    this.#mark.className = "mark";
    this.#mark.setAttribute("aria-hidden", "true");
    this.#value = document.createElement("span");
    status.append(this.#mark, this.#value);
    this.#frame.append(this.#label, status);
    root.append(style, this.#frame);
    this.#render("unknown");
  }

  connectedCallback() {
    this.#presentation();
    this.#connectScope();
  }

  disconnectedCallback() {
    this.#stop?.();
    this.#stop = undefined;
  }

  attributeChangedCallback(name, before, after) {
    if (!this.isConnected || before === after) return;
    if (name === "label" || name === "variant") this.#presentation();
    else this.#connectScope();
  }

  #presentation() {
    this.#label.textContent = this.getAttribute("label")?.trim() || "Service status";
    this.#frame.dataset.variant = this.getAttribute("variant") === "card" ? "card" : "badge";
  }

  #connectScope() {
    this.#stop?.();
    const scope = statusScope(this);
    if (!scope) {
      this.#stop = undefined;
      this.#frame.href = new URL("/", moduleOrigin).href;
      this.#render("unavailable");
      return;
    }
    this.#frame.href = scope.destination;
    this.#stop = subscribe(scope.endpoint, (state) => this.#render(state));
  }

  #render(state) {
    if (this.#frame.dataset.status === state) return;
    this.#frame.dataset.status = state;
    [this.#mark.textContent, this.#value.textContent] = states[state];
  }
}

if (!customElements.get("lookout-status")) {
  customElements.define("lookout-status", LookoutStatus);
  document.addEventListener("visibilitychange", schedule);
}
