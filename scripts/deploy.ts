import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import manifest from "../package.json" with { type: "json" };
import { parseMonitorConfig } from "../src/config-file.ts";
import { validateConfig } from "../src/config.ts";
import type { Config } from "../src/model.ts";
import { smokeDeployment } from "./deploy-smoke.ts";
import { splitWorker, writeWorkerEntry } from "./worker-bundle.ts";

const databaseUuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const gitSha = /^[\da-f]{40}$/iu;
const configTableSql = "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'lookout_monitor_config'";
const readConfigSql = "SELECT config_json FROM lookout_monitor_config WHERE id = 1";
const seedConfigSql = "INSERT INTO lookout_monitor_config (id, config_json) VALUES (1, ?) ON CONFLICT(id) DO NOTHING";
const migrateDatabase = ["d1", "migrations", "apply", "DB", "--remote"];

function gitOutput(...args: string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 15_000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function isCurrentBuild(sourceSha: string): boolean {
  const latest = gitOutput("ls-remote", "--exit-code", "origin", "refs/heads/main").split(/\s/u)[0];
  if (!gitSha.test(latest)) throw new Error("Could not verify the current remote main branch.");
  if (latest === sourceSha) return true;
  console.log("Skipping a superseded GitLab deployment. Run the pipeline for the current main revision.");
  return false;
}

function workerDatabaseId(env: NodeJS.ProcessEnv): string {
  const id = env.LOOKOUT_D1_DATABASE_ID;
  if (!id || !databaseUuid.test(id) || id === "00000000-0000-0000-0000-000000000000") {
    throw new Error("Set LOOKOUT_D1_DATABASE_ID to the provisioned database ID.");
  }
  return id;
}

function readD1Rows(stdout: string): { present?: unknown; config_json?: unknown }[] {
  let response: { success?: boolean; results?: { present?: unknown; config_json?: unknown }[] }[];
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error("Wrangler returned an invalid response for the D1 monitor configuration query.");
  }
  if (!Array.isArray(response) || response.length !== 1 || response[0]?.success !== true ||
      !Array.isArray(response[0].results)) {
    throw new Error("Wrangler returned an invalid response for the D1 monitor configuration query.");
  }
  return response[0].results;
}

function readStoredMonitorConfig(rows: ReturnType<typeof readD1Rows>): Config | undefined {
  if (rows.length === 0) return undefined;
  if (rows.length !== 1 || typeof rows[0]?.config_json !== "string") {
    throw new Error("D1 returned an invalid monitor configuration row.");
  }
  return parseMonitorConfig(rows[0].config_json, "D1 lookout_monitor_config (id = 1)");
}

function prepareSeed(env: NodeJS.ProcessEnv, databaseId: string): () => Promise<void> {
  const initialConfigFile = env.LOOKOUT_INITIAL_CONFIG_FILE;
  if (!initialConfigFile) {
    throw new Error("Set LOOKOUT_INITIAL_CONFIG_FILE or populate lookout_monitor_config (id = 1) in D1 before deploying.");
  }
  let json: string;
  try {
    json = readFileSync(initialConfigFile, "utf8");
  } catch {
    throw new Error("Could not read the file at LOOKOUT_INITIAL_CONFIG_FILE.");
  }
  parseMonitorConfig(json, "LOOKOUT_INITIAL_CONFIG_FILE");

  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !/^[\da-f]{32}$/iu.test(accountId) || !token) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to seed initial D1 configuration.");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  return async () => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql: seedConfigSql, params: [json] }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("The initial D1 configuration write could not be confirmed. Retry to check the stored row.");
    }
    if (!response.ok) {
      throw new Error(`Cloudflare rejected the initial D1 configuration write (HTTP ${response.status}).`);
    }
    let result: { success?: boolean; result?: { success?: boolean }[] } | null;
    try {
      result = await response.json();
    } catch {
      throw new Error("Cloudflare returned an invalid response to the initial D1 configuration write.");
    }
    if (result?.success !== true || !Array.isArray(result.result) ||
        result.result.length !== 1 || result.result[0]?.success !== true) {
      throw new Error("Cloudflare did not confirm the initial D1 configuration write.");
    }
  };
}

