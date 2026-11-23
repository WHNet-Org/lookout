import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../src/config.ts";
import { evaluateRun } from "../src/engine.ts";
import { MINUTE_MS } from "../src/model.ts";
import type { ProbeResult, Results, Run } from "../src/model.ts";
import { runProbes } from "../src/probe.ts";
import type { ProbeOptions } from "../src/probe.ts";

const http = { id: "app", name: "App", type: "http", url: "https://app.example.test/start" };
const tcp = (id: string, dependsOn: string[] = []) =>
  ({ id, name: id, dependsOn, type: "tcp", host: "127.0.0.1", port: 9000 });
const unavailable: ProbeResult = { ok: false, latencyMs: 5, httpCode: null, reason: "connect_failed" };
const available: ProbeResult = { ok: true, latencyMs: 5, httpCode: null };
const unused = () => { throw new Error("Unexpected probe"); };

function probeOptions(fetch: typeof globalThis.fetch = unused, overrides: Partial<ProbeOptions> = {}): ProbeOptions {
  return { fetch, connectTcp: unused, getSecret: () => undefined, ...overrides };
}

test("normalizes and validates git config, dependencies and probe budgets", () => {
  const config = validateConfig({
    alert: { threshold: 4, muted: true },
    checks: [
      { ...http, alertGroup: "apps", alert: { muted: false }, dependsOn: ["origin"] },
      tcp("origin"),
    ],
    groups: [{ id: "apps", name: "Apps", visibility: "aggregate", checks: ["app"], alert: { threshold: 3 } }],
    defaultGroup: "apps",
  });
  assert.deepEqual(config.checks.map((check) => check.alert), [
    { threshold: 3, muted: false }, { threshold: 4, muted: true },
  ]);
  assert.equal(config.checks[0].visibility, "private");
  assert.equal(config.checks[0].timeoutMs, 5_000);
  assert.throws(() => validateConfig({ checks: [tcp("first", ["second"]), tcp("second", ["first"])] }), /cycle/);
  assert.throws(() => validateConfig({ checks: [tcp("first", ["missing"])] }), /does not exist/);
  assert.throws(() => validateConfig({ checks: [tcp("first", ["first"])] }), /itself/);
  assert.throws(() => validateConfig({ checks: [{ ...http, method: "HEAD", bodyRegex: "ready" }] }), /requires GET/);
  assert.throws(() => validateConfig({ checks: [{ ...http, bodyRegex: "(?=unsupported)" }] }), /valid RE2/);
  assert.throws(() => validateConfig({ checks: [{ ...http, timeoutMs: 8_001 }] }), /8000/);
  assert.throws(() => validateConfig({ checks: [{ ...http, headers: { "Bad Name": "value" } }] }), /valid HTTP header/);
  assert.throws(() => validateConfig({ checks: Array.from({ length: 26 }, (_, i) => tcp(`target-${i}`)) }), /25 checks/);
  assert.throws(() => validateConfig({ checks: Array.from({ length: 12 }, (_, i) =>
    ({ ...http, id: `target-${i}`, redirects: {} })) }), /45 probe operations/);
  assert.throws(() => validateConfig({ checks: [], groups: Array.from({ length: 41 }, (_, i) =>
    ({ id: `group-${i}`, name: `Group ${i}`, checks: [] })) }), /40 rollups/);
});

test("inspects the first response unless permitted to follow redirects and drops headers at an origin change", async () => {
  const calls: { url: string; headers: Headers; method?: string }[] = [];
  const responses = () => probeOptions(async (url, options) => {
    calls.push({ url: String(url), headers: new Headers(options?.headers), method: options?.method });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: "/next" } });
    if (calls.length === 2) return new Response(null, { status: 307, headers: { Location: "https://new.example.test/end" } });
    return new Response(null, { status: 204 });
  }, { getSecret: (name) => name === "AUTH" ? "Bearer example" : undefined });
  const check = { ...http, method: "HEAD", headers: { Authorization: { secret: "AUTH" }, "X-Custom": "test" } };
  const first = await runProbes(validateConfig({ checks: [{ ...check, expectedCodes: [302] }] }), responses());
  assert.equal(first.app.ok, true);
  assert.equal(first.app.httpCode, 302);
  assert.equal(calls.length, 1);

  calls.length = 0;
  const blocked = await runProbes(validateConfig({ checks: [{ ...check, redirects: {} }] }), responses());
  assert.equal(blocked.app.reason, "redirect_blocked");
  assert.equal(blocked.app.httpCode, 307);
  assert.equal(calls.length, 2);

  calls.length = 0;
  const followed = await runProbes(validateConfig({ checks: [
    { ...check, redirects: { allowedOrigins: ["https://new.example.test"] } },
  ] }), responses());
  assert.equal(followed.app.ok, true);
  assert.equal(followed.app.httpCode, 204);
  assert.deepEqual(calls.map((call) => call.method), ["HEAD", "HEAD", "HEAD"]);
  assert.deepEqual(calls.map((call) => call.headers.get("Authorization")), ["Bearer example", "Bearer example", null]);
  assert.equal(calls[2].headers.get("X-Custom"), null);
});

