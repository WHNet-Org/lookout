import { createBuildInfo, type BuildInfo } from "./build-info.ts";
import {
  DAY_MS,
  MINUTE_MS,
  currentResult,
  groupState,
  type Check,
  type Config,
  type DailyRollup,
  type GroupState,
  type ProbeResult,
  type Run,
  type Store,
} from "./model.ts";

const HISTORY_DAYS = 7;
const HISTORY_PAGE = 120 * MINUTE_MS;

const states = {
  operational: { label: "Operational", symbol: "✓", banner: "All systems operational" },
  degraded: { label: "Degraded", symbol: "!", banner: "Some services are degraded" },
  outage: { label: "Outage", symbol: "×", banner: "Service outage" },
  unknown: { label: "Unknown", symbol: "–", banner: "Status unknown" },
} satisfies Record<GroupState, { label: string; symbol: string; banner: string }>;

const failureReasons: Readonly<Record<string, string>> = {
  timeout: "Timed out",
  request_failed: "Request failed",
  connect_failed: "Connection failed",
  status_mismatch: "Unexpected HTTP code",
  body_mismatch: "Body did not match",
  body_too_large: "Body exceeded the size limit",
  redirect_limit: "Redirect limit reached",
  redirect_blocked: "Redirect destination is disallowed",
  missing_secret: "Check configuration is incomplete",
  invalid_header: "Check configuration is incomplete",
};

interface WebOptions {
  config: Config;
  store: Store;
  buildInfo?: BuildInfo;
  now?: () => number;
  privateUser?: string;
  privatePassword?: string;
}

type Rollups = Map<string, Map<number, DailyRollup>>;
type CheckResults = Record<string, ProbeResult>;

interface CheckView {
  checks: ReadonlyMap<string, Check>;
  results: CheckResults;
  run: Run | null;
  rollups: Rollups;
  now: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function stateOf(result: ProbeResult | undefined): GroupState {
  return result === undefined ? "unknown" : result.ok ? "operational" : "outage";
}

function checkStateText(result: ProbeResult | undefined): string {
  return result === undefined ? "Unknown" : result.ok ? "Up" : "Down";
}

function isoDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function time(value: number, date = false): string {
  const iso = new Date(value).toISOString();
  const display = date ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 16);
  return `<time datetime="${iso}">${display} UTC</time>`;
}

function startOfDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

function firstDay(now: number): number {
  return startOfDay(now) - (HISTORY_DAYS - 1) * DAY_MS;
}

function liveResults(checks: readonly Check[], run: Run | null, now: number): CheckResults {
  const results: CheckResults = Object.create(null);
  for (const check of checks) {
    const result = currentResult(run, check.id, now);
    if (result) results[check.id] = result;
  }
  return results;
}

function lastMeasurement(run: Run | null, id: string, now: number): ProbeResult | undefined {
  return run && run.scheduledAt <= now && Object.hasOwn(run.results, id) ? run.results[id] : undefined;
}

function rollupIndex(rows: readonly DailyRollup[]): Rollups {
  const rollups: Rollups = new Map();
  for (const row of rows) {
    let days = rollups.get(row.id);
    if (!days) {
      days = new Map();
      rollups.set(row.id, days);
    }
    days.set(row.day, row);
  }
  return rollups;
}

