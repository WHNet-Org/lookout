import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { build } from "esbuild";
import type { Config } from "../src/model.ts";

export function writeWorkerEntry(root: string, directory: string, name: string, config: Config, revision: string | null = null): string {
  const modulePath = (path: string) => relative(directory, resolve(root, path)).split(sep).join("/");
  writeFileSync(resolve(directory, "monitors.json"), JSON.stringify(config, null, 2) + "\n");
  const entry = `./${name}.ts`;
  writeFileSync(resolve(directory, entry), [
    `import { createWorker } from "${modulePath("src/worker-app.ts")}";`,
    `import type { Config } from "${modulePath("src/model.ts")}";`,
    'import monitors from "./monitors.json" with { type: "json" };',
    `const { handler, ProbeBatch } = createWorker(monitors as Config, ${JSON.stringify(revision)});`,
    "export { ProbeBatch };",
    "export default handler;",
    "",
  ].join("\n"));
  return entry;
}

export async function splitWorker<T extends { main: string; minify?: boolean }>(directory: string, config: T) {
  const entry = resolve(directory, config.main);
  const name = basename(entry, extname(entry));
  const moduleDirectory = `${name}-modules`;
  const outdir = resolve(directory, moduleDirectory);
  const { minify = true, ...wranglerConfig } = config;
  const result = await build({
    entryPoints: [entry],
    outdir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    external: ["cloudflare:*"],
    logLevel: "silent",
    minify,
    sourcemap: "linked",
    sourcesContent: false,
    write: false,
  });

  // Deploy only this build's entry and chunks. Old generated chunks must not
  // stay in Wrangler's module discovery directory after the config changes.
  rmSync(outdir, { force: true, recursive: true });
  for (const file of result.outputFiles) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents);
  }
  return {
    ...wranglerConfig,
    main: `./${moduleDirectory}/${name}.mjs`,
    base_dir: `./${moduleDirectory}`,
    no_bundle: true,
    find_additional_modules: true,
    rules: [{ type: "ESModule", globs: ["**/*.mjs"] }],
  };
}
