import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { validateConfig } from "../src/config.ts";
import { fixtureHealthIds, fixtureSchema, fixtureTokenName, fixtureWebhookSecretName, markerRegex } from "./staging-fixture.ts";
import { splitWorker, writeWorkerEntry } from "./worker-bundle.ts";

type Environment = Record<string, string | undefined>;

interface DatabaseSettings {
  name: string;
  id: string;
}

interface BaseConfiguration {
  name: string;
  minify?: boolean;
  compatibility_date: string;
  compatibility_flags: string[];
  triggers: { crons: string[] };
  observability: { enabled: boolean };
  assets: { directory: string; binding: string; run_worker_first: boolean };
  d1_databases: [{ binding: string; database_id: string; database_name: string; migrations_dir: string }];
}

const workerName = /^[a-z\d]+(?:-[a-z\d]+)*$/;
const databaseName = /^[a-z\d]+(?:[-_][a-z\d]+)*$/i;
const databaseId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const zeroId = "00000000-0000-0000-0000-000000000000";

function requireSetting(env: Environment, name: string, pattern?: RegExp): string {
  const value = env[name];
  if (!value || value !== value.trim() || (pattern && !pattern.test(value))) {
    throw new Error(`Set ${name} to a valid staging resource value.`);
  }
  return value;
}

function requireDatabase(env: Environment, prefix: string): DatabaseSettings {
  const name = requireSetting(env, `${prefix}_D1_DATABASE_NAME`, databaseName);
  const id = requireSetting(env, `${prefix}_D1_DATABASE_ID`, databaseId).toLowerCase();
  if (id === zeroId) throw new Error(`Set ${prefix}_D1_DATABASE_ID to a provisioned database ID.`);
  return { name, id };
}

function fixtureOrigin(env: Environment): string {
  const input = requireSetting(env, "LOOKOUT_FIXTURE_URL");
  const parsed = URL.parse(input);
  if (!parsed || parsed.protocol !== "https:" || (input !== parsed.origin && input !== `${parsed.origin}/`)) {
    throw new Error("Set LOOKOUT_FIXTURE_URL to the HTTPS origin of the fixture Worker.");
  }
  return parsed.origin;
}

function makeMonitors(env: Environment) {
  const origin = fixtureOrigin(env);
  const tcpHost = requireSetting(env, "LOOKOUT_STAGING_TCP_HOST");
  const tcpPort = Number(requireSetting(env, "LOOKOUT_STAGING_TCP_PORT", /^\d+$/));
  if (tcpPort === 25) throw new Error("Cloudflare Workers cannot use TCP port 25 as a staging target.");
  const checks = [
    ...fixtureHealthIds.map((id) => ({
      type: "http",
      id,
      name: id === "edge" ? "Edge" : id === "application" ? "Application" : `Service ${id.slice(8)}`,
      visibility: "public",
      url: `${origin}/health/${id}`,
      bodyRegex: markerRegex,
      headers: { Authorization: { secret: fixtureTokenName } },
      ...(id === "application" ? { dependsOn: ["edge"] } : {}),
    })),
    { type: "tcp", id: "public-tcp", name: "Public TCP target", visibility: "public", host: tcpHost, port: tcpPort },
  ];
  const config = {
    checks,
    groups: [{ id: "staging", name: "Staging checks", checks: checks.map(({ id }) => id), visibility: "detailed" }],
    defaultGroup: "staging",
    webhook: { format: "json", urlSecret: fixtureWebhookSecretName },
  };
  const validated = validateConfig(config);
  if (validated.checks.length !== 20) throw new Error("Lookout staging requires exactly twenty checks.");
  return validated;
}

function protectProduction(env: Environment, base: BaseConfiguration, workers: string[], databases: DatabaseSettings[]) {
  const [binding] = base.d1_databases;
  const productionWorkers = [base.name, env.LOOKOUT_WORKER_NAME];
  const productionDatabases = [binding.database_name, env.LOOKOUT_D1_DATABASE_NAME].map((name) => name?.toLowerCase());
  const productionIds = [binding.database_id, env.LOOKOUT_D1_DATABASE_ID].map((id) => id?.toLowerCase());
  if (workers.some((name) => productionWorkers.includes(name))) {
    throw new Error("Use dedicated Worker names for staging and the fixture.");
  }
  if (databases.some(({ name, id }) => productionDatabases.includes(name.toLowerCase()) || productionIds.includes(id))) {
    throw new Error("Use D1 databases dedicated to staging or the fixture.");
  }
}

export function writeStagingFiles(root: string, env: Environment): string {
  const base: BaseConfiguration = JSON.parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
  const lookout = requireSetting(env, "LOOKOUT_STAGING_WORKER_NAME", workerName);
  const fixture = requireSetting(env, "LOOKOUT_FIXTURE_WORKER_NAME", workerName);
  if (lookout === fixture) throw new Error("Choose different names for the staging and fixture Workers.");
  const stagingDb = requireDatabase(env, "LOOKOUT_STAGING");
  const fixtureDb = env.LOOKOUT_FIXTURE_D1_DATABASE_NAME !== undefined || env.LOOKOUT_FIXTURE_D1_DATABASE_ID !== undefined
    ? requireDatabase(env, "LOOKOUT_FIXTURE") : stagingDb;
  if ((fixtureDb.name.toLowerCase() === stagingDb.name.toLowerCase()) !== (fixtureDb.id === stagingDb.id)) {
    throw new Error("Provide the matching name and ID for each staging D1 database.");
  }
  protectProduction(env, base, [lookout, fixture], [stagingDb, fixtureDb]);
  const monitors = makeMonitors(env);
  const directory = resolve(root, ".artifacts/staging");
  const fromArtifacts = (path: string) => relative(directory, resolve(root, path)).split(sep).join("/");
  const d1Binding = (database: DatabaseSettings) => ({ binding: "DB", database_name: database.name, database_id: database.id });
  const common = { compatibility_date: base.compatibility_date, workers_dev: true };
  mkdirSync(directory, { recursive: true });
  const lookoutConfig = {
    ...common,
    name: lookout,
    main: writeWorkerEntry(root, directory, "lookout", monitors),
    minify: base.minify,
    compatibility_flags: base.compatibility_flags,
    triggers: base.triggers,
    observability: base.observability,
    assets: { ...base.assets, directory: fromArtifacts(base.assets.directory) },
    d1_databases: [{ ...d1Binding(stagingDb), migrations_dir: fromArtifacts(base.d1_databases[0].migrations_dir) }],
  };
  const fixtureConfig = {
    ...common,
    name: fixture,
    main: "./fixture.ts",
    // The webhook authenticates through its URL. Keep that URL out of fixture request logs.
    observability: { enabled: false },
    d1_databases: [d1Binding(fixtureDb)],
  };
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(resolve(directory, "wrangler.lookout.json"), json(lookoutConfig));
  writeFileSync(resolve(directory, "wrangler.fixture.json"), json(fixtureConfig));
  writeFileSync(resolve(directory, "fixture.sql"), fixtureSchema);
  writeFileSync(resolve(directory, "fixture.ts"), `export { default } from "${fromArtifacts("scripts/staging-fixture.ts")}";\n`);
  return directory;
}

if (import.meta.main) {
  const directory = writeStagingFiles(process.cwd(), process.env);
  const configPath = resolve(directory, "wrangler.lookout.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, `${JSON.stringify(await splitWorker(directory, config), null, 2)}\n`);
  console.log(`Prepared isolated staging files in ${relative(process.cwd(), directory)}.`);
}