function percentage(up: number, observed: number): string {
  if (up === observed) return "100%";
  if (up === 0) return "0%";
  return `${((up / observed) * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

function expectedSamples(day: number, now: number): number {
  const elapsedMinutes = Math.floor((now - day) / MINUTE_MS) + 1;
  return Math.min(DAY_MS / MINUTE_MS, elapsedMinutes);
}

function badge(state: GroupState, label: string = states[state].label): string {
  return `<span class="state tone-${state}"><span class="state-mark" aria-hidden="true">${states[state].symbol}</span>${label}</span>`;
}

function historyStrip(days: Map<number, DailyRollup> | undefined, now: number): string {
  const cells: string[] = [];
  for (let day = firstDay(now); day <= startOfDay(now); day += DAY_MS) {
    const date = isoDate(day);
    const rollup = days?.get(day);
    const observed = rollup?.observed ?? 0;
    const up = rollup?.up ?? 0;
    const state = observed === 0 ? "unknown" : up === observed ? "operational" : up === 0 ? "outage" : "degraded";
    const gap = observed > 0 && observed < expectedSamples(day, now);
    const stateLabel = observed === 0 ? "No data" : `${percentage(up, observed)} uptime`;
    const value = observed ? percentage(up, observed) : states.unknown.symbol;
    cells.push(`<li class="day"><span class="sr-only">${date}, ${stateLabel}${gap ? ", gaps in observations" : ""}</span><span class="day-cell tone-${state}${gap ? " has-gap" : ""}" aria-hidden="true">${value}</span><time class="day-label" datetime="${date}" aria-hidden="true">${date.slice(5)}</time></li>`);
  }
  return `<ol class="history-strip" role="list" aria-label="Daily uptime · seven UTC days">${cells.join("")}</ol>`;
}

const legend = `<ul class="legend" aria-label="History legend">
  <li class="tone-operational"><span class="legend-sample" aria-hidden="true"></span> Healthy</li>
  <li class="tone-degraded"><span class="legend-sample" aria-hidden="true"></span> Some failures</li>
  <li class="tone-outage"><span class="legend-sample" aria-hidden="true"></span> All failed</li>
  <li class="tone-unknown"><span class="legend-sample" aria-hidden="true">–</span> No data</li>
  <li class="tone-unknown"><span class="legend-sample has-gap" aria-hidden="true"></span> Partial data</li>
</ul>`;

const defaultBuild = createBuildInfo();
const sourceRepository = "https://github.com/WHNet-Org/lookout";

function page(options: WebOptions, title: string, contents: string, section?: "status" | "embed"): string {
  const { version, revision } = options.buildInfo ?? defaultBuild;
  const sourceUrl = revision ? `${sourceRepository}/tree/${revision}` : sourceRepository;
  const scripts = section === "status" ? ['<script type="module" src="/assets/dashboard.js"></script>']
    : section === "embed" ? ['<script type="module" src="/assets/lookout-status.js"></script>', '<script type="module" src="/assets/embed-guide.js"></script>']
      : [];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Lookout</title>
  <link rel="icon" type="image/svg+xml" href="/assets/lookout.svg">
  <link rel="stylesheet" href="/assets/mosaic.css">
  <link rel="stylesheet" href="/assets/styles.css">
  ${scripts.join("\n  ")}
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="mast"><div class="wrap mast-inner">
    <a class="brand" href="/"><img src="/assets/lookout.svg" width="32" height="32" alt="">Lookout</a>
    <nav class="mast-nav" aria-label="Lookout"><a href="/"${section === "status" ? ' aria-current="page"' : ""}>Status</a><a href="/embed"${section === "embed" ? ' aria-current="page"' : ""}>Embed</a></nav>
  </div></header>
  <main class="wrap main" id="main" tabindex="-1">
  ${contents}
  </main>
  <footer class="site-footer"><div class="wrap footer-inner">
    <div class="footer-identity">
      <a class="brand" href="/"><img src="/assets/lookout.svg" width="32" height="32" alt="">Lookout</a>
      <p class="build-label">v${escapeHtml(version)}${revision ? ` · <code title="${escapeHtml(revision)}">${escapeHtml(revision.slice(0, 7))}</code>` : ""}</p>
    </div>
    <nav class="footer-nav" aria-label="Project links"><a href="https://whnet.ca/">WHNet</a><a href="${escapeHtml(sourceUrl)}">Source code</a></nav>
  </div></footer>
</body>
</html>`;
}

