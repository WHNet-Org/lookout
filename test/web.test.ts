import assert from "node:assert/strict";
import test from "node:test";
import { MINUTE_MS, type Check, type Config, type Run, type Store } from "../src/model.ts";
import { createWebHandler } from "../src/web.ts";

const origin = "https://lookout.example.test";
const now = Date.parse("2026-11-23T15:06:00Z");
const day = Date.parse("2026-11-23T00:00:00Z");

function fixture() {
  const checks: Check[] = [
    { id: "app", name: "Public <App>", type: "http", url: "https://public-target.test/app", method: "GET", visibility: "public", dependsOn: ["private-db", "proxy"], timeoutMs: 5000, alert: { threshold: 2, muted: false } },
    { id: "private-db", name: "Internal database only", type: "http", url: "https://private-target.test/data?token=private-credential", method: "GET", visibility: "private", dependsOn: [], timeoutMs: 5000, alert: { threshold: 2, muted: false } },
    { id: "proxy", name: "Visible Proxy", type: "tcp", host: "proxy.example.test", port: 443, visibility: "public", dependsOn: [], timeoutMs: 5000, alert: { threshold: 2, muted: false } },
  ];
  const config: Config = {
    checks,
    groups: [
      { id: "whnet", name: "WHNet", visibility: "detailed", checks: ["app", "private-db"] },
      { id: "aggregate", name: "Private aggregate", visibility: "aggregate", checks: ["private-db"] },
      { id: "redacted", name: "Hidden group name", visibility: "private", checks: ["proxy"] },
    ],
    defaultGroup: "whnet",
    allowedOrigins: ["https://whnet.ca"],
  };
  const run: Run = {
    scheduledAt: now,
    results: {
      app: { ok: false, latencyMs: 56, httpCode: 503, reason: "database-only secret text" },
      "private-db": { ok: false, latencyMs: 4201, httpCode: 502 },
      proxy: { ok: false, latencyMs: 190, httpCode: null },
    },
    alertStates: {},
    groupStates: {},
  };
  const dailyQueries: string[][] = [];
  const historyQueries: [string, number, number][] = [];
  const store: Store = {
    latest: async () => run,
    commit: async () => false,
    daily: async (kind, ids) => {
      dailyQueries.push([kind, ...ids]);
      return ids.map((id) => ({ id, day, observed: 4, up: 3, latencySum: kind === "check" ? 66 : null }));
    },
    history: async (id, from, until) => {
      historyQueries.push([id, from, until]);
      return [{ scheduledAt: now, result: run.results[id]! }];
    },
  };
  return { run, config, store, dailyQueries, historyQueries };
}

test("published aggregates use private outcomes without disclosing check details or querying their history", async () => {
  const state = fixture();
  const serve = createWebHandler({ ...state, now: () => now });
  const output = await serve(new Request(origin));
  assert.equal(output.headers.get("cache-control"), "no-store");
  const page = await output.text();
  assert.match(page, /Service outage/);
  assert.match(page, /Public &lt;App&gt;/);
  assert.match(page, /Upstream check also failing — Visible Proxy/);
  assert.match(page, /75% uptime, gaps in observations/);
  assert.doesNotMatch(page, /private-db|Internal database only|private-target|4201|Hidden group name/);
  assert.deepEqual(state.dailyQueries, [["check", "app", "proxy"], ["group", "whnet", "aggregate"]]);
  for (const [hidden, missing] of [["/monitors/private-db", "/monitors/never-configured"], ["/api/status?group=redacted", "/api/status?group=never-configured"]]) {
    const protectedResponse = await serve(new Request(origin + hidden));
    const absentResponse = await serve(new Request(origin + missing));
    assert.equal(protectedResponse.status, 404);
    assert.equal(absentResponse.status, 404);
    assert.deepEqual([...protectedResponse.headers], [...absentResponse.headers]);
    assert.equal(await protectedResponse.text(), await absentResponse.text());
  }
  assert.equal(state.historyQueries.length, 0);
});

test("public API uses an exact CORS allowlist and expires a sample after three scheduled minutes", async () => {
  const state = fixture();
  let clock = now + 2 * MINUTE_MS;
  const serve = createWebHandler({ ...state, now: () => clock });
  const request = (browserOrigin: string) => new Request(origin + "/api/status?group=whnet", { headers: { Origin: browserOrigin } });
  const fresh = await serve(request("https://whnet.ca"));
  assert.equal(fresh.headers.get("access-control-allow-origin"), "https://whnet.ca");
  assert.deepEqual(await fresh.json(), { online: false, status: "outage" });
  clock += MINUTE_MS;
  const stale = await serve(request("https://whnet.ca.other.example"));
  assert.equal(stale.headers.has("access-control-allow-origin"), false);
  assert.deepEqual(await stale.json(), { online: false, status: "unknown" });
  const dashboard = await (await serve(new Request(origin))).text();
  assert.match(dashboard, /Status unknown/);
  assert.match(dashboard, /56 ms/);
  assert.doesNotMatch(dashboard, /Upstream check also failing/);
});

test("overlapping detailed groups link to the same public check and render its history once", async () => {
  const state = fixture();
  state.config.groups.push({ id: "another-group", name: "Another group", visibility: "detailed", checks: ["app"] });
  const serve = createWebHandler({ ...state, now: () => now });
  const dashboard = await (await serve(new Request(origin))).text();
  assert.equal([...dashboard.matchAll(/href="\/monitors\/app"/g)].length, 2);
  assert.equal([...dashboard.matchAll(/class="history-strip"/g)].length, 5);
  assert.match(dashboard, /class="check-membership"><a href="\/monitors\/app" data-focus-key="group\/another-group\/app"/);
  assert.doesNotMatch(dashboard, /private-db|Internal database only/);
});

test("private and detailed pages apply HTTPS Basic authentication and sanitize stored results", async () => {
  const state = fixture();
  const options = { ...state, now: () => now };
  const serve = createWebHandler({ ...options, privateUser: "operatör", privatePassword: "strong:password" });
  const auth = { Authorization: `Basic ${Buffer.from("operatör:strong:password").toString("base64")}` };
  const challenge = await serve(new Request(origin + "/private/monitors/private-db"));
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get("www-authenticate") ?? "", /^Basic /);
  assert.equal((await serve(new Request("http://lookout.example.test/private", { headers: auth }))).status, 404);
  assert.equal((await createWebHandler(options)(new Request(origin + "/private", { headers: auth }))).status, 404);

  const privatePage = await serve(new Request(origin + "/private", { headers: auth }));
  assert.equal(privatePage.status, 200);
  assert.equal(privatePage.headers.get("cache-control"), "no-store");
  const privateContent = await privatePage.text();
  assert.match(privateContent, /Internal database only/);
  assert.match(privateContent, /https:\/\/private-target\.test\/data/);
  assert.doesNotMatch(privateContent, /private-credential|strong:password/);

  const details = await (await serve(new Request(origin + "/monitors/app"))).text();
  assert.match(details, /22 ms/);
  assert.match(details, /503/);
  assert.match(details, /Check failed/);
  assert.match(details, /No data/);
  assert.match(details, /Older results/);
  assert.doesNotMatch(details, /database-only|Internal database only|private-db|public-target/);
  assert.deepEqual(state.historyQueries, [["app", now - 119 * MINUTE_MS, now + MINUTE_MS]]);
});
