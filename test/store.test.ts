import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DAY_MS, MINUTE_MS } from "../src/model.ts";
import type { AlertEvent, GroupState, ProbeResult, Run } from "../src/model.ts";
import { migrateSqlite, sqliteDatabase } from "../src/sqlite.ts";
import { createStore } from "../src/store.ts";
import { deliverQueued, prepareDeliveries } from "../src/webhook.ts";

const day = Date.UTC(2026, 10, 23);
const check = { id: "site", name: "Public website" };
const up = { ok: true, latencyMs: 12, httpCode: 204 };
const down = { ok: false, latencyMs: 340, httpCode: 503, reason: "unexpected_status" };

function run(scheduledAt: number, result: ProbeResult, group: GroupState): Run {
  return {
    scheduledAt,
    results: { [check.id]: result },
    alertStates: {},
    groupStates: { whnet: group },
  };
}

function storeAt(database: DatabaseSync) {
  migrateSqlite(database);
  return createStore(sqliteDatabase(database));
}

test("commits observations, rollups, and deliveries together only for the newest minute", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const store = storeAt(database);
  const delivery = { id: "first-alert", body: "{}" };
  const first = run(day, down, "outage");
  const second = run(day + 2 * MINUTE_MS, up, "operational");

  assert.equal(await store.commit(first, null, [delivery]), true);
  assert.equal(await store.commit(first, null, []), false);
  await assert.rejects(store.commit(second, day, [delivery]), /UNIQUE/);
  assert.deepEqual(await store.latest(), first);
  assert.equal(await store.commit(second, day, []), true);
  assert.equal(await store.commit(run(day + MINUTE_MS, down, "outage"), second.scheduledAt, []), false);
  assert.equal(await store.commit(run(day + 3 * MINUTE_MS, down, "degraded"), day, []), false);

  assert.deepEqual(await store.latest(), second);
  assert.deepEqual(await store.daily("check", [check.id], day), [
    { id: check.id, day, observed: 2, up: 1, latencySum: up.latencyMs },
  ]);
  assert.deepEqual(await store.daily("group", ["whnet"], day), [
    { id: "whnet", day, observed: 2, up: 1, latencySum: null },
  ]);
  assert.deepEqual(await store.history(check.id, day, day + 3 * MINUTE_MS), [
    { scheduledAt: second.scheduledAt, result: up },
    { scheduledAt: first.scheduledAt, result: down },
  ]);
  assert.equal((await store.claimDelivery(day + 2 * MINUTE_MS))?.id, delivery.id);
});

test("prunes old observations, daily rollups, and webhook deliveries", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const store = storeAt(database);
  await store.commit(run(day, down, "outage"), null, [{ id: "old-alert", body: "{}" }]);
  const end = day + 14 * DAY_MS;
  await store.commit(run(end, up, "unknown"), day, []);
  assert.deepEqual(await store.history(check.id, day, end), []);
  assert.deepEqual(await store.daily("group", ["whnet"], day), []);
  assert.deepEqual(await store.daily("check", [check.id], day), [
    { id: check.id, day: end, observed: 1, up: 1, latencySum: up.latencyMs },
  ]);
  assert.equal(await store.claimDelivery(end), null);
  assert.equal(database.prepare("SELECT count(*) AS num FROM webhook_queue").get()?.num, 0);
});

