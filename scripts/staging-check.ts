import { spawnSync } from "node:child_process";
import { MINUTE_MS, minuteAt } from "../src/model.ts";

const CHECKS = 20;
const RUNS = 15;

export const stagingRunsQuery = `
  SELECT scheduled_at, (SELECT count(*) FROM json_each(results)) AS checks
  FROM runs
  ORDER BY scheduled_at DESC
  LIMIT ${RUNS}
`;

interface RunSummary {
  scheduled_at: number;
  checks: number;
}

interface CascadeEvent {
  delivery_id: string;
  scheduled_at: number;
  kind: "outage" | "impact" | "recovery";
  check_id: string;
  incident_id: string;
  affected_application: number;
}

export function verifyStagingRuns(rows: RunSummary[], now = Date.now()) {
  if (rows.length !== RUNS) throw new Error(`Expected ${RUNS} stored minutes, found ${rows.length}.`);
  const newest = rows[0].scheduled_at;
  const newestAllowed = minuteAt(now);
  if (!Number.isSafeInteger(newest) || newest % MINUTE_MS !== 0 ||
      newest > newestAllowed || newestAllowed - newest >= 3 * MINUTE_MS) {
    throw new Error("The latest stored run must be a fresh UTC minute.");
  }
  for (const [index, row] of rows.entries()) {
    const expected = newest - index * MINUTE_MS;
    const timestamp = new Date(expected).toISOString();
    if (row.scheduled_at !== expected) throw new Error(`Expected one stored run at ${timestamp}.`);
    if (row.checks !== CHECKS) throw new Error(`Expected ${CHECKS} observations at ${timestamp}, found ${row.checks}.`);
  }
  return { from: new Date(rows.at(-1)!.scheduled_at).toISOString(), through: new Date(newest).toISOString() };
}

export function stagingCascadeQuery(from: string, through: string): string {
  const start = Date.parse(from);
  const end = Date.parse(through);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
    throw new Error("Invalid staging cascade window.");
  }
  return `
    SELECT receipt.delivery_id, receipt.scheduled_at, event.value ->> '$.kind' AS kind,
           event.value ->> '$.check.id' AS check_id, event.value ->> '$.incidentId' AS incident_id,
           EXISTS (
             SELECT 1 FROM json_each(event.value, '$.affected') AS affected
             WHERE affected.value ->> '$.id' = 'application'
           ) AS affected_application
    FROM webhook_receipts AS receipt
    CROSS JOIN json_each(receipt.body, '$.events') AS event
    WHERE receipt.scheduled_at BETWEEN ${start} AND ${end}
      AND event.value ->> '$.check.id' IN ('edge', 'application')
    ORDER BY receipt.scheduled_at, receipt.delivery_id, event.key
  `;
}

export function verifyStagingCascade(events: CascadeEvent[]): string[] {
  const [edgeOutage, edgeRecovery, appOutage, appRecovery] = events;
  if (events.length !== 4 ||
      edgeOutage.check_id !== "edge" || edgeOutage.kind !== "outage" || edgeOutage.affected_application !== 1 ||
      edgeRecovery.check_id !== "edge" || edgeRecovery.kind !== "recovery" ||
      appOutage.check_id !== "application" || appOutage.kind !== "outage" ||
      appRecovery.check_id !== "application" || appRecovery.kind !== "recovery") {
    throw new Error("Expected an edge outage reporting application impact, edge recovery, then an application outage and recovery.");
  }
  if (!edgeOutage.incident_id || !appOutage.incident_id || edgeOutage.incident_id === appOutage.incident_id ||
      edgeRecovery.incident_id !== edgeOutage.incident_id || appRecovery.incident_id !== appOutage.incident_id ||
      edgeRecovery.scheduled_at <= edgeOutage.scheduled_at || appOutage.scheduled_at < edgeRecovery.scheduled_at ||
      appRecovery.scheduled_at <= appOutage.scheduled_at) {
    throw new Error("Staging webhook receipts do not form two ordered incident lifecycles.");
  }
  return Array.from(new Set(events.map((event) => event.delivery_id)));
}

function executeD1<Row>(database: string, sql: string): Row[] {
  const query = spawnSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "d1", "execute", database,
    "--remote", "--json", "--command", sql,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (query.status !== 0) throw new Error("Could not read the staging D1 database.");
  const results = JSON.parse(query.stdout);
  if (!Array.isArray(results) || results.length !== 1 || results[0]?.success !== true ||
      !Array.isArray(results[0].results)) {
    throw new Error("Wrangler returned an unexpected D1 query response.");
  }
  return results[0].results;
}

if (import.meta.main) {
  const [database, fixtureDatabase, ...extra] = process.argv.slice(2);
  if (!database || database.startsWith("-") || fixtureDatabase?.startsWith("-") || extra.length) {
    throw new Error("Usage: npm run verify:staging -- <staging-database-name> [fixture-database-name]");
  }
  const { from, through } = verifyStagingRuns(executeD1<RunSummary>(database, stagingRunsQuery));
  console.log(`Verified ${RUNS} consecutive staging minutes with ${CHECKS} observations each, from ${from} through ${through}.`);
  if (fixtureDatabase) {
    const deliveries = verifyStagingCascade(executeD1<CascadeEvent>(fixtureDatabase, stagingCascadeQuery(from, through)));
    console.log(`Verified staging cascade and both recovery lifecycles in deliveries ${deliveries.join(", ")}.`);
  }
}
