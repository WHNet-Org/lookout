import { readFileSync } from "node:fs";
import { validateConfig } from "../src/config.ts";

const files = process.argv.slice(2);
for (const file of files.length > 0 ? files : ["monitors.json", "monitors.example.json"]) {
  const config = validateConfig(JSON.parse(readFileSync(file, "utf8")));
  console.log(`${file}: ${config.checks.length} checks, ${config.groups.length} groups.`);
}
