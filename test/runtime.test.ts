import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validateConfig } from "../src/config.ts";
import { MINUTE_MS, minuteAt } from "../src/model.ts";
import type { AlertEvent } from "../src/model.ts";
import { createScheduler } from "../src/scheduler.ts";
import { migrateSqlite, sqliteDatabase } from "../src/sqlite.ts";
import { createStore } from "../src/store.ts";
import { eventually, fixtureConfig, fixtureServer, launch } from "./support.ts";

test("standalone entry runs twenty checks, sends one cascade, and keeps state on restart", async () => {
  const fixture = await fixtureServer();
  const directory = mkdtempSync(join(tmpdir(), "lookout-node-"));
  const path = join(directory, "monitors.json");
  const dbPath = join(directory, "lookout.sqlite");
  writeFileSync(path, JSON.stringify(fixtureConfig(fixture.origin, fixture.port)));
  const env = {
    ...process.env,
    PORT: "0",
    LOOKOUT_CONFIG: path,
    LOOKOUT_DB: dbPath,
    LOOKOUT_TRUST_PROXY: "1",
    LOOKOUT_PRIVATE_USER: "test-operator",
    LOOKOUT_PRIVATE_PASSWORD: "test-password",
    LOOKOUT_WEBHOOK_URL: `${fixture.origin}/webhook`,
  };
  let server = launch(process.execPath, ["src/node.ts"], { env });
  try {
    let [, port] = await server.match(/Lookout listening on 127\.0\.0\.1:(\d+)/u);
    let origin = `http://127.0.0.1:${port}`;
    assert(await eventually(() => fixture.deliveries.length === 1));
    const body = fixture.deliveries[0] as { events?: { kind: string; check: { id: string }; affected: { id: string }[] }[] };
    assert.equal(body.events?.length, 1);
    assert.equal(body.events?.[0].kind, "outage");
    assert.equal(body.events?.[0].check.id, "edge");
    assert.deepEqual(body.events?.[0].affected.map(({ id }) => id), ["application"]);
    assert.equal(fixture.observations.length, 19);

    const summary = await fetch(`${origin}/api/status?group=whnet`, { headers: { Origin: "https://whnet.ca" } });
    assert.equal(summary.headers.get("access-control-allow-origin"), "https://whnet.ca");
    assert.deepEqual(await summary.json(), { status: "degraded", online: false });

    const root = await (await fetch(origin)).text();
    assert.match(root, /Upstream check also failing/u);
    assert.doesNotMatch(root, /Internal listener|hidden-listener/u);
    assert.equal((await fetch(`${origin}/monitors/hidden-listener`)).status, 404);
    assert.equal((await fetch(`${origin}/assets/lookout.svg`)).headers.get("content-type"), "image/svg+xml");
    const headers = { Authorization: "Basic " + Buffer.from("test-operator:test-password").toString("base64") };
    assert.notEqual((await fetch(`${origin}/private`, { headers })).status, 200);
    const privatePage = await fetch(`${origin}/private`, { headers: { ...headers, "X-Forwarded-Proto": "https" } });
    assert.equal(privatePage.status, 200);
    assert.match(await privatePage.text(), /Internal listener/u);

    await server.stop();
    let database = new DatabaseSync(dbPath, { readOnly: true });
    const before = database.prepare("SELECT scheduled_at FROM runs ORDER BY scheduled_at").all();
    assert(before.length > 0);
    database.close();

    fixture.state.cascade = false;
    server = launch(process.execPath, ["src/node.ts"], { env });
    [, port] = await server.match(/Lookout listening on 127\.0\.0\.1:(\d+)/u);
    origin = `http://127.0.0.1:${port}`;
    const history = await (await fetch(`${origin}/monitors/application`)).text();
    assert.match(history, /503/u);
    database = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(database.prepare("SELECT scheduled_at FROM runs ORDER BY scheduled_at").all().slice(0, before.length), before);
    database.close();
  } finally {
    await server.stop();
    await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function webhookFixture(database: DatabaseSync, webhookEnabled = true) {
  migrateSqlite(database);
  const store = createStore(sqliteDatabase(database));
  const config = validateConfig({
    checks: [{ type: "http", id: "service", name: "Service", url: "https://probe.example" }],
    alert: { threshold: 1 },
    webhook: webhookEnabled ? { format: "json", urlSecret: "WEBHOOK" } : undefined,
  });
  const sent: { scheduled_at: string; events: AlertEvent[] }[] = [];
  const state = { now: minuteAt(Date.now()), secret: undefined as string | undefined, status: 503 };
  const run = createScheduler({
    config,
    store,
    fetch: async (_url, init) => {
      if (init?.method !== "POST") return new Response(null, { status: state.status });
      sent.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    },
    connectTcp: async () => {},
    getSecret: () => state.secret,
    now: () => state.now,
    log: () => {},
  });
  return { store, state, sent, run };
}

test("dispatches the original queued outage after the configured secret becomes available", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const { store, state, sent, run } = webhookFixture(database);
  const start = state.now;
  await run(state.now);
  assert.equal(sent.length, 0);
  const incident = (await store.latest())?.alertStates.service.incidentId;
  assert.ok(incident);

  state.secret = "https://webhook.example";
  state.now += MINUTE_MS;
  await run(state.now);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].scheduled_at, new Date(start).toISOString());
  assert.deepEqual(sent[0].events.map(({ kind, incidentId }) => [kind, incidentId]), [["outage", incident]]);
});

test("preserves an open outage and delivers its recovery after a temporary secret loss", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const { store, state, sent, run } = webhookFixture(database);
  const secret = "https://webhook.example";
  state.secret = secret;
  await run(state.now);
  assert.equal(sent.length, 1);
  const incident = sent[0].events[0].incidentId;

  state.secret = "invalid";
  state.now += MINUTE_MS;
  await run(state.now);
  assert.equal(sent.length, 1);
  assert.equal((await store.latest())?.alertStates.service.incidentId, incident);

  state.status = 200;
  state.now += MINUTE_MS;
  const recoveredAt = state.now;
  await run(state.now);
  assert.equal(sent.length, 1);
  assert.equal((await store.latest())?.alertStates.service.incidentId, undefined);

  state.secret = secret;
  state.now += MINUTE_MS;
  await run(state.now);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].scheduled_at, new Date(recoveredAt).toISOString());
  assert.deepEqual(sent[1].events.map(({ kind, incidentId }) => [kind, incidentId]), [["recovery", incident]]);
});

test("does not queue alerts when the config omits a webhook", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const { store, state, sent, run } = webhookFixture(database, false);
  state.secret = "https://webhook.example";
  await run(state.now);
  assert.equal(sent.length, 0);
  assert.deepEqual((await store.latest())?.alertStates, {});
  assert.equal(database.prepare("SELECT count(*) AS count FROM webhook_queue").get()?.count, 0);
});
