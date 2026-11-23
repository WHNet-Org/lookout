import { DAY_MS, MINUTE_MS, minuteAt } from "../src/model.ts";

const cloudflareApi = "https://api.cloudflare.com/client/v4";
const usage = "Usage: node scripts/staging-metrics.ts <worker> <database-uuid> <from-utc> <through-utc> [expected-version-uuid [batches-per-minute]]";
const maximumCpuMs = 10;
const eventLimit = 2_000;
const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;

const d1MetricsQuery = `
  query StagingD1Metrics($accountTag: string!, $from: Date, $through: Date, $databaseId: string) {
    viewer {
      accounts(filter: {accountTag: $accountTag}) {
        database: d1AnalyticsAdaptiveGroups(
          limit: 2,
          filter: {date_geq: $from, date_leq: $through, databaseId: $databaseId}
        ) {
          dimensions { date }
          sum { rowsRead rowsWritten }
        }
        account: d1AnalyticsAdaptiveGroups(
          limit: 2,
          filter: {date_geq: $from, date_leq: $through}
        ) {
          dimensions { date }
          sum { rowsRead rowsWritten }
        }
      }
    }
  }
`;

interface Observation {
  worker: string;
  databaseId: string;
  from: number;
  through: number;
  expectedVersionId?: string;
  expectedBatchesPerMinute?: number;
}

interface CloudflareAuth {
  accountId: string;
  apiToken: string;
}

interface Invocation {
  scheduledAt: string;
  cpuTimeMs: number;
  outcome: string;
  versionId: string | null;
}

interface WorkersEvent {
  details: Record<string, unknown>;
  traceId: string | undefined;
}

interface ScheduledInvocation {
  invocation: Invocation;
  traceId: string | undefined;
}

function utcMinute(value: string): number {
  const timestamp = Date.parse(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::00(?:\.000)?)?Z$/u.test(value) ||
      !Number.isFinite(timestamp) || timestamp < 0 ||
      new Date(timestamp).toISOString().slice(0, 16) !== value.slice(0, 16)) {
    throw new Error("Use UTC minute boundaries such as 2026-11-23T18:05Z.");
  }
  return timestamp;
}

