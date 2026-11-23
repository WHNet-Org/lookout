import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { writeStagingFiles } from "../scripts/prepare-staging.ts";
import worker, { fixtureHealthIds, fixtureSchema, fixtureTokenName, markerRegex } from "../scripts/staging-fixture.ts";
import type { FixtureEnv } from "../scripts/staging-fixture.ts";
import { compileBodyRegex } from "../src/config.ts";
import type { Config } from "../src/model.ts";

const fixtureOrigin = "https://fixture.example.com";
const secret = "staging-fixture-test-token";
const stagingEnv = {
  LOOKOUT_STAGING_WORKER_NAME: "lookout-staging",
  LOOKOUT_STAGING_D1_DATABASE_NAME: "lookout-staging-data",
  LOOKOUT_STAGING_D1_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
  LOOKOUT_FIXTURE_WORKER_NAME: "lookout-fixture",
  LOOKOUT_FIXTURE_URL: fixtureOrigin,
  LOOKOUT_STAGING_TCP_HOST: "gateway.example.com",
  LOOKOUT_STAGING_TCP_PORT: "443",
  LOOKOUT_FIXTURE_TOKEN: secret,
  LOOKOUT_WEBHOOK_URL: `${fixtureOrigin}/webhook?token=${secret}`,
};

function envFor(database: DatabaseSync, token?: string): FixtureEnv {
  function prepare(sql: string, values: (string | number)[] = []) {
    const statement = database.prepare(sql);
    return {
      bind: (...parameters: (string | number)[]) => prepare(sql, parameters),
      first: async <T>(column: string) => (statement.get(...values)?.[column] ?? null) as T | null,
      run: async () => statement.run(...values),
    };
  }
  database.exec(fixtureSchema);
  return { DB: { prepare }, LOOKOUT_FIXTURE_TOKEN: token };
}

function getHealth(id: string, token?: string): Request {
  return new Request(`${fixtureOrigin}/health/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

test("fixture exposes nineteen auth-gated marker bodies and SQL-controlled failure modes", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const env = envFor(database, secret);
  const noToken = envFor(database);
  assert.equal((await worker.fetch(getHealth("edge", secret), noToken)).status, 404);
  assert.equal((await worker.fetch(getHealth("edge"), env)).status, 404);
  assert.equal((await worker.fetch(getHealth("service-18", secret), env)).status, 404);
  assert.equal(fixtureHealthIds.length, 19);
  for (const id of fixtureHealthIds) {
    const response = await worker.fetch(getHealth(id, secret), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.text();
    assert.equal(JSON.parse(body).status, "ok");
    assert.equal(compileBodyRegex(markerRegex).test(body), true);
    if (id.startsWith("service-")) assert.equal(Buffer.byteLength(body), 16 * 1024);
  }
  assert.equal((await worker.fetch(new Request(`${fixtureOrigin}/mode`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}` },
  }), env)).status, 404);
  database.exec("UPDATE fixture_control SET mode = 'cascade' WHERE id = 1");
  assert.equal((await worker.fetch(getHealth("edge", secret), env)).status, 503);
  assert.equal((await worker.fetch(getHealth("application", secret), env)).status, 503);
  assert.equal((await worker.fetch(getHealth("service-1", secret), env)).status, 200);
  database.exec("UPDATE fixture_control SET mode = 'dependent' WHERE id = 1");
  assert.equal((await worker.fetch(getHealth("edge", secret), env)).status, 200);
  assert.equal((await worker.fetch(getHealth("application", secret), env)).status, 503);
});

