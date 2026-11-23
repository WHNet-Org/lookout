import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { stagingCascadeQuery, stagingRunsQuery, verifyStagingCascade, verifyStagingRuns } from "../scripts/staging-check.ts";
import { MINUTE_MS, minuteAt } from "../src/model.ts";
import { migrateSqlite } from "../src/sqlite.ts";
import { prepareDeliveries } from "../src/webhook.ts";
import type { AlertEvent } from "../src/model.ts";

test("staging check verifies a fresh, consecutive D1 sample of twenty observations per minute", () => {
  const database = new DatabaseSync(":memory:");
  try {
    migrateSqlite(database);
    const now = minuteAt(Date.UTC(2026, 10, 23, 12, 30));
    const observations = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`check-${index}`, { ok: true, latencyMs: 3, httpCode: 200 }]),
    );
    const insert = database.prepare(
      "INSERT INTO runs (scheduled_at, results, alert_states, group_states, deliveries) VALUES (?, ?, '{}', '{}', '[]')",
    );
    for (let minute = 15; minute >= 1; minute--) {
      insert.run(now - minute * MINUTE_MS, JSON.stringify(observations));
    }
    const rows = database.prepare(stagingRunsQuery).all() as { scheduled_at: number; checks: number }[];
    assert.deepEqual(verifyStagingRuns(rows, now), {
      from: new Date(now - 15 * MINUTE_MS).toISOString(),
      through: new Date(now - MINUTE_MS).toISOString(),
    });
    assert.throws(() => verifyStagingRuns(rows, now + 2 * MINUTE_MS), /fresh UTC minute/u);
    assert.throws(() => verifyStagingRuns(rows.slice(0, -1), now), /Expected 15 stored minutes/u);
    assert.throws(() => verifyStagingRuns(rows.with(5, rows[6]), now), /Expected one stored run/u);
    assert.throws(() => verifyStagingRuns(rows.with(5, { ...rows[5], checks: 19 }), now), /Expected 20 observations/u);
  } finally {
    database.close();
  }
});

test("staging receipt query verifies the cascade and the two linked recoveries", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE webhook_receipts (delivery_id TEXT PRIMARY KEY, scheduled_at INTEGER, received_at INTEGER, body TEXT)");
    const insert = database.prepare("INSERT INTO webhook_receipts VALUES (?, ?, ?, ?)");
    const edge = { id: "edge", name: "Edge" };
    const application = { id: "application", name: "Application" };
    const result = { ok: false, latencyMs: 2, httpCode: 503 };
    const start = Date.UTC(2026, 10, 23, 12, 30);
    const through = start + 4 * MINUTE_MS;
    const batches: AlertEvent[][] = [[
      { kind: "outage", incidentId: "edge-incident", check: edge, result, affected: [application] },
    ], [
      { kind: "recovery", incidentId: "edge-incident", check: edge, result, affected: [] },
      { kind: "outage", incidentId: "application-incident", check: application, result, affected: [] },
    ], [
      { kind: "recovery", incidentId: "application-incident", check: application, result, affected: [] },
    ]];
    const expectedDeliveries = batches.map((events, index) => {
      const at = start + index * 2 * MINUTE_MS;
      const [delivery] = prepareDeliveries("json", at, events);
      insert.run(delivery.id, at, at, delivery.body);
      return delivery.id;
    });
    const query = stagingCascadeQuery(new Date(start).toISOString(), new Date(through).toISOString());
    const events = database.prepare(query).all() as unknown as Parameters<typeof verifyStagingCascade>[0];
    assert.deepEqual(verifyStagingCascade(events), expectedDeliveries);
    assert.throws(() => verifyStagingCascade(events.with(0, { ...events[0], affected_application: 0 })),
      /application impact/u);
    assert.throws(() => verifyStagingCascade(events.with(3, { ...events[3], incident_id: "other" })),
      /incident lifecycles/u);
  } finally {
    database.close();
  }
});