test("permits same-host HTTPS upgrades, limits redirect hops, and skips probes with missing secrets", async () => {
  const config = validateConfig({ checks: [{
    ...http, url: "http://app.example.test/start", redirects: {}, headers: { Authorization: { secret: "AUTH" } },
  }] });
  const seen: string[] = [];
  const fetch: typeof globalThis.fetch = async (url, options) => {
    seen.push(String(url));
    assert.equal(new Headers(options?.headers).get("Authorization"), seen.length === 1 ? "first only" : null);
    return new Response(null, {
      status: 302,
      headers: { Location: seen.length === 1 ? "https://app.example.test/loop" : "/loop" },
    });
  };
  const missing = await runProbes(config, probeOptions(fetch));
  assert.equal(missing.app.reason, "missing_secret");
  assert.deepEqual(seen, []);
  const redirected = await runProbes(config, probeOptions(fetch, { getSecret: () => "first only" }));
  assert.equal(redirected.app.reason, "redirect_limit");
  assert.deepEqual(seen, [
    "http://app.example.test/start", "https://app.example.test/loop", "https://app.example.test/loop", "https://app.example.test/loop",
  ]);
});

test("normalizes outbound headers without attempting a fetch for invalid secret values", async () => {
  const config = validateConfig({ checks: [{ ...http, headers: { "X-Token": { secret: "AUTH" } } }] });
  const seen: (string | null)[] = [];
  const options = (secret: string) => probeOptions(async (_url, init) => {
    seen.push(new Headers(init?.headers).get("X-Token"));
    return new Response(null, { status: 204 });
  }, { getSecret: () => secret });
  for (const secret of ["Bearer example\r\nX-Extra: injected", "NUL\0byte", "outside Latin-1 λ"]) {
    assert.equal((await runProbes(config, options(secret))).app.reason, "invalid_header");
  }
  assert.deepEqual(seen, []);
  assert.equal((await runProbes(config, options("\tBearer sample \t"))).app.ok, true);
  assert.equal((await runProbes(config, options("\té \t"))).app.ok, true);
  assert.deepEqual(seen, ["Bearer sample", "é"]);
});

test("an inspect-first check does not read Location from a redirect response", async () => {
  const config = validateConfig({ checks: [{ ...http, expectedCodes: [302] }] });
  const response = new Response(null, { status: 302 });
  Object.defineProperty(response, "headers", { get: () => assert.fail("Visited redirect headers") });
  assert.equal((await runProbes(config, probeOptions(async () => response))).app.ok, true);
});

test("retains status codes on regex mismatch, body overflow and body timeout", async () => {
  const check = { ...http, bodyRegex: "^ready\\n?$" };
  const config = validateConfig({ checks: [check] });
  for (const [response, code, reason] of [
    [new Response("ready\n", { status: 200 }), 200, undefined],
    [new Response("ready\nextra", { status: 200 }), 200, "body_mismatch"],
    [new Response("x".repeat(16 * 1024 + 1), { status: 200 }), 200, "body_too_large"],
    [new Response("ready", { status: 503 }), 503, "status_mismatch"],
  ] as const) {
    const results = await runProbes(config, probeOptions(async () => response));
    assert.equal(results.app.httpCode, code);
    assert.equal(results.app.reason, reason);
    assert.equal(results.app.ok, reason === undefined);
  }
  let cancelled = false;
  const hangingBody = new ReadableStream({ cancel: () => { cancelled = true; } });
  const shortDeadline = validateConfig({ checks: [{ ...check, timeoutMs: 40 }] });
  const timedOut = await runProbes(shortDeadline, probeOptions(async () => new Response(hangingBody)));
  assert.equal(timedOut.app.reason, "timeout");
  assert.equal(timedOut.app.httpCode, 200);
  assert.equal(cancelled, true);
});

