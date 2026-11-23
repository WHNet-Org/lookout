import { RE2JS } from "re2js";
import { asciiLiteralPrefix } from "./body-pattern.ts";
import type { AlertPolicy, Check, Config, Group, HttpCheck } from "./model.ts";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECRET = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_ALERT = { threshold: 2, muted: false };
const bodyPatterns = new Map<string, RE2JS>();

type Fields = Record<string, unknown>;

function invalid(path: string, reason: string): never {
  throw new Error(`${path} ${reason}`);
}

function fields(value: unknown, path: string, allowed?: readonly string[]): Fields {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  if (allowed) {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) invalid(`${path}.${key}`, "is not supported");
    }
  }
  return value as Fields;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(path, "must be a nonempty string");
  return value;
}

function slug(value: unknown, path: string): string {
  const id = string(value, path);
  if (!SLUG.test(id)) invalid(path, "must be a lowercase slug");
  return id;
}

function secret(value: unknown, path: string): string {
  const name = string(value, path);
  if (!SECRET.test(name)) invalid(path, "must be an environment variable name");
  return name;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(path, `must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (!allowed.some((choice) => choice === value)) invalid(path, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

function unique<T>(values: T[], path: string): T[] {
  if (new Set(values).size !== values.length) invalid(path, "must not contain duplicates");
  return values;
}

function slugs(value: unknown, path: string): string[] {
  return unique(array(value, path).map((id, index) => slug(id, `${path}[${index}]`)), path);
}

function httpUrl(value: unknown, path: string): URL {
  const url = URL.parse(string(value, path));
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    invalid(path, "must be an HTTP or HTTPS URL without credentials or a fragment");
  }
  return url;
}

function origins(value: unknown, path: string): string[] {
  return unique(array(value, path).map((origin, index) => {
    const itemPath = `${path}[${index}]`;
    const parsed = httpUrl(origin, itemPath);
    if (origin !== parsed.origin) invalid(itemPath, "must be an exact origin without a path");
    return parsed.origin;
  }), path);
}

function policy(value: unknown, path: string, defaults: AlertPolicy): AlertPolicy {
  if (value === undefined) return defaults;
  const raw = fields(value, path, ["threshold", "muted"]);
  if (raw.muted !== undefined && typeof raw.muted !== "boolean") invalid(`${path}.muted`, "must be a boolean");
  return {
    threshold: raw.threshold === undefined
      ? defaults.threshold
      : integer(raw.threshold, `${path}.threshold`, 1, Number.MAX_SAFE_INTEGER),
    muted: raw.muted ?? defaults.muted,
  };
}

function parseHeaders(value: unknown, path: string): HttpCheck["headers"] {
  const seen = new Set<string>();
  return Object.fromEntries(Object.entries(fields(value, path)).map(([key, header]) => {
    const itemPath = `${path}.${key}`;
    try {
      new Headers([[key, typeof header === "string" ? header : ""]]);
    } catch {
      invalid(itemPath, "must be a valid HTTP header");
    }
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) invalid(itemPath, "duplicates a header");
    seen.add(normalized);
    return [key, typeof header === "string"
      ? header
      : { secret: secret(fields(header, itemPath, ["secret"]).secret, `${itemPath}.secret`) }];
  }));
}

export function compileBodyRegex(pattern: string): RE2JS {
  let compiled = bodyPatterns.get(pattern);
  if (!compiled) {
    compiled = RE2JS.compile(pattern);
    bodyPatterns.set(pattern, compiled);
  }
  return compiled;
}

function tcpHost(value: unknown, path: string): string {
  const host = string(value, path);
  if (/[\s@/?#\\%]/.test(host)) invalid(path, "must be a hostname or IP address");
  const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const authority = address.includes(":") ? `[${address}]` : address;
  const parsed = URL.parse(`http://${authority}`);
  if (!parsed || parsed.port) invalid(path, "must be a hostname or IP address");
  return parsed.hostname.replace(/^\[|\]$/g, "");
}

const checkFields = ["id", "name", "type", "visibility", "dependsOn", "timeoutMs", "alert", "alertGroup"];

function parseCheck(value: unknown, path: string, defaults: AlertPolicy, groups: Map<string, Group>,
  groupPolicies: Map<string, AlertPolicy>): Check {
  const input = fields(value, path);
  const id = slug(input.id, `${path}.id`);
  const type = oneOf(input.type, `${path}.type`, ["http", "tcp"]);
  let inherited = defaults;
  if (input.alertGroup !== undefined) {
    const groupId = slug(input.alertGroup, `${path}.alertGroup`);
    if (!groups.get(groupId)?.checks.includes(id)) invalid(`${path}.alertGroup`, "must name a group containing this check");
    inherited = groupPolicies.get(groupId) ?? defaults;
  }
  const base = {
    id,
    name: string(input.name, `${path}.name`),
    visibility: oneOf(input.visibility ?? "private", `${path}.visibility`, ["public", "private"]),
    dependsOn: input.dependsOn === undefined ? [] : slugs(input.dependsOn, `${path}.dependsOn`),
    timeoutMs: integer(input.timeoutMs ?? 5_000, `${path}.timeoutMs`, 1, 8_000),
    alert: policy(input.alert, `${path}.alert`, inherited),
  } as const;

  if (type === "tcp") {
    fields(input, path, [...checkFields, "host", "port"]);
    return {
      ...base,
      type,
      host: tcpHost(input.host, `${path}.host`),
      port: integer(input.port, `${path}.port`, 1, 65_535),
    };
  }

  fields(input, path, [...checkFields, "url", "method", "expectedCodes", "headers", "bodyRegex", "redirects"]);
  const method = oneOf(input.method ?? "GET", `${path}.method`, ["GET", "HEAD"]);
  const check: HttpCheck = { ...base, type, url: httpUrl(input.url, `${path}.url`).href, method };
  if (input.expectedCodes !== undefined) {
    const codePath = `${path}.expectedCodes`;
    check.expectedCodes = unique(array(input.expectedCodes, codePath).map((code, index) =>
      integer(code, `${codePath}[${index}]`, 100, 599)), codePath);
    if (!check.expectedCodes.length) invalid(codePath, "must contain at least one status code");
  }
  if (input.headers !== undefined) check.headers = parseHeaders(input.headers, `${path}.headers`);
  if (input.bodyRegex !== undefined) {
    const regexPath = `${path}.bodyRegex`;
    if (method !== "GET") invalid(regexPath, "requires GET");
    check.bodyRegex = string(input.bodyRegex, regexPath);
    try {
      if (!asciiLiteralPrefix(check.bodyRegex)) compileBodyRegex(check.bodyRegex);
    } catch {
      invalid(regexPath, "must be a valid RE2 pattern");
    }
  }
  if (input.redirects !== undefined) {
    const redirectPath = `${path}.redirects`;
    const redirects = fields(input.redirects, redirectPath, ["maxHops", "allowedOrigins"]);
    check.redirects = {
      maxHops: integer(redirects.maxHops ?? 3, `${redirectPath}.maxHops`, 1, 3),
      allowedOrigins: redirects.allowedOrigins === undefined
        ? []
        : origins(redirects.allowedOrigins, `${redirectPath}.allowedOrigins`),
    };
  }
  return check;
}

function validateDependencies(checks: Map<string, Check>): void {
  const complete = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) invalid(`dependencies for ${id}`, "contain a cycle");
    if (complete.has(id)) return;
    visiting.add(id);
    for (const dependency of checks.get(id)!.dependsOn) {
      if (!checks.has(dependency)) invalid(`dependency ${dependency} for ${id}`, "does not exist");
      if (dependency === id) invalid(`dependency for ${id}`, "cannot refer to itself");
      visit(dependency);
    }
    visiting.delete(id);
    complete.add(id);
  }
  for (const id of checks.keys()) visit(id);
}