function checkPath(check: Check, operator = false): string {
  return `${operator ? "/private" : ""}/monitors/${encodeURIComponent(check.id)}`;
}

function groupAnchor(id: string): string {
  return `group-${encodeURIComponent(id)}`;
}

function embedPage(options: WebOptions): string {
  const exampleOrigin = "https://status.example.com";
  const check = options.config.checks.find((candidate) => candidate.visibility === "public");
  const group = options.config.groups.find((candidate) => candidate.visibility !== "private");
  const samples = [
    {
      id: "overall", title: "Overall status", label: "Service status", scope: "", path: "/", variant: "badge",
      description: "Show the status of your default service group on another site.",
    },
    {
      id: "group", title: "Service group", label: group?.name ?? "Services", scope: ` group="${escapeHtml(group?.id ?? "my-group")}"`,
      path: `/#${groupAnchor(group?.id ?? "my-group")}`, variant: "card",
      description: "Show the combined status of a published group.",
      missing: group ? undefined : "Publish a service group to enable a live preview.",
    },
    {
      id: "check", title: "Single check", label: check?.name ?? "Service", scope: ` check="${escapeHtml(check?.id ?? "my-check")}"`,
      path: check ? checkPath(check) : "/monitors/my-check", variant: "badge",
      description: "Show the status of one public check and link to its history.",
      missing: check ? undefined : "Publish a check to enable a live preview.",
    },
  ];
  const cards = samples.map(({ id, title, label, scope, path, variant, description, missing }) => {
    const markup = (origin: string) => `<lookout-status${scope} variant="${variant}" label="${escapeHtml(label)}">
  <a href="${origin}${path}">${escapeHtml(label)}</a>
</lookout-status>`;
    const code = `<script type="module" src="${exampleOrigin}/assets/lookout-status.js"></script>
${markup(exampleOrigin)}`;
    const appearance = [["badge", "Badge"], ["card", "Card"]].map(([value, text]) =>
      `<label><input type="radio" name="${id}-appearance" value="${value}"${variant === value ? " checked" : ""}>${text}</label>`).join("");
    return `<article class="panel embed-example">
      <header class="embed-example-head"><h2>${title}</h2><p class="secondary">${description}</p></header>
      <div class="embed-example-body">
        <div class="embed-demo">
          <fieldset class="embed-appearance" hidden><legend class="sr-only">${title} appearance</legend>${appearance}</fieldset>
          <div class="embed-preview">${missing ? `<p class="secondary">${missing}</p>` : markup("")}</div>
        </div>
        <div class="embed-code">
          <div class="embed-code-actions" hidden>
            <span class="secondary" data-embed-feedback role="status"></span>
            <button type="button" class="quiet-control" data-embed-copy aria-label="Copy ${title.toLowerCase()} code">Copy</button>
          </div>
          <pre tabindex="0" aria-label="${title} code"><code data-embed-code>${escapeHtml(code)}</code></pre>
        </div>
      </div>
    </article>`;
  });
  return page(options, "Embed status", `<div class="page-heading"><h1>Embed status</h1></div>
  <p class="secondary embed-intro">Choose a scope and appearance, then copy the HTML into your site. Load the Lookout module once per page. For a group or check, use its published ID.</p>
  <noscript><p class="secondary">Replace <code>https://status.example.com</code> in the HTML with this status site’s origin.</p></noscript>
  <div class="embed-examples">${cards.join("")}</div>
  <p class="embed-note secondary">If your site uses a Content Security Policy, allow this Lookout origin in <code>script-src</code>, <code>style-src</code>, and <code>connect-src</code>.</p>`, "embed");
}

function checkLink(check: Check, placement: string, operator = false): string {
  const focusKey = escapeHtml(`${placement}/${check.id}`);
  return `<a href="${checkPath(check, operator)}" data-focus-key="${focusKey}">${escapeHtml(check.name)}</a>`;
}

