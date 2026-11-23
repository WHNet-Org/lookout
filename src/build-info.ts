import metadata from "../package.json" with { type: "json" };

export interface BuildInfo {
  version: string;
  revision: string | null;
}

export function createBuildInfo(revision?: string | null): BuildInfo {
  return { version: metadata.version, revision: revision && /^[\da-f]{40}$/iu.test(revision) ? revision.toLowerCase() : null };
}