test("leases persist after reopening SQLite and a recovered attempt owns completion", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lookout-store-"));
  const path = join(directory, "lookout.sqlite");
  let database: DatabaseSync | undefined = new DatabaseSync(path);
  t.after(() => {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const firstStore = storeAt(database);
  await firstStore.commit(run(day, down, "outage"), null, [
    { id: "alert-a", body: "{}" },
    { id: "alert-b", body: "{}" },
  ]);
  const firstClaim = await firstStore.claimDelivery(day);
  database.close();
  database = undefined;
  assert.ok(firstClaim);

  database = new DatabaseSync(path);
  const nextStore = storeAt(database);
  assert.equal(await nextStore.claimDelivery(day + 29_000), null);
  const secondClaim = await nextStore.claimDelivery(day + 30_000);
  assert.ok(secondClaim);
  assert.equal(secondClaim.id, firstClaim.id);
  assert.equal(secondClaim.attempts, 2);
  await nextStore.completeDelivery(firstClaim);
  assert.equal(database.prepare("SELECT attempts FROM webhook_queue WHERE id = ?").get(firstClaim.id)?.attempts, 2);
  await nextStore.completeDelivery(secondClaim);
  assert.equal((await nextStore.claimDelivery(day + MINUTE_MS))?.id, "alert-b");
});

test("retries the oldest alert first, honors Retry-After, and limits attempts and sends", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const store = storeAt(database);
  await store.commit(run(day, down, "outage"), null, [
    { id: "alert-a", body: "{}" },
    { id: "alert-b", body: "{}" },
    { id: "alert-c", body: "{}" },
  ]);

  let now = day;
  const sent: string[] = [];
  const options = {
    now: () => now,
    log: () => {},
    fetch: (async (_url, init) => {
      const id = new Headers(init?.headers).get("Idempotency-Key") ?? "";
      const previousAttempts = sent.filter((sentId) => sentId === id).length;
      sent.push(id);
      if (id !== "alert-a") return new Response(null, { status: 204 });
      if (previousAttempts === 0) return new Response(null, { status: 429, headers: { "Retry-After": "90" } });
      if (previousAttempts === 1) throw new Error("connection lost");
      return new Response(null, { status: 503 });
    }) satisfies typeof fetch,
  };

  await deliverQueued(store, "https://example.invalid/", options);
  now += MINUTE_MS;
  await store.commit(run(now, up, "operational"), day, [{ id: "recovery", body: "{}" }]);
  await deliverQueued(store, "https://example.invalid/", options);
  assert.deepEqual(sent, ["alert-a"]);

  now += MINUTE_MS;
  await deliverQueued(store, "https://example.invalid/", options);
  assert.deepEqual(sent, ["alert-a", "alert-a"]);
  now += 2 * MINUTE_MS;
  await deliverQueued(store, "https://example.invalid/", options);
  assert.deepEqual(sent, ["alert-a", "alert-a", "alert-a", "alert-b"]);
  now += MINUTE_MS;
  await deliverQueued(store, "https://example.invalid/", options);
  assert.deepEqual(sent, ["alert-a", "alert-a", "alert-a", "alert-b", "alert-c", "recovery"]);
  assert.equal(database.prepare("SELECT count(*) AS num FROM webhook_queue").get()?.num, 0);
});

test("keeps stable JSON IDs and splits Discord impact into bounded messages", () => {
  const event: AlertEvent = {
    kind: "impact",
    incidentId: "upstream-incident",
    check,
    result: down,
    affected: Array.from({ length: 24 }, (_, index) => ({
      id: `dependent-${index}`,
      name: `Dependent ${index + 1} ${"z".repeat(100)}`,
    })),
  };
  const json = prepareDeliveries("json", day, [event]);
  assert.equal(json.length, 1);
  assert.deepEqual(JSON.parse(json[0].body), {
    delivery_id: json[0].id,
    scheduled_at: new Date(day).toISOString(),
    events: [event],
  });

  const discord = prepareDeliveries("discord", day, [event]);
  assert.ok(discord.length > 1);
  assert.deepEqual(prepareDeliveries("discord", day, [event]), discord);
  const messages = discord.map(({ body }) => JSON.parse(body));
  for (const message of messages) {
    assert.ok(message.content.length <= 2_000);
    assert.match(message.content, /New impact · Public website/);
    assert.deepEqual(message.allowed_mentions, { parse: [] });
  }
  assert.equal(messages.flatMap(({ content }) => content.match(/• Dependent /g) ?? []).length, event.affected.length);
});