test("fixture records standard authenticated webhook receipts once and rejects untrusted requests", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const env = envFor(database, secret);
  const scheduledAt = Date.UTC(2026, 10, 23, 13, 30);
  const id = `lookout-json-${scheduledAt}`;
  const json = JSON.stringify({
    delivery_id: id,
    scheduled_at: new Date(scheduledAt).toISOString(),
    events: [{ kind: "outage", check: { id: "edge" }, affected: [{ id: "application" }] }],
  });
  function post(token: string, key: string, body: string) {
    return worker.fetch(new Request(`${fixtureOrigin}/webhook?token=${encodeURIComponent(token)}`, {
      method: "POST", headers: { "Idempotency-Key": key }, body,
    }), env);
  }
  assert.equal((await post("wrong", id, json)).status, 404);
  assert.equal((await post(secret, `${id}0`, json)).status, 400);
  assert.equal((await post(secret, id, "x".repeat(65_537))).status, 413);
  assert.equal((await post(secret, id, json)).status, 204);
  assert.equal((await post(secret, id, json)).status, 204);
  const receipts = database.prepare("SELECT delivery_id, scheduled_at, body FROM webhook_receipts").all();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].delivery_id, id);
  assert.equal(receipts[0].scheduled_at, scheduledAt);
  assert.equal(receipts[0].body, json);
});

test("generator isolates both Workers, supports one or two D1 databases, and writes no secret values", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lookout-staging-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  writeFileSync(join(directory, "wrangler.jsonc"), wrangler);
  const generated = writeStagingFiles(directory, stagingEnv);
  const contents = (name: string) => readFileSync(join(generated, name), "utf8");
  for (const file of ["fixture.sql", "fixture.ts", "lookout.ts", "monitors.json", "wrangler.lookout.json", "wrangler.fixture.json"]) {
    assert.equal(contents(file).includes(secret), false);
  }
  assert.equal(readFileSync(join(directory, "wrangler.jsonc"), "utf8"), wrangler);
  const config: Config = JSON.parse(contents("monitors.json"));
  assert.equal(config.checks.length, 20);
  const http = config.checks.filter((check) => check.type === "http");
  assert.equal(http.length, 19);
  assert(http.every((check) => check.url.startsWith(fixtureOrigin) && check.bodyRegex === markerRegex));
  assert(http.every((check) => JSON.stringify(check.headers?.Authorization) === JSON.stringify({ secret: fixtureTokenName })));
  assert.deepEqual(config.checks.find(({ id }) => id === "application")?.dependsOn, ["edge"]);
  assert.equal(config.webhook?.urlSecret, "LOOKOUT_WEBHOOK_URL");
  const lookout = JSON.parse(contents("wrangler.lookout.json"));
  const fixture = JSON.parse(contents("wrangler.fixture.json"));
  assert.deepEqual(lookout.triggers.crons, ["* * * * *"]);
  assert.equal(lookout.observability.enabled, true);
  assert.equal(fixture.observability.enabled, false);
  assert.equal(fixture.main, "./fixture.ts");
  assert.match(contents("fixture.ts"), /^export \{ default \} from "[^"\n]+\/staging-fixture.ts";\n$/u);
  assert.match(contents("lookout.ts"), /\/worker-app.ts";/u);
  assert.doesNotMatch(contents("lookout.ts"), /config\.ts/u);
  assert.equal(fixture.routes, undefined);
  assert.equal(lookout.routes, undefined);
  assert.equal(lookout.d1_databases[0].database_id, fixture.d1_databases[0].database_id);
  const separate = { ...stagingEnv, LOOKOUT_FIXTURE_D1_DATABASE_NAME: "lookout-fixture-data",
    LOOKOUT_FIXTURE_D1_DATABASE_ID: "22222222-2222-2222-2222-222222222222" };
  writeStagingFiles(directory, separate);
  assert.equal(JSON.parse(contents("wrangler.fixture.json")).d1_databases[0].database_id, separate.LOOKOUT_FIXTURE_D1_DATABASE_ID);
  assert.throws(() => writeStagingFiles(directory, { ...stagingEnv, LOOKOUT_STAGING_WORKER_NAME: "lookout" }), /dedicated Worker/u);
  assert.throws(() => writeStagingFiles(directory, { ...stagingEnv, LOOKOUT_STAGING_D1_DATABASE_NAME: "lookout" }), /dedicated to staging/u);
  assert.throws(() => writeStagingFiles(directory, { ...stagingEnv, LOOKOUT_FIXTURE_URL: `${fixtureOrigin}/path` }), /HTTPS origin/u);
});
