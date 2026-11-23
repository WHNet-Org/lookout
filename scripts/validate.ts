import { readMonitorConfig } from "../src/config-file.ts";

const files = process.argv.slice(2);
for (const file of files.length > 0 ? files : ["monitors.example.json"]) {
  const config = readMonitorConfig(file);
  console.log(`${file}: ${config.checks.length} checks, ${config.groups.length} groups.`);
}
