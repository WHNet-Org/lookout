import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { validateConfig } from "../src/config.ts";
import { splitWorker, writeWorkerEntry } from "./worker-bundle.ts";

const env = process.env;
const args = process.argv.slice(2);
const dryRun = args.length === 1 && args[0] === "--dry-run";
if (args.length && !dryRun) throw new Error("Usage: npm run deploy -- [--dry-run]");

const uuid = env.LOOKOUT_D1_DATABASE_ID;
if (!dryRun && (!uuid || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(uuid) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/u.test(uuid))) {
  throw new Error("Set LOOKOUT_D1_DATABASE_ID to the provisioned database ID.");
}
function skipSupersededRevision(): void {
  if (dryRun || env.CI !== "true" || !env.CI_COMMIT_SHA) return;
  const latest = spawnSync("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"], { encoding: "utf8" });
  if (latest.status !== 0) throw new Error("Could not verify the current main branch.");
  if (latest.stdout.split(/\s/u)[0] !== env.CI_COMMIT_SHA) {
    console.log("Skipping a superseded revision.");
    process.exit(0);
  }
}
skipSupersededRevision();

const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
const directory = resolve(".artifacts");
mkdirSync(directory, { recursive: true });
const fromOutput = (path: string) => relative(directory, resolve(path));
delete config.$schema;
config.name = env.LOOKOUT_WORKER_NAME ?? config.name;
const monitors = validateConfig(JSON.parse(readFileSync("monitors.json", "utf8")));
config.main = writeWorkerEntry(process.cwd(), directory, "worker", monitors);
config.assets.directory = fromOutput(config.assets.directory);
const binding = config.d1_databases[0];
binding.database_id = uuid ?? binding.database_id;
binding.database_name = env.LOOKOUT_D1_DATABASE_NAME ?? binding.database_name;
binding.migrations_dir = fromOutput(binding.migrations_dir);
if (env.LOOKOUT_DOMAIN) {
  config.routes = [{ pattern: env.LOOKOUT_DOMAIN, custom_domain: true }];
}
const path = resolve(directory, "wrangler.deploy.json");
writeFileSync(path, JSON.stringify(await splitWorker(directory, config), null, 2));

const dryRunOutput = resolve(directory, "cloudflare-bundle");
if (dryRun) rmSync(dryRunOutput, { force: true, recursive: true });
const commands = dryRun ? [["deploy", "--dry-run", "--outdir", dryRunOutput]] : [
  ["d1", "migrations", "apply", "DB", "--remote"],
  ["deploy"],
];
for (const command of commands) {
  skipSupersededRevision();
  const result = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...command, "--config", path], {
    env: { ...env, CI: "true" },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
