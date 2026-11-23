import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateConfig } from "../src/config.ts";
import { fixtureConfig, fixtureServer, fetchReady, launch } from "../test/support.ts";
import { splitWorker, writeWorkerEntry } from "./worker-bundle.ts";

const fixture = await fixtureServer();
mkdirSync(".artifacts", { recursive: true });
const directory = mkdtempSync(resolve(".artifacts", "worker-"));
const configFile = join(directory, "wrangler.json");
const persistence = join(directory, "state");
const cli = resolve("node_modules/wrangler/bin/wrangler.js");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
const args = ["--config", configFile, "--persist-to", persistence];

let worker: ReturnType<typeof launch> | undefined;
try {
  const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
  delete config.$schema;
  config.name = "lookout-local-smoke";
  const monitors = fixtureConfig(fixture.origin, fixture.port);
  const nativeBodyCheck = monitors.checks.find(({ id }) => id === "service-1")!;
  nativeBodyCheck.bodyRegex = '^\\{"padding":"';
  config.main = writeWorkerEntry(process.cwd(), directory, "worker", validateConfig(monitors));
  config.assets.directory = resolve("public");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  config.vars = { LOOKOUT_WEBHOOK_URL: `${fixture.origin}/webhook` };
  const bundleConfig = await splitWorker(directory, config);
  const bundle = readFileSync(resolve(directory, bundleConfig.main), "utf8");
  const lazyModules = new Set([...bundle.matchAll(/import\("\.\/([^"]+\.mjs)"\)/gu)].map((match) => match[1]));
  assert.equal(lazyModules.size, 2);
  const probeModule = [...lazyModules].find((name) => name.startsWith("probe-"));
  assert(probeModule && [...lazyModules].some((name) => name.startsWith("web-")));
  const probes = readFileSync(resolve(directory, bundleConfig.base_dir, probeModule), "utf8");
  assert.match(probes, /import\("\.\/[^"]+\.mjs"\)/u, "The general RE2 engine also loads on demand.");
  writeFileSync(configFile, JSON.stringify(bundleConfig));

  const migration = spawnSync(process.execPath, [
    cli, "d1", "migrations", "apply", "DB", "--local", ...args,
  ], { env, encoding: "utf8" });
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);

  worker = launch(process.execPath, [
    cli, "dev", "--test-scheduled", "--ip", "127.0.0.1", "--port", "0", "--inspector-port", "0", ...args,
  ], { env });
  const [, port] = await worker.match(/Ready on http:\/\/127\.0\.0\.1:(\d+)/u);
  const origin = `http://127.0.0.1:${port}`;
  assert(await fetchReady(`${origin}/assets/lookout.svg`), worker.output());

  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  const trigger = async (time: number) => {
    const query = new URLSearchParams({ format: "json", cron: config.triggers.crons[0], time: String(time) });
    const response = await fetch(`${origin}/cdn-cgi/local/scheduled?${query}`);
    const body = await response.json();
    assert.equal(response.status, 200, `${JSON.stringify(body)}\n${worker!.output()}`);
    assert.equal(body.outcome, "ok", `${JSON.stringify(body)}\n${worker!.output()}`);
  };
  await trigger(minute - 60_000);
  assert.equal(fixture.observations.length, 19, worker.output());
  assert.equal(fixture.deliveries.length, 1, worker.output());
  const notification = fixture.deliveries[0] as { events: { kind: string; check: { id: string }; affected: { id: string }[] }[] };
  assert.deepEqual(notification.events.map(({ kind, check, affected }) => [kind, check.id, affected.map(({ id }) => id)]),
    [["outage", "edge", ["application"]]]);

  const response = await fetch(`${origin}/api/status?group=whnet`, { headers: { Origin: "https://whnet.ca" } });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "https://whnet.ca");
  assert.deepEqual(await response.json(), { status: "degraded", online: false });
  assert.deepEqual(await (await fetch(`${origin}/api/status?group=internal-group`)).json(), { status: "operational", online: true });
  assert.match(await (await fetch(`${origin}/monitors/application`)).text(), /503/u);
  assert.equal((await fetch(`${origin}/monitors/hidden-listener`)).status, 404);
  assert.equal((await fetch(`${origin}/assets/lookout.svg`)).status, 200);

  await trigger(minute - 60_000);
  assert.equal(fixture.observations.length, 19);
  assert.equal(fixture.deliveries.length, 1);

  fixture.state.cascade = false;
  await trigger(minute);
  assert.equal(fixture.observations.length, 38);
  assert.equal(fixture.deliveries.length, 2);
  const recovery = fixture.deliveries[1] as typeof notification;
  assert.deepEqual(recovery.events.map(({ kind, check }) => [kind, check.id]), [["recovery", "edge"]]);
  assert.deepEqual(await (await fetch(`${origin}/api/status`)).json(), { status: "operational", online: true });
  console.log("Split Worker cron, lazy RE2 and web modules, D1, twenty probes, cascade recovery, API, and assets passed.");
} finally {
  await worker?.stop();
  await fixture.close();
  rmSync(directory, { recursive: true, force: true });
}