function checkTarget(check: Check): string {
  if (check.type === "http") {
    const url = new URL(check.url);
    return `${url.origin}${url.pathname}`;
  }
  const host = check.host.includes(":") ? `[${check.host}]` : check.host;
  return `${host}:${check.port}`;
}

function dependencyNote(check: Check, checks: ReadonlyMap<string, Check>, results: CheckResults, operator = false): string {
  if (results[check.id]?.ok !== false) return "";
  const failing: string[] = [];
  for (const id of check.dependsOn) {
    const upstream = checks.get(id);
    if (upstream && (operator || upstream.visibility === "public") && results[id]?.ok === false) {
      failing.push(escapeHtml(upstream.name));
    }
  }
  if (!failing.length) return "";
  return `<p class="dependency">${failing.length === 1 ? "Upstream check also failing" : "Upstream checks also failing"} — ${failing.join(", ")}</p>`;
}

function checkRow(check: Check, placement: string, view: CheckView, operator = false): string {
  const result = view.results[check.id];
  const measurement = lastMeasurement(view.run, check.id, view.now);
  const target = operator ? `<p class="secondary operator-target"><code>${escapeHtml(checkTarget(check))}</code></p>` : "";
  const resultInfo = measurement ? `<span class="number">${measurement.latencyMs} ms</span>${measurement.httpCode === null ? "" : `<span class="number">HTTP ${measurement.httpCode}</span>`}` : "";
  return `<div class="check-row">
    <div class="row-info">
      <h3 class="row-heading">${checkLink(check, placement, operator)}</h3>
      <p class="row-meta secondary">${badge(stateOf(result), checkStateText(result))}${resultInfo}</p>${target}
    </div>
    ${historyStrip(view.rollups.get(check.id), view.now)}
    ${dependencyNote(check, view.checks, view.results, operator)}
  </div>`;
}

async function dashboard(options: WebOptions, now: number): Promise<string> {
  const { config, store } = options;
  const visibleChecks = config.checks.filter((check) => check.visibility === "public");
  const visibleGroups = config.groups.filter((group) => group.visibility !== "private");
  const [run, checkDays, groupDays] = await Promise.all([
    store.latest(),
    visibleChecks.length ? store.daily("check", visibleChecks.map((check) => check.id), firstDay(now)) : [],
    visibleGroups.length ? store.daily("group", visibleGroups.map((group) => group.id), firstDay(now)) : [],
  ]);

  const results = liveResults(config.checks, run, now);
  const groupRollups = rollupIndex(groupDays);
  const checks = new Map(visibleChecks.map((check) => [check.id, check]));
  const view = { checks, results, run, rollups: rollupIndex(checkDays), now };
  const defaultGroup = visibleGroups.find((group) => group.id === config.defaultGroup);
  const overall = defaultGroup ? groupState(defaultGroup, results) : "unknown";
  const groupedChecks = new Set<string>();
  const groups = visibleGroups.map((group) => {
    const members: string[] = [];
    if (group.visibility === "detailed") {
      for (const id of group.checks) {
        const check = checks.get(id);
        if (!check) continue;
        const placement = `group/${group.id}`;
        if (groupedChecks.has(id)) {
          const result = results[id];
          members.push(`<li class="check-membership">${checkLink(check, placement)}${badge(stateOf(result), checkStateText(result))}</li>`);
          continue;
        }
        groupedChecks.add(check.id);
        members.push(`<li>${checkRow(check, placement, view)}</li>`);
      }
    }
    return `<li class="panel" id="${groupAnchor(group.id)}"><div class="group-top"><div class="row-info"><h3>${escapeHtml(group.name)}</h3><p class="secondary">${badge(groupState(group, results))}</p></div>${historyStrip(groupRollups.get(group.id), now)}</div>${members.length ? `<ul class="group-members">${members.join("")}</ul>` : ""}</li>`;
  });
  const ungrouped = visibleChecks.filter((check) => !groupedChecks.has(check.id));
  const renderedAt = new Date(now).toISOString();
  const everything = `<div data-dashboard data-status="${overall}" data-status-label="${states[overall].banner}" data-rendered-at="${renderedAt}">
    <section aria-label="Overall status" class="overview-status tone-${overall}"><span class="state-mark" aria-hidden="true">${states[overall].symbol}</span><div><h2>${states[overall].banner}</h2>${defaultGroup ? `<p>${escapeHtml(defaultGroup.name)}</p>` : ""}</div></section>
    ${groups.length ? `<section class="section" aria-labelledby="groups-title"><div class="section-heading"><h2 id="groups-title">Service groups</h2><p class="secondary">Past seven days · UTC</p></div><ul class="group-list">${groups.join("")}</ul></section>` : ""}
    ${ungrouped.length ? `<section class="section" aria-labelledby="public-checks-title"><div class="section-heading"><h2 id="public-checks-title">Services</h2><p class="secondary">Past seven days · UTC</p></div><ul class="ungrouped">${ungrouped.map((check) => `<li class="panel">${checkRow(check, "public", view)}</li>`).join("")}</ul></section>` : ""}
    ${groups.length || ungrouped.length ? legend : '<p class="section panel empty secondary">No services are published.</p>'}
  </div>`;
  return page(options, "Service status", `<div class="page-heading"><h1>Service status</h1><div class="page-actions"><span class="snapshot" data-snapshot>Updated ${time(now)}</span><a href="/" class="quiet-control">Refresh status</a></div></div><p class="sr-only" data-announcement role="status" aria-atomic="true"></p><p class="snapshot-warning" data-refresh-warning role="status" hidden></p>${everything}`, "status");
}