export function parseStagingMetricsArgs(args: string[], now = Date.now()): Observation {
  if (args.length < 4 || args.length > 6) throw new Error(usage);
  const [worker, databaseId, start, end, expectedVersionId, batches] = args;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/iu.test(worker)) {
    throw new Error("Supply the staging Worker script name.");
  }
  if (!uuidPattern.test(databaseId) ||
      databaseId === "00000000-0000-0000-0000-000000000000") {
    throw new Error("Supply the provisioned staging D1 database UUID.");
  }
  if (expectedVersionId !== undefined && !uuidPattern.test(expectedVersionId)) {
    throw new Error("Supply the expected deployed Worker version UUID.");
  }
  const expectedBatchesPerMinute = batches === undefined ? undefined : Number(batches);
  if (batches !== undefined && (!/^[1-9]\d*$/u.test(batches) || !Number.isSafeInteger(expectedBatchesPerMinute))) {
    throw new Error("The expected number of ProbeBatch calls per minute must be a positive integer.");
  }
  const from = utcMinute(start);
  const through = utcMinute(end);
  if (through < from || through > minuteAt(now) || through - from >= DAY_MS) {
    throw new Error("Choose an ordered observation window of at most 24 hours ending at a current or past UTC minute.");
  }
  return { worker, databaseId, from, through, expectedVersionId: expectedVersionId?.toLowerCase(), expectedBatchesPerMinute };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function scheduledTimeMs(value: unknown): number {
  if (typeof value === "string") return Date.parse(value);
  if (typeof value !== "number") return NaN;
  // Workers Observability emits fractional Unix seconds for some cron events.
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function versionId(details: Record<string, unknown>): string | null {
  const value = object(details.scriptVersion)?.id;
  return typeof value === "string" && uuidPattern.test(value) ? value.toLowerCase() : null;
}

function cpuTime(details: Record<string, unknown>): number | null {
  const value = details.cpuTimeMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function queryCloudflare(
  fetcher: typeof fetch,
  path: string,
  apiToken: string,
  body: object,
  service: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`${cloudflareApi}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`${service} request failed.`);
  }
  if (!response.ok) throw new Error(`${service} returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${service} returned an invalid JSON response.`);
  }
}

function probeBatchReport(
  events: WorkersEvent[],
  parents: ScheduledInvocation[],
  { from, through, expectedVersionId, expectedBatchesPerMinute }: Observation,
) {
  if (expectedBatchesPerMinute === undefined) return undefined;

  const childrenByTrace = new Map<string, Record<string, unknown>[]>();
  for (const { traceId, details } of events) {
    if (!traceId || details.entrypoint !== "ProbeBatch" || details.eventType !== "jsrpc") continue;
    const children = childrenByTrace.get(traceId) ?? [];
    children.push(details);
    childrenByTrace.set(traceId, children);
  }
  const traceCounts = new Map<string, number>();
  for (const { traceId } of parents) {
    if (traceId) traceCounts.set(traceId, (traceCounts.get(traceId) ?? 0) + 1);
  }

  const minutes = [];
  for (let minute = from; minute <= through; minute += MINUTE_MS) {
    const scheduledAt = new Date(minute).toISOString();
    const cohort = parents.filter(({ invocation }) => invocation.scheduledAt === scheduledAt);
    const parent = cohort.length === 1 ? cohort[0] : undefined;
    const traceId = parent?.traceId;
    const hasExpectedParent = !!traceId && traceCounts.get(traceId) === 1 && parent?.invocation.versionId === expectedVersionId;
    const children = hasExpectedParent ? childrenByTrace.get(traceId) ?? [] : [];
    const measurements = children.map(cpuTime).filter((value) => value !== null);
    const maxCpuTimeMs = measurements.length ? Math.max(...measurements) : null;
    const failedInvocations = children.filter(({ outcome }) => outcome !== "ok").length;
    const unexpectedVersionInvocations = children.filter((child) => versionId(child) !== expectedVersionId).length;
    const observedInvocations = children.length;
    minutes.push({
      scheduledAt,
      hasExpectedParent,
      observedInvocations,
      failedInvocations,
      unexpectedVersionInvocations,
      maxCpuTimeMs,
      passed: hasExpectedParent && observedInvocations === expectedBatchesPerMinute &&
        failedInvocations === 0 && unexpectedVersionInvocations === 0 && measurements.length === observedInvocations &&
        maxCpuTimeMs !== null && maxCpuTimeMs < maximumCpuMs,
    });
  }
  const maxima = minutes.map(({ maxCpuTimeMs }) => maxCpuTimeMs).filter((value) => value !== null);
  return {
    passed: minutes.every(({ passed }) => passed),
    correlation: "Cloudflare trace ID",
    expectedPerMinute: expectedBatchesPerMinute,
    expectedInvocations: minutes.length * expectedBatchesPerMinute,
    observedInvocations: minutes.reduce((total, value) => total + value.observedInvocations, 0),
    maxCpuTimeMs: maxima.length ? Math.max(...maxima) : null,
    cpuLimitMs: maximumCpuMs,
    minutes,
  };
}

function workerReport(payload: unknown, observation: Observation) {
  const { worker, from, through, expectedVersionId } = observation;
  const envelope = object(payload);
  const result = object(envelope?.result);
  const run = object(result?.run);
  const matches = object(result?.events);
  if (envelope?.success !== true || run?.status !== "COMPLETED" || run.dry !== true ||
      !Array.isArray(matches?.events)) {
    throw new Error("Cloudflare did not return a completed dry Workers Observability query.");
  }
  const abr = object(result?.statistics)?.abr_level;
  if ((abr !== undefined && abr !== 1) || matches.events.length >= eventLimit ||
      (matches.count !== undefined && matches.count !== matches.events.length)) {
    throw new Error("Workers Observability returned sampled or incomplete invocation events.");
  }
  if (Array.isArray(matches.series) && matches.series.some((series) => {
    const data = object(series)?.data;
    return Array.isArray(data) && data.some((point) => Number(object(point)?.sampleInterval) > 1);
  })) {
    throw new Error("Workers Observability returned sampled invocation events.");
  }

  const events: WorkersEvent[] = matches.events.flatMap((row) => {
    const event = object(row);
    const source = object(event?.source);
    const details = object(event?.$workers) ?? object(source?.$workers);
    if (details?.scriptName !== worker) return [];
    const traceId = (object(event?.$metadata) ?? object(source?.$metadata))?.traceId;
    return [{ details, traceId: typeof traceId === "string" && traceId ? traceId : undefined }];
  });

  const coverage = new Set<number>();
  const parents: ScheduledInvocation[] = [];
  for (const { details, traceId } of events) {
    if (details.eventType !== "scheduled" && details.eventType !== "cron") continue;
    const scheduledAt = scheduledTimeMs(object(details.event)?.scheduledTime);
    if (!Number.isFinite(scheduledAt) || scheduledAt < 0) {
      throw new Error("A scheduled invocation has no valid Cloudflare scheduled time.");
    }
    const minute = minuteAt(scheduledAt);
    if (minute < from || minute > through) continue;
    const cpuTimeMs = cpuTime(details);
    const { outcome } = details;
    if (cpuTimeMs === null || typeof outcome !== "string") {
      throw new Error("A scheduled invocation in the window lacks CPU or outcome telemetry.");
    }
    const reportedOutcome = ["ok", "exceededCpu", "exceededMemory", "exception", "canceled"].includes(outcome)
      ? outcome : "otherFailure";
    const deployed = versionId(details);
    if (!expectedVersionId || expectedVersionId === deployed) coverage.add(minute);
    parents.push({
      traceId,
      invocation: { scheduledAt: new Date(minute).toISOString(), cpuTimeMs, outcome: reportedOutcome, versionId: deployed },
    });
  }
  const invocations = parents.map(({ invocation }) => invocation).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const missingMinutes: string[] = [];
  for (let minute = from; minute <= through; minute += MINUTE_MS) {
    if (!coverage.has(minute)) missingMinutes.push(new Date(minute).toISOString());
  }
  const observedVersionIds = [...new Set(invocations.map(({ versionId }) => versionId))];
  const expected = expectedVersionId ? invocations.filter(({ versionId }) => versionId === expectedVersionId) : invocations;
  const unexpectedVersionInvocations = invocations.length - expected.length;
  const maxCpuTimeMs = expected.length ? Math.max(...expected.map((item) => item.cpuTimeMs)) : null;
  const failedInvocations = expected.filter(({ outcome }) => outcome !== "ok").length;
  const cron = {
    passed: missingMinutes.length === 0 && failedInvocations === 0 && unexpectedVersionInvocations === 0 &&
      maxCpuTimeMs !== null && maxCpuTimeMs < maximumCpuMs,
    coveredMinutes: coverage.size,
    expectedMinutes: (through - from) / MINUTE_MS + 1,
    expectedVersionId: expectedVersionId ?? null,
    observedVersionIds,
    unexpectedVersionInvocations,
    missingMinutes,
    failedInvocations,
    maxCpuTimeMs,
    cpuLimitMs: maximumCpuMs,
    invocations,
  };
  const probeBatch = probeBatchReport(events, parents, observation);
  return { passed: cron.passed && (probeBatch?.passed ?? true), cron, probeBatch };
}

function dateAt(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function rowTotals(rows: unknown[], date: string) {
  const matching = rows.filter((row) => object(object(row)?.dimensions)?.date === date);
  const sum = object(object(matching[0])?.sum);
  const { rowsRead, rowsWritten } = sum ?? {};
  if (matching.length !== 1 || typeof rowsRead !== "number" || !Number.isFinite(rowsRead) || rowsRead < 0 ||
      typeof rowsWritten !== "number" || !Number.isFinite(rowsWritten) || rowsWritten < 0) {
    throw new Error(`Cloudflare D1 metrics for UTC day ${date} are missing or invalid.`);
  }
  return { rowsRead, rowsWritten };
}

function d1Report(payload: unknown, from: number, through: number) {
  const envelope = object(payload);
  const accounts = object(object(envelope?.data)?.viewer)?.accounts;
  const account = Array.isArray(accounts) && accounts.length === 1 ? object(accounts[0]) : undefined;
  if ((Array.isArray(envelope?.errors) && envelope.errors.length > 0) ||
      !Array.isArray(account?.account) || !Array.isArray(account?.database)) {
    throw new Error("Cloudflare D1 Analytics did not return UTC daily row metrics.");
  }
  const days = [];
  for (let time = from - from % DAY_MS; time <= through; time += DAY_MS) {
    const date = dateAt(time);
    days.push({ date, database: rowTotals(account.database, date), account: rowTotals(account.account, date) });
  }
  return { period: "UTC day", sampling: "adaptive analytics estimates", days };
}

export async function readStagingMetrics(
  observation: Observation,
  { accountId, apiToken }: CloudflareAuth,
  { fetch: fetcher = fetch, now = Date.now() }: { fetch?: typeof fetch; now?: number } = {},
) {
  if (!/^[\da-f]{32}$/iu.test(accountId) || !apiToken.trim()) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for the staging account.");
  }
  const { worker, databaseId, from, through } = observation;
  const filter = (key: string, value: string, operation = "eq") => ({
    key, value, operation, type: "string",
  });
  const filters = [filter("$metadata.service", worker), filter("$metadata.type", "cf-worker-event")];
  if (observation.expectedBatchesPerMinute === undefined) filters.push(filter("$metadata.origin", "cron,scheduled", "in"));
  const [workers, d1] = await Promise.all([
    queryCloudflare(fetcher, `/accounts/${accountId}/workers/observability/telemetry/query`, apiToken, {
      queryId: "lookout-staging-cron",
      timeframe: { from, to: Math.min(through + 16 * MINUTE_MS, now) },
      dry: true,
      limit: eventLimit,
      view: "events",
      parameters: { datasets: ["cloudflare-workers"], filters },
    }, "Workers Observability"),
    queryCloudflare(fetcher, "/graphql", apiToken, {
      query: d1MetricsQuery,
      variables: { accountTag: accountId, from: dateAt(from), through: dateAt(through), databaseId },
    }, "D1 Analytics"),
  ]);
  return {
    worker,
    databaseId,
    from: new Date(from).toISOString(),
    through: new Date(through).toISOString(),
    ...workerReport(workers, observation),
    d1: d1Report(d1, from, through),
  };
}

if (import.meta.main) {
  try {
    const report = await readStagingMetrics(parseStagingMetricsArgs(process.argv.slice(2)), {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not verify staging metrics.");
    process.exitCode = 1;
  }
}