test("runs at most five probes at a time and times out stalled TCP connections", async () => {
  let active = 0;
  let peak = 0;
  const config = validateConfig({ checks: [
    ...Array.from({ length: 10 }, (_, i) => tcp(`target-${i}`)),
    { ...tcp("stalled"), port: 9_001, timeoutMs: 15 },
    { ...tcp("refused"), port: 9_002 },
  ] });
  const outcomes = await runProbes(config, probeOptions(unused, {
    connectTcp: async (_host, port, signal) => {
      if (port === 9_001) return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      if (port === 9_002) throw new Error("private detail");
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    },
  }));
  assert.equal(peak, 5);
  assert.equal(outcomes["target-9"].ok, true);
  assert.equal(outcomes.stalled.reason, "timeout");
  assert.equal(outcomes.refused.reason, "connect_failed");
  assert.equal(outcomes.refused.httpCode, null);
});

test("holds downstream alerts, deduplicates diamond impact, and promotes lingering failures", () => {
  const config = validateConfig({ checks: [
    { ...tcp("origin"), alert: { threshold: 3 } },
    tcp("left", ["origin"]), tcp("right", ["origin"]), tcp("leaf", ["left", "right"]),
  ] });
  let previous: Run | null = null;
  function tick(minute: number, ...down: string[]) {
    const results = Object.fromEntries(config.checks.map(({ id }) => [id, down.includes(id) ? unavailable : available]));
    const outcome = evaluateRun(config, minute * MINUTE_MS, results, previous);
    previous = outcome.run;
    return outcome.events;
  }
  assert.deepEqual(tick(1, "origin", "left", "right"), []);
  assert.deepEqual(tick(2, "origin", "left", "right"), []);
  const start = tick(3, "origin", "left", "right");
  assert.deepEqual(start.map((event) => [event.kind, event.check.id, event.affected.map(({ id }) => id)]), [
    ["outage", "origin", ["left", "right"]],
  ]);
  const impact = tick(4, "origin", "left", "right", "leaf");
  assert.deepEqual(impact.map((event) => [event.kind, event.incidentId, event.affected.map(({ id }) => id)]), [
    ["impact", start[0].incidentId, ["leaf"]],
  ]);
  assert.deepEqual(tick(5, "origin", "left", "right", "leaf"), []);
  const recovered = tick(6, "leaf");
  assert.deepEqual(recovered.map((event) => [event.kind, event.check.id]), [["recovery", "origin"], ["outage", "leaf"]]);
});

test("missed minutes reset pending failures and a later muted upstream preserves the child's open incident", () => {
  const config = validateConfig({ checks: [
    { ...tcp("origin"), alert: { muted: true, threshold: 1 } }, tcp("child", ["origin"]), tcp("other", ["origin"]),
  ] });
  const first = evaluateRun(config, MINUTE_MS, { origin: available, child: unavailable, other: unavailable }, null);
  const gap = evaluateRun(config, 3 * MINUTE_MS, { origin: available, child: unavailable, other: available }, first.run);
  assert.deepEqual(gap.events, []);
  const child = evaluateRun(config, 4 * MINUTE_MS, { origin: available, child: unavailable, other: available }, gap.run);
  assert.deepEqual(child.events.map((event) => [event.kind, event.check.id]), [["outage", "child"]]);
  const cascade = evaluateRun(config, 5 * MINUTE_MS, { origin: unavailable, child: unavailable, other: unavailable }, child.run);
  assert.deepEqual(cascade.events, []);
  const continuing = evaluateRun(config, 6 * MINUTE_MS, { origin: unavailable, child: available, other: unavailable }, cascade.run);
  assert.deepEqual(continuing.events.map((event) => [event.kind, event.incidentId]), [["recovery", child.events[0].incidentId]]);
  const later = evaluateRun(config, 7 * MINUTE_MS, { origin: available, child: available, other: unavailable }, continuing.run);
  assert.deepEqual(later.events.map((event) => [event.kind, event.check.id]), [["outage", "other"]]);
});

test("a passing or missing intermediate stops a cascade and distinct roots report shared impact", () => {
  const config = validateConfig({
    alert: { threshold: 1 },
    checks: [
      tcp("origin"), tcp("other"), tcp("middle", ["origin"]), tcp("leaf", ["middle"]), tcp("shared", ["origin", "other"]),
    ],
  });
  const middleStates: Results[] = [{ middle: available }, {}];
  for (const middle of middleStates) {
    const result = evaluateRun(config, MINUTE_MS, {
      origin: unavailable, other: unavailable, leaf: unavailable, shared: unavailable, ...middle,
    }, null);
    assert.deepEqual(result.events.map((event) => [event.check.id, event.affected.map(({ id }) => id)]), [
      ["origin", ["shared"]], ["other", ["shared"]], ["leaf", []],
    ]);
  }
});