async function operatorPage(options: WebOptions, now: number): Promise<string> {
  const { config, store } = options;
  const [run, daily] = await Promise.all([
    store.latest(),
    config.checks.length ? store.daily("check", config.checks.map((check) => check.id), firstDay(now)) : [],
  ]);
  const results = liveResults(config.checks, run, now);
  const checks = new Map(config.checks.map((check) => [check.id, check]));
  const view = { checks, results, run, rollups: rollupIndex(daily), now };
  const rows = config.checks.map((check) => {
    const upstreams = check.dependsOn.map((id) => checks.get(id)).filter((upstream): upstream is Check => upstream !== undefined);
    return `<li class="panel">${checkRow(check, "private", view, true)}${upstreams.length ? `<p class="operator-dependencies panel-inset secondary">Requires ${upstreams.map((upstream) => `<a href="${checkPath(upstream, true)}">${escapeHtml(upstream.name)}</a>`).join(", ")}</p>` : ""}</li>`;
  });
  return page(options, "Operator status", `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Public status</a><span aria-hidden="true">/</span><span aria-current="page">Private</span></nav><div class="page-heading"><h1>Operator status</h1><span class="private-marker">Private</span></div>${rows.length ? `<ul class="ungrouped">${rows.join("")}</ul>${legend}` : '<p class="panel empty secondary">No checks are configured.</p>'}`);
}

function historyPath(check: Check, operator: boolean, before: number, ceiling: number): string {
  return `${checkPath(check, operator)}${before < ceiling ? `?before=${before}` : ""}`;
}

