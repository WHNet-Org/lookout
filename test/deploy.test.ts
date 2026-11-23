import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

const source = resolve(import.meta.dirname, "..");
const marker = "private-monitor-value.example";
const databaseId = "12345678-1234-1234-1234-123456789abc";
const versionId = "00000000-1234-1234-1234-123456789abc";
const monitorJson = JSON.stringify({
  checks: [{ type: "http", id: "private-service", name: "Private service", url: `https://${marker}/` }],
});

const stubWrangler = String.raw`
const { execFileSync } = require("node:child_process");
const { appendFileSync, existsSync, readFileSync, statSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const args = process.argv.slice(2);
const path = args[args.indexOf("--config") + 1];
const config = JSON.parse(readFileSync(path, "utf8"));
const directory = dirname(path);
const record = {
  args: args.slice(0, -2),
  directory,
  mode: statSync(directory).mode & 0o777,
  databaseId: config.d1_databases[0].database_id,
  assets: config.assets.directory,
  target: config.name,
};
if (args[0] === "deploy") {
  const bundled = readFileSync(resolve(directory, config.main), "utf8");
  record.containsPrivateMonitor = bundled.includes(process.env.LOOKOUT_TEST_MARKER);
  record.containsPersistedMonitor = bundled.includes("another-monitor-value.example");
  record.containsRevision = !!process.env.CI_COMMIT_SHA && bundled.includes(process.env.CI_COMMIT_SHA);
  record.buildNameOverride = process.env.WRANGLER_CI_OVERRIDE_NAME;
  record.debugLogs = process.env.WRANGLER_WRITE_LOGS;
  record.seedPathInChild = !!process.env.LOOKOUT_INITIAL_CONFIG_FILE;
}
appendFileSync(process.env.LOOKOUT_TEST_TRACE, JSON.stringify(record) + "\n");
if (args[1] === "execute") {
  const sql = args[args.indexOf("--command") + 1];
  if (process.env.LOOKOUT_TEST_QUERY_FAILED) {
    console.error(process.env.LOOKOUT_TEST_MARKER);
    process.exitCode = 1;
  } else if (sql.includes("sqlite_schema")) {
    const rows = process.env.LOOKOUT_TEST_NO_TABLE ? [] : [{ present: 1 }];
    console.log(JSON.stringify([{ success: true, results: rows }]));
  } else if (existsSync(process.env.LOOKOUT_TEST_SEEDED)) {
    console.log(readFileSync(process.env.LOOKOUT_TEST_SEEDED, "utf8"));
  } else {
    console.log(process.env.LOOKOUT_TEST_D1_OUTPUT);
  }
}
if (args[1] === "migrations" && process.env.LOOKOUT_TEST_ADVANCE_TO) {
  execFileSync("git", ["update-ref", "refs/heads/main", process.env.LOOKOUT_TEST_ADVANCE_TO]);
}
if (args[0] === "deploy" && !args.includes("--dry-run")) {
  console.log(process.env.LOOKOUT_TEST_MARKER);
  console.log("Current Version ID: " + process.env.LOOKOUT_TEST_VERSION);
}
`;

