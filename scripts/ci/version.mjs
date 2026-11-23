import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function git(args) {
  return spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function prepareBuild() {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const version = manifest.version;
  if (!semver.test(version) || lock.version !== version || lock.packages?.[""]?.version !== version) {
    throw new Error("Source and lockfile need the same x.y.z version. Run make version V=x.y.z.");
  }

  const tag = process.env.CI_COMMIT_TAG ?? "";
  let releaseTag = "";
  if (tag.startsWith("v") && semver.test(tag.slice(1)) && process.env.CI_COMMIT_REF_PROTECTED === "true") {
    if (tag !== `v${version}`) throw new Error("The protected release tag must match the source version.");
    const head = git(["rev-parse", "HEAD"]);
    if (head.status !== 0 || head.stdout.trim() !== process.env.CI_COMMIT_SHA) {
      throw new Error("The release checkout must match the pipeline commit.");
    }
    if (git(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]).status !== 0) {
      throw new Error("Could not fetch main to verify the release tag.");
    }
    if (git(["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"]).status !== 0) {
      throw new Error("The release tag must point to a commit on main.");
    }
    releaseTag = tag;
  }

  mkdirSync(".artifacts/ci", { recursive: true });
  writeFileSync(".artifacts/ci/version.env", `LOOKOUT_VERSION=${version}\nLOOKOUT_RELEASE_TAG=${releaseTag}\n`);
  console.log(`Lookout v${version}`);
}

try {
  const [mode, version, ...extra] = process.argv.slice(2);
  if (mode === "set" && semver.test(version) && !extra.length) {
    const result = spawnSync("npm", ["version", version, "--no-git-tag-version", "--ignore-scripts"], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } else if (mode === "build" && version === undefined) prepareBuild();
  else throw new Error("Usage: make version V=x.y.z");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