function dailyTable(check: Check, operator: boolean, daily: Rollups, now: number, ceiling: number): string {
  const rows: string[] = [];
  for (let day = startOfDay(now); day >= firstDay(now); day -= DAY_MS) {
    const date = isoDate(day);
    const rollup = daily.get(check.id)?.get(day);
    const observed = rollup?.observed ?? 0;
    const expected = expectedSamples(day, now);
    const link = historyPath(check, operator, Math.min(day + DAY_MS, ceiling), ceiling);
    const average = rollup?.latencySum != null && rollup.up > 0 ? `${Math.round(rollup.latencySum / rollup.up)} ms` : "—";
    rows.push(`<tr><th scope="row"><a href="${link}#samples"><time datetime="${date}">${date}</time></a></th><td class="number">${observed && rollup ? percentage(rollup.up, observed) : "—"}</td><td class="number">${average}</td><td class="number">${observed} / ${expected}</td></tr>`);
  }
  return `<div class="panel table-box"><table class="data-table"><caption class="sr-only">Daily uptime and average latency</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Uptime</th><th scope="col">Mean latency</th><th scope="col">Samples</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

async function detail(options: WebOptions, requestUrl: URL, check: Check, now: number, operator: boolean): Promise<Response> {
  const { store, config } = options;
  const ceiling = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const floor = ceiling - HISTORY_DAYS * DAY_MS;
  const cursor = requestUrl.searchParams.get("before");
  const until = cursor === null ? ceiling : Number(cursor);
  if (!Number.isSafeInteger(until) || until % MINUTE_MS !== 0 || until <= floor || until > ceiling) {
    return html(page(options, "Invalid history page", '<h1>Invalid history page</h1><p class="section"><a href="/">Return to service status</a></p>'), 400);
  }
  const from = Math.max(floor, until - HISTORY_PAGE);
  const [run, daily, entries] = await Promise.all([
    store.latest(),
    store.daily("check", [check.id], firstDay(now)),
    store.history(check.id, from, until),
  ]);
  const result = currentResult(run, check.id, now);
  const measurement = lastMeasurement(run, check.id, now);
  const checks = new Map(config.checks.map((monitor) => [monitor.id, monitor]));
  const results = liveResults(config.checks, run, now);
  const records = new Map(entries.map((entry) => [entry.scheduledAt, entry.result]));
  const rows: string[] = [];
  for (let slot = until - MINUTE_MS; slot >= from; slot -= MINUTE_MS) {
    const sample = records.get(slot);
    const code = sample?.httpCode ?? "—";
    // Only fixed application labels enter the response. Database reason strings are internal.
    const failure = sample?.ok === false && sample.reason && Object.hasOwn(failureReasons, sample.reason)
      ? failureReasons[sample.reason]
      : "Check failed";
    rows.push(`<tr><th scope="row" class="number">${time(slot, true)}</th><td>${sample ? badge(stateOf(sample), checkStateText(sample)) : "No data"}</td><td class="number">${sample ? `${sample.latencyMs} ms` : "—"}</td>${check.type === "http" ? `<td class="number">${code}</td>` : ""}<td>${sample?.ok === false ? failure : "—"}</td></tr>`);
  }
  const older = from > floor ? `<a class="quiet-control" href="${historyPath(check, operator, from, ceiling)}#samples">Older results</a>` : "";
  const newer = until < ceiling ? `<a class="quiet-control" href="${historyPath(check, operator, Math.min(until + HISTORY_PAGE, ceiling), ceiling)}#samples">Newer results</a>` : "";
  const operatorFacts = operator ? `<div><dt>Target</dt><dd><code>${escapeHtml(checkTarget(check))}</code></dd></div>` : "";
  const dependencies = operator ? check.dependsOn.map((id) => checks.get(id)).filter((upstream): upstream is Check => upstream !== undefined) : [];
  const href = operator ? "/private" : "/";
  const name = escapeHtml(check.name);
  return html(page(options, check.name, `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="${href}">${operator ? "Operator status" : "Service status"}</a><span aria-hidden="true">/</span><span aria-current="page">${name}</span></nav><div class="detail-head"><h1>${name}</h1>${badge(stateOf(result), checkStateText(result))}</div>
  <dl class="facts"><div><dt>Latest latency</dt><dd class="number">${measurement ? `${measurement.latencyMs} ms` : "—"}</dd></div>${check.type === "http" ? `<div><dt>HTTP code</dt><dd class="number">${measurement?.httpCode ?? "—"}</dd></div>` : ""}<div><dt>Last reported</dt><dd>${run && measurement ? time(run.scheduledAt, true) : "—"}</dd></div>${operatorFacts}</dl>
  ${dependencyNote(check, checks, results, operator)}${dependencies.length ? `<p class="operator-dependencies secondary">Requires ${dependencies.map((upstream) => `<a href="${checkPath(upstream, true)}">${escapeHtml(upstream.name)}</a>`).join(", ")}</p>` : ""}
  <section class="section" aria-labelledby="daily-title"><div class="section-heading"><h2 id="daily-title">Daily summary</h2><p class="secondary">Latency for successful checks</p></div>${dailyTable(check, operator, rollupIndex(daily), now, ceiling)}</section>
  <section class="section" aria-labelledby="samples"><div class="section-heading"><h2 id="samples">Minute results</h2><p class="secondary">${time(from, true)} – ${time(until - MINUTE_MS, true)}</p></div><div class="panel table-box"><table class="data-table"><caption class="sr-only">Minute-level check results</caption><thead><tr><th scope="col">Time</th><th scope="col">Result</th><th scope="col">Latency</th>${check.type === "http" ? '<th scope="col">HTTP</th>' : ""}<th scope="col">Details</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>${older || newer ? `<nav class="page-nav" aria-label="History pages">${newer}${older}</nav>` : ""}</section>`));
}

function response(body: BodyInit | null, status: number, headers: HeadersInit = {}): Response {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  result.set("Referrer-Policy", "no-referrer");
  result.set("X-Content-Type-Options", "nosniff");
  result.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  return new Response(body, { status, headers: result });
}

function html(body: string, status = 200): Response {
  return response(body, status, { "Content-Type": "text/html; charset=utf-8" });
}

function notFound(options: WebOptions): Response {
  return html(page(options, "Not found", '<h1>Page not found</h1><p class="section"><a href="/">Return to service status</a></p>'), 404);
}

function jsonStatus(body: { online: boolean; status: GroupState }, headers: Headers, code = 200): Response {
  headers.set("Content-Type", "application/json; charset=utf-8");
  return response(JSON.stringify(body), code, headers);
}

async function statusApi(options: WebOptions, request: Request, url: URL, now: number): Promise<Response> {
  const { config } = options;
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("Origin");
  if (origin && config.allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  const requested = url.searchParams.get("group");
  const group = config.groups.find((candidate) => candidate.id === (requested ?? config.defaultGroup) && candidate.visibility !== "private");
  if (!group && requested !== null) return jsonStatus({ online: false, status: "unknown" }, headers, 404);
  if (request.method === "OPTIONS") {
    headers.set("Allow", "GET, HEAD, OPTIONS");
    if (headers.has("Access-Control-Allow-Origin")) headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    return response(null, 204, headers);
  }
  const state = group ? groupState(group, liveResults(config.checks, await options.store.latest(), now)) : "unknown";
  return jsonStatus({ online: state === "operational", status: state }, headers);
}

async function embedStatusApi(options: WebOptions, request: Request, url: URL, now: number): Promise<Response> {
  const headers = new Headers({ "Access-Control-Allow-Origin": "*" });
  const unknown = { online: false, status: "unknown" } as const;
  const checks = url.searchParams.getAll("check");
  const groups = url.searchParams.getAll("group");
  if (checks.length + groups.length > 1) return jsonStatus(unknown, headers, 400);
  if (request.method === "OPTIONS") {
    headers.set("Allow", "GET, HEAD, OPTIONS");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    return response(null, 204, headers);
  }
  const { config, store } = options;
  try {
    let state: GroupState = "unknown";
    if (checks.length) {
      const check = config.checks.find((candidate) => candidate.id === checks[0] && candidate.visibility === "public");
      if (!check) return jsonStatus(unknown, headers, 404);
      state = stateOf(currentResult(await store.latest(), check.id, now));
    } else {
      const group = config.groups.find((candidate) => candidate.id === (groups[0] ?? config.defaultGroup) && candidate.visibility !== "private");
      if (!group && groups.length) return jsonStatus(unknown, headers, 404);
      if (group) state = groupState(group, liveResults(config.checks, await store.latest(), now));
    }
    return jsonStatus({ online: state === "operational", status: state }, headers);
  } catch {
    return jsonStatus(unknown, headers, 503);
  }
}

async function health(options: WebOptions): Promise<Response> {
  let status = 200;
  try {
    await options.store.latest();
  } catch {
    status = 503;
  }
  return response(JSON.stringify(options.buildInfo ?? defaultBuild), status, { "Content-Type": "application/json; charset=utf-8" });
}

async function authenticated(request: Request, user: string, password: string): Promise<boolean> {
  const encoded = request.headers.get("Authorization")?.match(/^Basic ([A-Za-z\d+/]+={0,2})$/i)?.[1];
  if (!encoded || encoded.length > 8192) return false;
  let supplied: Uint8Array<ArrayBuffer>;
  try {
    supplied = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  } catch {
    return false;
  }
  const expected = new TextEncoder().encode(`${user}:${password}`);
  const [providedHash, expectedHash] = await Promise.all([crypto.subtle.digest("SHA-256", supplied), crypto.subtle.digest("SHA-256", expected)]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let mismatch = 0;
  for (let i = 0; i < expectedBytes.length; i++) mismatch |= providedBytes[i]! ^ expectedBytes[i]!;
  return mismatch === 0;
}

function matchMonitor(pathname: string, operator: boolean): string | undefined {
  const pattern = operator ? /^\/private\/monitors\/([^/]+)$/ : /^\/monitors\/([^/]+)$/;
  const match = pathname.match(pattern);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

async function serve(options: WebOptions, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const operator = path === "/private" || path.startsWith("/private/");
  if (operator) {
    if (url.protocol !== "https:" || !options.privateUser || !options.privatePassword) return notFound(options);
    if (!await authenticated(request, options.privateUser, options.privatePassword)) {
      return response("Authentication required", 401, {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="Lookout", charset="UTF-8"',
        "X-Robots-Tag": "noindex, nofollow",
      });
    }
  }
  const embedApi = path === "/api/v1/status";
  const api = embedApi || path === "/api/status";
  if (request.method !== "GET" && request.method !== "HEAD" && !(api && request.method === "OPTIONS")) {
    return response("Method not allowed", 405, {
      Allow: api ? "GET, HEAD, OPTIONS" : "GET, HEAD",
      ...(embedApi ? { "Access-Control-Allow-Origin": "*" } : {}),
    });
  }
  const now = (options.now ?? Date.now)();
  if (embedApi) return embedStatusApi(options, request, url, now);
  if (api) return statusApi(options, request, url, now);
  if (path === "/healthz") return health(options);
  if (path === "/embed") return html(embedPage(options));
  if (path === "/") return html(await dashboard(options, now));
  if (path === "/private" || path === "/private/") return html(await operatorPage(options, now));
  const id = matchMonitor(path, operator);
  const check = options.config.checks.find((candidate) => candidate.id === id && (operator || candidate.visibility === "public"));
  return check ? detail(options, url, check, now, operator) : notFound(options);
}

export function createWebHandler(options: WebOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    let served: Response;
    try {
      served = await serve(options, request);
    } catch {
      served = html(page(options, "Service status unavailable", '<h1>Service status unavailable</h1><p class="section"><a href="/">Try again</a></p>'), 503);
    }
    if (new URL(request.url).pathname.startsWith("/private")) {
      served.headers.set("X-Robots-Tag", "noindex, nofollow");
    }
    return request.method === "HEAD" ? new Response(null, { status: served.status, headers: served.headers }) : served;
  };
}
