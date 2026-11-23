import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStagingMetricsArgs, readStagingMetrics } from "../scripts/staging-metrics.ts";

const worker = "lookout-staging";
const databaseId = "12345678-1234-1234-1234-123456789012";
const deployed = "f1234567-1234-1234-1234-123456789012";
const previous = "a1234567-1234-1234-1234-123456789012";
const from = "2026-11-23T23:59:00.000Z";
const through = "2026-11-24T00:00:00.000Z";
const now = Date.parse("2026-11-24T00:05:00.000Z");
const auth = { accountId: "abcd".repeat(8), apiToken: "staging-token-for-fixtures" };
const observation = parseStagingMetricsArgs([worker, databaseId, from, through], now);

function invocation(scheduledTime: number | string, cpuTimeMs: number, outcome = "ok", scriptName = worker, versionId = deployed) {
  return {
    dataset: "cloudflare-workers",
    $metadata: { type: "cf-worker-event", service: scriptName, origin: "cron" },
    $workers: { scriptName, eventType: "cron", cpuTimeMs, outcome, event: { scheduledTime }, scriptVersion: { id: versionId } },
    source: { headers: { Authorization: auth.apiToken } },
  };
}

function traced(event: ReturnType<typeof invocation>, traceId: string) {
  return { ...event, $metadata: { ...event.$metadata, traceId } };
}

function probeBatch(traceId: string, cpuTimeMs: number, outcome = "ok", version = deployed) {
  const event = traced(invocation(through, cpuTimeMs, outcome, worker, version), traceId);
  return { ...event, $workers: { ...event.$workers, eventType: "jsrpc", entrypoint: "ProbeBatch", event: {} } };
}

function totals(date: string, rowsRead: number, rowsWritten: number) {
  return { dimensions: { date }, sum: { rowsRead, rowsWritten } };
}

const d1 = {
  data: { viewer: { accounts: [{
    database: [totals("2026-11-23", 100, 400), totals("2026-11-24", 25, 55)],
    account: [totals("2026-11-23", 8321, 1500), totals("2026-11-24", 102, 60)],
  }] } },
};

function logs(events: unknown[], count = events.length) {
  return { success: true, result: {
    run: { dry: true, status: "COMPLETED" },
    statistics: { abr_level: 1 },
    events: { events, count },
  } };
}

