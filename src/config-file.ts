import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateConfig } from "./config.ts";
import type { Config } from "./model.ts";

export function readMonitorConfig(file: string) {
  const path = resolve(file);
  const label = JSON.stringify(path);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "read error";
    throw new Error(`Could not read monitor configuration at ${label} (${code}). Create the file or set LOOKOUT_CONFIG to its path.`);
  }
  return parseMonitorConfig(source, `the file ${label}`);
}

export function parseMonitorConfig(text: string, source: string): Config {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error(`Monitor configuration in ${source} must contain valid JSON.`);
  }

  try {
    return validateConfig(input);
  } catch {
    throw new Error(`Monitor configuration in ${source} does not match the Lookout schema. See monitors.example.json.`);
  }
}