export function validateConfig(value: unknown): Config {
  const raw = fields(value, "config", ["checks", "groups", "defaultGroup", "allowedOrigins", "alert", "webhook"]);
  const checkInputs = array(raw.checks, "checks");
  const groupInputs = raw.groups === undefined ? [] : array(raw.groups, "groups");
  if (checkInputs.length > 25) invalid("checks", "can contain at most 25 checks");
  if (checkInputs.length + groupInputs.length > 40) invalid("checks and groups", "can contain at most 40 rollups");
  const defaults = policy(raw.alert, "alert", DEFAULT_ALERT);
  const groups = new Map<string, Group>();
  const groupPolicies = new Map<string, AlertPolicy>();
  groupInputs.forEach((value, index) => {
    const path = `groups[${index}]`;
    const input = fields(value, path, ["id", "name", "visibility", "checks", "alert"]);
    const id = slug(input.id, `${path}.id`);
    if (groups.has(id)) invalid(`${path}.id`, "duplicates another group");
    groups.set(id, {
      id,
      name: string(input.name, `${path}.name`),
      visibility: oneOf(input.visibility ?? "private", `${path}.visibility`, ["private", "detailed", "aggregate"]),
      checks: slugs(input.checks, `${path}.checks`),
    });
    groupPolicies.set(id, policy(input.alert, `${path}.alert`, defaults));
  });

  const checks = new Map<string, Check>();
  let operations = 0;
  checkInputs.forEach((value, index) => {
    const path = `checks[${index}]`;
    const check = parseCheck(value, path, defaults, groups, groupPolicies);
    if (checks.has(check.id)) invalid(`${path}.id`, "duplicates another check");
    checks.set(check.id, check);
    operations += 1 + (check.type === "http" ? check.redirects?.maxHops ?? 0 : 0);
  });
  if (operations > 45) invalid("checks", "can use at most 45 probe operations including redirect hops");
  validateDependencies(checks);
  for (const group of groups.values()) {
    for (const id of group.checks) {
      if (!checks.has(id)) invalid(`member ${id} of group ${group.id}`, "does not exist");
    }
  }

  const config: Config = {
    checks: [...checks.values()],
    groups: [...groups.values()],
    allowedOrigins: raw.allowedOrigins === undefined ? [] : origins(raw.allowedOrigins, "allowedOrigins"),
  };
  if (raw.defaultGroup !== undefined) {
    const id = slug(raw.defaultGroup, "defaultGroup");
    const group = groups.get(id);
    if (!group || group.visibility === "private") invalid("defaultGroup", "must name a published group");
    config.defaultGroup = id;
  }
  if (raw.webhook !== undefined) {
    const webhook = fields(raw.webhook, "webhook", ["format", "urlSecret"]);
    config.webhook = {
      format: oneOf(webhook.format, "webhook.format", ["json", "discord"]),
      urlSecret: secret(webhook.urlSecret, "webhook.urlSecret"),
    };
  }
  return config;
}