function stubCloudflare(workers: unknown, analytics: unknown = d1) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new URL(url).origin, "https://api.cloudflare.com");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${auth.apiToken}`);
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json(url.endsWith("/graphql") ? analytics : workers);
  };
  return { requests, fetcher };
}

test("reads a dry cron query, compares exact minute coverage, and totals both UTC days", async () => {
  const outside = "2026-11-24T00:01:00.000Z";
  const { requests, fetcher } = stubCloudflare(logs([
    invocation(outside, 11),
    invocation(through, 4.5),
    invocation(Date.parse(from), 3.4),
    invocation(from, 98, "exception", "another-worker"),
  ]));
  const result = await readStagingMetrics(observation, auth, { fetch: fetcher, now });

  assert.deepEqual(result.cron, {
    passed: true, coveredMinutes: 2, expectedMinutes: 2, missingMinutes: [],
    expectedVersionId: null, observedVersionIds: [deployed], unexpectedVersionInvocations: 0,
    failedInvocations: 0, maxCpuTimeMs: 4.5, cpuLimitMs: 10,
    invocations: [
      { scheduledAt: from, cpuTimeMs: 3.4, outcome: "ok", versionId: deployed },
      { scheduledAt: through, cpuTimeMs: 4.5, outcome: "ok", versionId: deployed },
    ],
  });
  assert.equal(result.d1.sampling, "adaptive analytics estimates");
  assert.deepEqual(result.d1.days, [
    { date: "2026-11-23", database: { rowsRead: 100, rowsWritten: 400 }, account: { rowsRead: 8321, rowsWritten: 1500 } },
    { date: "2026-11-24", database: { rowsRead: 25, rowsWritten: 55 }, account: { rowsRead: 102, rowsWritten: 60 } },
  ]);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/workers\/observability\/telemetry\/query$/u);
  assert.equal(requests[0].body.dry, true);
  assert.equal(requests[0].body.view, "events");
  assert.deepEqual(requests[0].body.timeframe, { from: Date.parse(from), to: now });
  assert.match(String(requests[1].body.query), /d1AnalyticsAdaptiveGroups/u);
  assert.deepEqual(requests[1].body.variables, { accountTag: auth.accountId, databaseId, from: "2026-11-23", through: "2026-11-24" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(auth.apiToken, "u"));
});

test("flags missing minutes, failed invocations, and CPU time exactly at the limit", async () => {
  const missing = stubCloudflare(logs([invocation(from, 2)]));
  const missingReport = await readStagingMetrics(observation, auth, { fetch: missing.fetcher, now });
  assert.equal(missingReport.cron.passed, false);
  assert.deepEqual(missingReport.cron.missingMinutes, [through]);

  const failed = stubCloudflare(logs([invocation(from, 1, "exception"), invocation(through, 2)]));
  const failedReport = await readStagingMetrics(observation, auth, { fetch: failed.fetcher, now });
  assert.equal(failedReport.cron.passed, false);
  assert.equal(failedReport.cron.failedInvocations, 1);

  const tooSlow = stubCloudflare(logs([invocation(from, 10), invocation(through, 9.9)]));
  const cpuReport = await readStagingMetrics(observation, auth, { fetch: tooSlow.fetcher, now });
  assert.equal(cpuReport.cron.passed, false);
  assert.equal(cpuReport.cron.maxCpuTimeMs, 10);
});

test("normalizes fractional Unix seconds from live Cloudflare cron telemetry", async () => {
  const { fetcher } = stubCloudflare(logs([
    invocation(Date.parse(from) / 1_000 + 32.25, 33),
    invocation(through, 4),
  ]));
  const result = await readStagingMetrics(observation, auth, { fetch: fetcher, now });
  assert.equal(result.cron.coveredMinutes, 2);
  assert.equal(result.cron.maxCpuTimeMs, 33);
  assert.equal(result.cron.passed, false);
});

test("requires complete coverage of the expected deployment without mixed or unknown versions", async () => {
  const versioned = parseStagingMetricsArgs([worker, databaseId, from, through, deployed.toUpperCase()], now);
  const current = [invocation(from, 2), invocation(through, 4)];
  const correct = await readStagingMetrics(versioned, auth, { fetch: stubCloudflare(logs(current)).fetcher, now });
  assert.equal(correct.cron.passed, true);
  assert.equal(correct.cron.expectedVersionId, deployed);
  assert.deepEqual(correct.cron.observedVersionIds, [deployed]);

  const mixedVersion = invocation(from, 19, "ok", worker, previous);
  const mixed = await readStagingMetrics(versioned, auth, {
    fetch: stubCloudflare(logs([...current, mixedVersion])).fetcher, now,
  });
  assert.equal(mixed.cron.passed, false);
  assert.equal(mixed.cron.coveredMinutes, 2);
  assert.equal(mixed.cron.maxCpuTimeMs, 4);
  assert.equal(mixed.cron.unexpectedVersionInvocations, 1);
  assert.deepEqual(mixed.cron.observedVersionIds, [deployed, previous]);

  const unknown = await readStagingMetrics(versioned, auth, {
    fetch: stubCloudflare(logs([current[0], invocation(through, 0, "ok", worker, "")])).fetcher, now,
  });
  assert.equal(unknown.cron.passed, false);
  assert.deepEqual(unknown.cron.missingMinutes, [through]);
  assert.deepEqual(unknown.cron.observedVersionIds, [deployed, null]);
});

test("verifies exact ProbeBatch trace cohorts and reports separate CPU maxima", async () => {
  const first = "fixture-trace-a";
  const last = "fixture-trace-b";
  const batched = parseStagingMetricsArgs([worker, databaseId, from, through, deployed, "2"], now);
  const parents = [traced(invocation(from, 8), first), traced(invocation(through, 7), last)];
  const children = [probeBatch(first, 1), probeBatch(first, 2), probeBatch(last, 3), probeBatch(last, 1)];
  const unrelated = probeBatch("fixture-trace-outside-window", 50, "exception", previous);
  const { fetcher, requests } = stubCloudflare(logs([...parents, ...children, unrelated]));
  const report = await readStagingMetrics(batched, auth, { fetch: fetcher, now });
  assert.equal(report.passed, true);
  assert.equal(report.cron.maxCpuTimeMs, 8);
  assert.equal(report.probeBatch?.correlation, "Cloudflare trace ID");
  assert.equal(report.probeBatch?.observedInvocations, 4);
  assert.equal(report.probeBatch?.maxCpuTimeMs, 3);
  assert.deepEqual(report.probeBatch?.minutes.map((entry) => entry.observedInvocations), [2, 2]);
  assert.doesNotMatch(JSON.stringify(report), /fixture-trace/u);
  assert.doesNotMatch(JSON.stringify(requests[0].body.parameters), /\$metadata\.origin/u);
});

test("fails the batch gate for unbalanced coverage, missing trace identity, wrong version, outcome, and CPU limit", async () => {
  const first = "fixture-trace-a";
  const last = "fixture-trace-b";
  const batched = parseStagingMetricsArgs([worker, databaseId, from, through, deployed, "1"], now);
  const parents = [traced(invocation(from, 3), first), traced(invocation(through, 2), last)];
  const cases = [
    [...parents, probeBatch(first, 1), probeBatch(first, 1)],
    [invocation(from, 3), parents[1], probeBatch(first, 1), probeBatch(last, 1)],
    [...parents, probeBatch(first, 1, "ok", previous), probeBatch(last, 1)],
    [...parents, probeBatch(first, 1, "exception"), probeBatch(last, 1)],
    [...parents, probeBatch(first, 10), probeBatch(last, 1)],
  ];
  for (const events of cases) {
    const { fetcher } = stubCloudflare(logs(events));
    const report = await readStagingMetrics(batched, auth, { fetch: fetcher, now });
    assert.equal(report.cron.passed, true);
    assert.equal(report.probeBatch?.passed, false);
    assert.equal(report.passed, false);
  }
});

test("rejects incomplete telemetry and D1 results", async () => {
  const incomplete = stubCloudflare(logs([invocation(from, 2), invocation(through, 3)], 3));
  await assert.rejects(readStagingMetrics(observation, auth, { fetch: incomplete.fetcher, now }), /sampled or incomplete/u);
  const missingD1 = stubCloudflare(logs([invocation(from, 1), invocation(through, 2)]), { errors: [{ message: auth.apiToken }] });
  await assert.rejects(
    readStagingMetrics(observation, auth, { fetch: missingD1.fetcher, now }),
    { message: "Cloudflare D1 Analytics did not return UTC daily row metrics." },
  );
});

test("requires provisioned identifiers and inclusive UTC minute boundaries", () => {
  assert.equal(parseStagingMetricsArgs([worker, databaseId, "2026-11-23T23:59Z", through], now).from, Date.parse(from));
  assert.throws(() => parseStagingMetricsArgs([worker, databaseId, "2026-11-23T23:59:01Z", through], now), /UTC minute/u);
  assert.throws(() => parseStagingMetricsArgs([worker, databaseId, "2026-02-30T00:00Z", through], now), /UTC minute/u);
  assert.throws(() => parseStagingMetricsArgs([worker, databaseId, through, from], now), /ordered observation window/u);
  assert.throws(
    () => parseStagingMetricsArgs([worker, "00000000-0000-0000-0000-000000000000", from, through], now),
    /provisioned staging D1/u,
  );
  assert.throws(() => parseStagingMetricsArgs([worker, databaseId, from, through, "old"], now), /version UUID/u);
  assert.throws(
    () => parseStagingMetricsArgs([worker, databaseId, from, through, deployed, "0"], now),
    /positive integer/u,
  );
});