function deployDomain(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const host = URL.parse(`https://${value}`);
  if (!host || host.origin !== `https://${value.toLowerCase()}` || host.hostname !== value.toLowerCase()) {
    throw new Error("Set LOOKOUT_DOMAIN to the Worker hostname without a scheme, port, or path.");
  }
  return host.hostname;
}

function deploymentSmokeOrigin(gitlab: boolean, domain: string | undefined, value: string | undefined) {
  if (gitlab) {
    if (!domain) throw new Error("Set LOOKOUT_DOMAIN for the GitLab production deployment and smoke test.");
    return `https://${domain}`;
  }
  if (!value) return undefined;
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error("Set LOOKOUT_SMOKE_ORIGIN to the HTTPS origin of the deployed Worker.");
  }
  return url.origin;
}

async function main(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const dryRun = args[0] === "--dry-run";
  const migrateOnly = args[0] === "--migrate-only";
  if (args.length > 1 || (args.length === 1 && !dryRun && !migrateOnly)) {
    throw new Error("Usage: npm run deploy -- [--dry-run | --migrate-only]");
  }

  if (!dryRun && env.WORKERS_CI === "1") {
    throw new Error("Lookout production deployments are published by GitLab. Disable Cloudflare Workers Builds deploys for this Worker.");
  }
  const gitlab = !dryRun && env.GITLAB_CI === "true";
  const head = dryRun ? "" : gitOutput("rev-parse", "--verify", "HEAD");
  const sourceSha = gitSha.test(head) ? head : null;
  if (gitlab) {
    if (env.CI_COMMIT_BRANCH !== "main" || env.CI_COMMIT_REF_PROTECTED !== "true" ||
        (env.CI_PIPELINE_SOURCE !== "push" && env.CI_PIPELINE_SOURCE !== "web") ||
        !sourceSha || sourceSha !== env.CI_COMMIT_SHA) {
      throw new Error("GitLab deployment requires a protected main push or web pipeline with its matching checkout SHA.");
    }
    if (env.LOOKOUT_PRODUCTION_READY !== "1") {
      console.log("Skipping production deployment. Set LOOKOUT_PRODUCTION_READY=1 in GitLab after staging passes.");
      return;
    }
  }
  const canMutate = () => !gitlab || isCurrentBuild(sourceSha!);
  if (!canMutate()) return;
  const databaseId = dryRun ? null : workerDatabaseId(env);
  const domain = dryRun ? undefined : deployDomain(env.LOOKOUT_DOMAIN);
  const smokeOrigin = dryRun || migrateOnly ? undefined : deploymentSmokeOrigin(gitlab, domain, env.LOOKOUT_SMOKE_ORIGIN);
  if (smokeOrigin && !sourceSha) throw new Error("A Git checkout is required to verify the deployed source SHA.");
  const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
  delete config.$schema;
  config.main = resolve(config.main);
  config.assets.directory = resolve(config.assets.directory);
  const binding = config.d1_databases[0];
  binding.migrations_dir = resolve(binding.migrations_dir);
  if (databaseId) {
    config.name = env.LOOKOUT_WORKER_NAME ?? config.name;
    binding.database_id = databaseId;
    binding.database_name = env.LOOKOUT_D1_DATABASE_NAME ?? binding.database_name;
    if (domain) config.routes = [{ pattern: domain, custom_domain: true }];
  }

  const tempRoot = realpathSync(tmpdir());
  const relativeTempRoot = relative(realpathSync(process.cwd()), tempRoot);
  if (!isAbsolute(relativeTempRoot) && relativeTempRoot !== ".." && !relativeTempRoot.startsWith(`..${sep}`)) {
    throw new Error("Set the temporary directory to a location outside the Lookout checkout.");
  }
  const directory = mkdtempSync(join(tempRoot, "lookout-deploy-"));
  try {
    const path = join(directory, "wrangler.json");
    const wrangler = (command: string[], capture: boolean, message: string) => {
      const subprocessEnv: NodeJS.ProcessEnv = {
        ...env,
        CI: "true",
        WRANGLER_LOG: "log",
        WRANGLER_LOG_PATH: directory,
        WRANGLER_LOG_SANITIZE: "true",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_SEND_ERROR_REPORTS: "false",
        WRANGLER_WRITE_LOGS: "false",
        WRANGLER_OUTPUT_FILE_PATH: "",
        WRANGLER_OUTPUT_FILE_DIRECTORY: "",
      };
      delete subprocessEnv.LOOKOUT_INITIAL_CONFIG_FILE;
      delete subprocessEnv.WRANGLER_CI_MATCH_TAG;
      delete subprocessEnv.WRANGLER_CI_OVERRIDE_NAME;
      if (dryRun) {
        delete subprocessEnv.CLOUDFLARE_API_TOKEN;
        delete subprocessEnv.CLOUDFLARE_ACCOUNT_ID;
      }
      const result = spawnSync(process.execPath, [
        "node_modules/wrangler/bin/wrangler.js", ...command, "--config", path,
      ], {
        env: subprocessEnv,
        encoding: "utf8",
        stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
        // The D1 JSON response wraps a string column and may exceed the default
        // one-megabyte subprocess buffer even for valid rows.
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.status !== 0) throw new Error(message);
      return result.stdout;
    };
    const query = (sql: string) => readD1Rows(wrangler(
      ["d1", "execute", "DB", "--remote", "--json", "--command", sql],
      true,
      "Could not read the D1 monitor configuration. Verify the database and deployment credentials.",
    ));
    const migrate = () => wrangler(migrateDatabase, false, "Could not apply D1 migrations.");

    writeFileSync(path, JSON.stringify(config));
    if (migrateOnly) {
      if (canMutate()) migrate();
      return;
    }

    let monitors: Config | undefined;
    let migrated = false;
    if (databaseId) {
      const table = query(configTableSql);
      if (table.length > 1 || (table.length === 1 && table[0]?.present !== 1)) {
        throw new Error("D1 returned invalid monitor configuration table metadata.");
      }
      if (table.length) monitors = readStoredMonitorConfig(query(readConfigSql));
      if (!monitors) {
        const seed = prepareSeed(env, databaseId);
        if (!canMutate()) return;
        migrate();
        migrated = true;
        if (!canMutate()) return;
        await seed();
        // An operator may have inserted the row concurrently. The persisted
        // snapshot is authoritative regardless of who inserted it first.
        monitors = readStoredMonitorConfig(query(readConfigSql));
        if (!monitors) throw new Error("The D1 monitor configuration row is still missing after seeding.");
        console.log("Verified the initial monitor configuration stored in D1.");
      }
    } else {
      monitors = validateConfig({ checks: [], groups: [] });
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(monitors)).digest("hex");
    try {
      config.main = writeWorkerEntry(process.cwd(), directory, "worker", monitors, sourceSha);
      writeFileSync(path, JSON.stringify(await splitWorker(directory, config)));
    } catch {
      // Bundler diagnostics can include the generated module's source text.
      throw new Error("Could not build the Worker with the selected configuration.");
    }

    if (dryRun) {
      wrangler(["deploy", "--dry-run", "--outdir", join(directory, "dry-run")], false, "Worker dry run failed.");
      return;
    }

    if (!migrated) {
      if (!canMutate()) return;
      migrate();
    }
    if (!canMutate()) return;

    console.log(`Lookout source SHA: ${sourceSha || "unavailable"}`);
    console.log(`Lookout config SHA-256: ${fingerprint}`);
    const output = wrangler(["deploy"], true, "Cloudflare Worker deployment failed. Check the Worker build settings and credentials.");
    const versionId = stripVTControlCharacters(output).match(/^Current Version ID: ([\da-f-]+)\s*$/imu)?.[1];
    if (!versionId || !databaseUuid.test(versionId)) {
      console.warn("Wrangler reported success without a Worker version ID. Check the version in the Cloudflare dashboard.");
    } else {
      console.log(`Current Version ID: ${versionId}`);
    }
    if (smokeOrigin) await smokeDeployment(smokeOrigin, sourceSha!, manifest.version);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  await main(process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Lookout deployment failed.");
  process.exitCode = 1;
}