const stubFetch = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const env = process.env;
const trace = (record) => appendFileSync(env.LOOKOUT_TEST_TRACE, JSON.stringify(record) + "\n");
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.origin === "https://api.cloudflare.com" && url.pathname.endsWith("/query")) {
    const { sql, params } = JSON.parse(options.body);
    trace({ method: options.method, seed: true, sql,
      token: options.headers.Authorization === "Bearer " + env.CLOUDFLARE_API_TOKEN,
      parameterMatches: params.length === 1 && params[0] === readFileSync(env.LOOKOUT_INITIAL_CONFIG_FILE, "utf8"),
    });
    if (env.LOOKOUT_TEST_SEED_FAIL) return Response.json({ errors: [env.LOOKOUT_TEST_MARKER] }, { status: 403 });
    writeFileSync(env.LOOKOUT_TEST_SEEDED, env.LOOKOUT_TEST_PERSISTED ?? JSON.stringify([
      { success: true, results: [{ config_json: params[0] }] },
    ]));
    if (env.LOOKOUT_TEST_ADVANCE_AFTER_SEED) {
      execFileSync("git", ["update-ref", "refs/heads/main", env.LOOKOUT_TEST_ADVANCE_AFTER_SEED]);
    }
    return Response.json({ success: true, result: [{ success: true, results: [] }] });
  }
  trace({ smoke: url.pathname, origin: url.origin, headers: options.headers ?? null });
  if (url.pathname === "/healthz") {
    if (env.LOOKOUT_TEST_SMOKE_FAIL) {
      const timeout = Date.now() + 121_000;
      Date.now = () => timeout;
      return Response.json({ unavailable: true }, { status: 503 });
    }
    return Response.json({ version: env.LOOKOUT_TEST_PACKAGE_VERSION, revision: env.CI_COMMIT_SHA });
  }
  if (url.pathname === "/api/v1/status") {
    return Response.json({ online: false, status: "unknown" }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }
  throw new Error("Unexpected request during deploy regression test");
};
`;

function d1Response(...configRows: string[]) {
  return JSON.stringify([{ success: true, results: configRows.map((config_json) => ({ config_json })) }]);
}

function deployFixture(t: TestContext) {
  const checkout = mkdtempSync(join(tmpdir(), "lookout-deploy-test-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  const tracePath = join(checkout, "trace.jsonl");
  const seededPath = join(checkout, "seeded.json");
  const preload = join(checkout, "fetch-stub.mjs");
  const seedFile = join(checkout, "operator-seed.json");
  writeFileSync(preload, stubFetch);
  writeFileSync(seedFile, monitorJson);
  for (const name of ["src", "public", "migrations"]) {
    symlinkSync(join(source, name), join(checkout, name), "dir");
  }
  writeFileSync(join(checkout, "wrangler.jsonc"), readFileSync(join(source, "wrangler.jsonc")));
  const bin = join(checkout, "node_modules", "wrangler", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "wrangler.js"), stubWrangler);
  const env = {
    ...process.env,
    WORKERS_CI: undefined,
    GITLAB_CI: undefined,
    LOOKOUT_DOMAIN: undefined,
    LOOKOUT_SMOKE_ORIGIN: undefined,
    LOOKOUT_INITIAL_CONFIG_FILE: undefined,
    WRANGLER_CI_OVERRIDE_NAME: undefined,
    LOOKOUT_WORKER_NAME: "test-worker",
    LOOKOUT_D1_DATABASE_ID: databaseId,
    LOOKOUT_TEST_TRACE: tracePath,
    LOOKOUT_TEST_D1_OUTPUT: d1Response(monitorJson),
    LOOKOUT_TEST_MARKER: marker,
    LOOKOUT_TEST_VERSION: versionId,
    LOOKOUT_TEST_SEEDED: seededPath,
    LOOKOUT_TEST_PACKAGE_VERSION: JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version,
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_API_TOKEN: "deploy-test-token",
  };
  function run(args: string[] = [], overrides: NodeJS.ProcessEnv = {}) {
    rmSync(tracePath, { force: true });
    rmSync(seededPath, { force: true });
    const result = spawnSync(process.execPath, ["--import", preload, join(source, "scripts", "deploy.ts"), ...args], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...env, ...overrides },
      timeout: 15_000,
    });
    assert.ifError(result.error);
    const trace = existsSync(tracePath)
      ? readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
    return { status: result.status, logs: result.stdout + result.stderr, trace };
  }
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: checkout,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return { checkout, git, run, seedFile };
}

test("deploy compiles the private D1 row in a temporary Worker module and cleans up", (t) => {
  const { checkout, run } = deployFixture(t);
  const { status, trace, logs } = run([], { LOOKOUT_INITIAL_CONFIG_FILE: "unused-existing-row.json" });
  assert.equal(status, 0, logs);
  assert.equal(trace.length, 4);
  const [schema, query, migration, deployment] = trace;
  assert.match(schema.args.at(-1), /FROM sqlite_schema/u);
  assert.deepEqual(query.args.slice(0, 5), ["d1", "execute", "DB", "--remote", "--json"]);
  assert.match(query.args.at(-1), /FROM lookout_monitor_config WHERE id = 1/u);
  assert.deepEqual(migration.args, ["d1", "migrations", "apply", "DB", "--remote"]);
  assert.deepEqual(deployment.args, ["deploy"]);
  assert.equal(deployment.databaseId, databaseId);
  assert.equal(deployment.assets, join(checkout, "public"));
  assert.equal(deployment.containsPrivateMonitor, true);
  assert.equal(deployment.debugLogs, "false");
  assert.equal(deployment.seedPathInChild, false);
  assert(!deployment.directory.startsWith(checkout + "/"));
  assert.equal(deployment.mode, 0o700);
  assert(!existsSync(deployment.directory));
  assert(!logs.includes(marker));
  assert.match(logs, /Lookout config SHA-256: [0-9a-f]{64}/u);
  assert(logs.includes(`Current Version ID: ${versionId}`));
});

test("missing, unreadable, or malformed D1 config stops before remote writes", (t) => {
  const { run } = deployFixture(t);
  const cases = [
    { overrides: { LOOKOUT_TEST_NO_TABLE: "1" }, message: /Set LOOKOUT_INITIAL_CONFIG_FILE/u, reads: 1 },
    { overrides: { LOOKOUT_TEST_D1_OUTPUT: d1Response() }, message: /Set LOOKOUT_INITIAL_CONFIG_FILE/u, reads: 2 },
    { overrides: { LOOKOUT_TEST_QUERY_FAILED: "1" }, message: /Could not read the D1 monitor configuration/u, reads: 1 },
    { overrides: { LOOKOUT_TEST_D1_OUTPUT: marker }, message: /invalid response/u, reads: 2 },
    { overrides: { LOOKOUT_TEST_D1_OUTPUT: d1Response(marker) }, message: /must contain valid JSON/u, reads: 2 },
    {
      overrides: { LOOKOUT_TEST_D1_OUTPUT: d1Response(JSON.stringify({ [marker]: true })) },
      message: /does not match the Lookout schema/u,
      reads: 2,
    },
  ];
  for (const { overrides, message, reads } of cases) {
    const { status, trace, logs } = run([], overrides);
    assert.equal(status, 1, logs);
    assert.match(logs, message);
    assert(!logs.includes(marker));
    assert.equal(trace.length, reads);
    assert(trace.every((entry) => entry.args[0] === "d1" && entry.args[1] === "execute"));
    assert(!existsSync(trace[0].directory));
  }
});

test("first seed uses a bound parameter and deploys the authoritative row after a concurrent insertion", (t) => {
  const { run, seedFile } = deployFixture(t);
  writeFileSync(seedFile, monitorJson.replace("Private service", "Operator's service"));
  const { status, trace, logs } = run([], {
    LOOKOUT_TEST_NO_TABLE: "1",
    LOOKOUT_INITIAL_CONFIG_FILE: seedFile,
    LOOKOUT_TEST_PERSISTED: d1Response(monitorJson.replace(marker, "another-monitor-value.example")),
  });
  assert.equal(status, 0, logs);
  assert.equal(trace.length, 5);
  const [schema, migration, seed, reread, deployment] = trace;
  assert.match(schema.args.at(-1), /sqlite_schema/u);
  assert.deepEqual(migration.args, ["d1", "migrations", "apply", "DB", "--remote"]);
  assert.deepEqual(seed, {
    method: "POST",
    seed: true,
    sql: "INSERT INTO lookout_monitor_config (id, config_json) VALUES (1, ?) ON CONFLICT(id) DO NOTHING",
    token: true,
    parameterMatches: true,
  });
  assert.match(reread.args.at(-1), /SELECT config_json/u);
  assert.equal(deployment.containsPrivateMonitor, false);
  assert.equal(deployment.containsPersistedMonitor, true);
  assert.doesNotMatch(logs, /private-monitor-value|another-monitor-value|Operator's service|deploy-test-token/u);
  assert(!existsSync(deployment.directory));
});

test("invalid seed or seed failure leaves the live Worker untouched", (t) => {
  const { run, seedFile } = deployFixture(t);
  const env = { LOOKOUT_TEST_D1_OUTPUT: d1Response(), LOOKOUT_INITIAL_CONFIG_FILE: seedFile };
  writeFileSync(seedFile, marker);
  const invalid = run([], env);
  assert.equal(invalid.status, 1, invalid.logs);
  assert.match(invalid.logs, /must contain valid JSON/u);
  assert(!invalid.logs.includes(marker));
  assert.equal(invalid.trace.length, 2);
  assert(invalid.trace.every((entry) => entry.args[1] === "execute"));

  writeFileSync(seedFile, monitorJson);
  const rejected = run([], { ...env, LOOKOUT_TEST_SEED_FAIL: "1" });
  assert.equal(rejected.status, 1, rejected.logs);
  assert.match(rejected.logs, /rejected the initial D1 configuration write/u);
  assert(!rejected.logs.includes(marker));
  assert.equal(rejected.trace.at(-1).seed, true);
  assert(!rejected.trace.some((entry) => entry.args?.[0] === "deploy"));
});

test("migration bootstrap skips the config read and dry run uses an offline target", (t) => {
  const { run } = deployFixture(t);
  const migration = run(["--migrate-only"]);
  assert.equal(migration.status, 0, migration.logs);
  assert.deepEqual(migration.trace.map((entry) => entry.args), [["d1", "migrations", "apply", "DB", "--remote"]]);
  const dryRun = run(["--dry-run"], {
    WORKERS_CI: "1",
    WRANGLER_CI_OVERRIDE_NAME: "live-worker",
    LOOKOUT_D1_DATABASE_ID: "invalid",
  });
  assert.equal(dryRun.status, 0, dryRun.logs);
  assert.equal(dryRun.trace.length, 1);
  assert.deepEqual(dryRun.trace[0].args.slice(0, 3), ["deploy", "--dry-run", "--outdir"]);
  assert.equal(dryRun.trace[0].target, "lookout");
  assert.equal(dryRun.trace[0].buildNameOverride, undefined);
  assert.equal(dryRun.trace[0].containsPrivateMonitor, false);
  assert(!existsSync(dryRun.trace[0].directory));
});

test("only protected current main can deploy from GitLab and smoke checks use its public domain", (t) => {
  const { git, run, seedFile } = deployFixture(t);
  git("init", "-b", "main");
  const commit = (subject: string) => {
    git("-c", "user.name=Lookout", "-c", "user.email=lookout@example.com", "commit", "--allow-empty", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  const sha = commit("Current revision");
  const next = commit("Newer revision");
  git("remote", "add", "origin", ".");
  git("checkout", "--detach", sha);
  const env = {
    GITLAB_CI: "true",
    CI_COMMIT_BRANCH: "main",
    CI_COMMIT_REF_PROTECTED: "true",
    CI_PIPELINE_SOURCE: "push",
    CI_COMMIT_SHA: sha,
    LOOKOUT_DOMAIN: "status.example",
  };

  const workersBuilds = run([], { WORKERS_CI: "1", LOOKOUT_PRODUCTION_READY: "1" });
  assert.equal(workersBuilds.status, 1, workersBuilds.logs);
  assert.match(workersBuilds.logs, /Disable Cloudflare Workers Builds/u);
  assert.deepEqual(workersBuilds.trace, []);

  const notReady = run([], { ...env, LOOKOUT_PRODUCTION_READY: "" });
  assert.equal(notReady.status, 0, notReady.logs);
  assert.match(notReady.logs, /Skipping production deployment/u);
  assert.deepEqual(notReady.trace, []);
  const wrongCheckout = run([], { ...env, CI_COMMIT_SHA: next, LOOKOUT_PRODUCTION_READY: "1" });
  assert.equal(wrongCheckout.status, 1, wrongCheckout.logs);
  assert.match(wrongCheckout.logs, /matching checkout SHA/u);
  assert.deepEqual(wrongCheckout.trace, []);
  const unprotected = run([], { ...env, CI_COMMIT_REF_PROTECTED: "false", LOOKOUT_PRODUCTION_READY: "1" });
  assert.equal(unprotected.status, 1, unprotected.logs);
  assert.match(unprotected.logs, /protected main/u);
  assert.deepEqual(unprotected.trace, []);
  const fromSchedule = run([], { ...env, CI_PIPELINE_SOURCE: "schedule", LOOKOUT_PRODUCTION_READY: "1" });
  assert.equal(fromSchedule.status, 1, fromSchedule.logs);
  assert.deepEqual(fromSchedule.trace, []);
  const stale = run([], { ...env, LOOKOUT_PRODUCTION_READY: "1" });
  assert.equal(stale.status, 0, stale.logs);
  assert.match(stale.logs, /Skipping a superseded GitLab deployment/u);
  assert.deepEqual(stale.trace, []);

  git("update-ref", "refs/heads/main", sha);
  const seed = { LOOKOUT_TEST_NO_TABLE: "1", LOOKOUT_INITIAL_CONFIG_FILE: seedFile };
  const beforeSeed = run([], { ...env, ...seed, LOOKOUT_PRODUCTION_READY: "1", LOOKOUT_TEST_ADVANCE_TO: next });
  assert.equal(beforeSeed.status, 0, beforeSeed.logs);
  assert.match(beforeSeed.logs, /Skipping a superseded GitLab deployment/u);
  assert.deepEqual(beforeSeed.trace.map((entry) => entry.args.slice(0, 2)), [["d1", "execute"], ["d1", "migrations"]]);
  assert(!existsSync(beforeSeed.trace[0].directory));

  git("update-ref", "refs/heads/main", sha);
  const beforeUpload = run([], { ...env, ...seed, LOOKOUT_PRODUCTION_READY: "1", LOOKOUT_TEST_ADVANCE_AFTER_SEED: next });
  assert.equal(beforeUpload.status, 0, beforeUpload.logs);
  assert.match(beforeUpload.logs, /Skipping a superseded GitLab deployment/u);
  assert(beforeUpload.trace.some((entry) => entry.seed));
  assert(!beforeUpload.trace.some((entry) => entry.args?.[0] === "deploy"));
  assert(!existsSync(beforeUpload.trace[0].directory));

  git("update-ref", "refs/heads/main", sha);
  const deployed = run([], { ...env, CI_PIPELINE_SOURCE: "web", LOOKOUT_PRODUCTION_READY: "1" });
  assert.equal(deployed.status, 0, deployed.logs);
  assert.equal(deployed.trace.find((entry) => entry.args?.[0] === "deploy").containsRevision, true);
  assert.deepEqual(deployed.trace.filter((entry) => entry.smoke), [
    { smoke: "/healthz", origin: "https://status.example", headers: null },
    { smoke: "/api/v1/status", origin: "https://status.example", headers: { Origin: "https://lookout-smoke.example" } },
  ]);
  assert.match(deployed.logs, /Verified the released revision and public status endpoint/u);

  const unhealthy = run([], { ...env, LOOKOUT_PRODUCTION_READY: "1", LOOKOUT_TEST_SMOKE_FAIL: "1" });
  assert.equal(unhealthy.status, 1, unhealthy.logs);
  assert.match(unhealthy.logs, /uploaded the Worker\. The smoke test could not verify the released revision/u);
  assert(!existsSync(unhealthy.trace.find((entry) => entry.args?.[0] === "deploy").directory));
});
