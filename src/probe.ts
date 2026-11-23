import { asciiLiteralPrefix, AsciiPrefixMatch, MAX_BODY_BYTES } from "./body-pattern.ts";
import type { RE2JS } from "re2js";
import type { Check, Config, HttpCheck, ProbeResult, Results } from "./model.ts";

const MAX_PARALLEL = 5;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const needsHeaderValidation = /[^\t\x20-\x7e]/u;
const supportsReadAtLeast = typeof ReadableStreamBYOBReader !== "undefined" &&
  "readAtLeast" in ReadableStreamBYOBReader.prototype;
const decoder = new TextDecoder();
const compiledPatterns = new Map<string, RE2JS>();
let regexEngine: Promise<typeof import("re2js")> | undefined;

export interface ProbeOptions {
  fetch: typeof fetch;
  connectTcp: (host: string, port: number, signal: AbortSignal) => Promise<void>;
  getSecret: (name: string) => string | undefined;
}

interface Observation {
  httpCode: number | null;
  latencyMs?: number;
}

interface ProbeLifetime {
  readonly signal: AbortSignal;
  cancelBody?: () => void;
}

interface ReadAtLeastReader extends ReadableStreamBYOBReader {
  readAtLeast(minimum: number, view: Uint8Array): Promise<ReadableStreamReadResult<Uint8Array>>;
}

function getReadAtLeastReader(body: ReadableStream<Uint8Array>): ReadAtLeastReader | undefined {
  if (!supportsReadAtLeast) return undefined;
  try {
    return body.getReader({ mode: "byob" }) as ReadAtLeastReader;
  } catch {
    // Streams that do not support BYOB still work through the portable reader.
    return undefined;
  }
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function testRegex(pattern: string, body: string, signal: AbortSignal): boolean | Promise<boolean> {
  const cached = compiledPatterns.get(pattern);
  if (cached) return cached.test(body);
  return (regexEngine ??= import("re2js")).then(({ RE2JS }) => {
    signal.throwIfAborted();
    let compiled = compiledPatterns.get(pattern);
    if (!compiled) {
      compiled = RE2JS.compile(pattern);
      compiledPatterns.set(pattern, compiled);
    }
    return compiled.test(body);
  });
}

async function matchBody(response: Response, lifetime: ProbeLifetime, pattern: string): Promise<boolean | null> {
  const { signal } = lifetime;
  const prefix = asciiLiteralPrefix(pattern);
  if (!response.body) return prefix ? false : testRegex(pattern, "", signal);
  const match = prefix ? new AsciiPrefixMatch(prefix) : undefined;
  const byob = match ? getReadAtLeastReader(response.body) : undefined;
  const reader = byob ?? response.body.getReader();
  lifetime.cancelBody = () => {
    lifetime.cancelBody = undefined;
    void reader.cancel().catch(() => undefined);
  };
  let first: Uint8Array | undefined;
  let combined: Uint8Array | undefined;
  let size = 0;
  let complete = false;
  try {
    if (match && byob) {
      const capacity = MAX_BODY_BYTES + 1;
      const { value } = await byob.readAtLeast(capacity, new Uint8Array(capacity));
      signal.throwIfAborted();
      if (value && value.byteLength > MAX_BODY_BYTES) return null;
      // Workerd only returns a short read here once the entire bounded body has ended.
      complete = true;
      if (value) match.read(value);
      return match.matched;
    }

    const standardReader = reader as ReadableStreamDefaultReader<Uint8Array>;
    for (;;) {
      signal.throwIfAborted();
      const chunk = await standardReader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        complete = true;
        if (match) return match.matched;
        const bytes = combined ? combined.subarray(0, size) : first;
        return testRegex(pattern, decoder.decode(bytes), signal);
      }
      if (chunk.value.byteLength > MAX_BODY_BYTES - size) return null;
      if (match) {
        // Check the prefix once, but still drain the response to enforce the full-body limits.
        match.read(chunk.value);
      } else if (chunk.value.byteLength > 0) {
        if (!first) first = chunk.value;
        else {
          if (!combined) {
            combined = new Uint8Array(MAX_BODY_BYTES);
            combined.set(first);
          }
          combined.set(chunk.value, size);
        }
      }
      size += chunk.value.byteLength;
    }
  } finally {
    if (!complete) lifetime.cancelBody?.();
    lifetime.cancelBody = undefined;
    reader.releaseLock();
  }
}

function redirectTarget(from: URL, location: string, permitted: string[]): URL | null {
  const target = URL.parse(location, from);
  if (!target || target.username || target.password || !["http:", "https:"].includes(target.protocol)) return null;
  const sameHostUpgrade = from.protocol === "http:" && target.protocol === "https:"
    && from.hostname === target.hostname;
  if (from.origin === target.origin || sameHostUpgrade || permitted.includes(target.origin)) return target;
  return null;
}

async function checkHttp(check: HttpCheck, options: ProbeOptions, lifetime: ProbeLifetime, observation: Observation,
  elapsed: () => number): Promise<string | undefined> {
  const { signal } = lifetime;
  const { redirects, expectedCodes } = check;
  let url = check.url;
  let headers: [string, string][] | undefined;
  if (check.headers) {
    headers = [];
    for (const [name, header] of Object.entries(check.headers)) {
      let value = typeof header === "string" ? header : options.getSecret(header.secret);
      if (value === undefined) return "missing_secret";
      // Configuration already validated names. Let fetch normalize ordinary
      // values, and use native validation for uncommon runtime secret bytes.
      if (needsHeaderValidation.test(value)) {
        try {
          const validated = new Headers();
          validated.set(name, value);
          value = validated.get(name) ?? value;
        } catch {
          return "invalid_header";
        }
      }
      headers.push([name, value]);
    }
  }

  let hops = 0;
  for (;;) {
    signal.throwIfAborted();
    const response = await options.fetch(url, {
      method: check.method,
      cache: "no-store",
      redirect: "manual",
      headers,
      signal,
    });
    if (signal.aborted) {
      discardBody(response);
      signal.throwIfAborted();
    }
    const status = response.status;
    observation.httpCode = status;
    observation.latencyMs = elapsed();
    const location = redirects && REDIRECT_CODES.has(status) ? response.headers.get("location") : null;
    if (redirects && location) {
      discardBody(response);
      if (hops >= redirects.maxHops) return "redirect_limit";
      const from = new URL(url);
      const target = redirectTarget(from, location, redirects.allowedOrigins);
      if (!target) return "redirect_blocked";
      if (from.origin !== target.origin) headers = undefined;
      url = target.href;
      hops++;
      continue;
    }

    const allowed = expectedCodes ? expectedCodes.includes(status) : status >= 200 && status < 300;
    if (!allowed || check.bodyRegex === undefined) {
      discardBody(response);
      return allowed ? undefined : "status_mismatch";
    }
    const matches = await matchBody(response, lifetime, check.bodyRegex);
    if (matches === null) return "body_too_large";
    return matches ? undefined : "body_mismatch";
  }
}

async function probe(check: Check, options: ProbeOptions): Promise<ProbeResult> {
  const started = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const controller = new AbortController();
  const lifetime: ProbeLifetime = { signal: controller.signal };
  const observation: Observation = { httpCode: null };
  const { promise: timedOut, resolve: expire } = Promise.withResolvers<"timeout">();
  const deadline = setTimeout(() => {
    expire("timeout");
    controller.abort();
    lifetime.cancelBody?.();
  }, check.timeoutMs);
  try {
    const task = check.type === "http"
      ? checkHttp(check, options, lifetime, observation, elapsed)
      : options.connectTcp(check.host, check.port, controller.signal).then(() => undefined);
    let reason = await Promise.race([task, timedOut]);
    if (performance.now() - started >= check.timeoutMs) reason = "timeout";
    return {
      ok: reason === undefined,
      latencyMs: observation.latencyMs ?? elapsed(),
      httpCode: observation.httpCode,
      ...(reason === undefined ? {} : { reason }),
    };
  } catch {
    return {
      ok: false,
      latencyMs: observation.latencyMs ?? elapsed(),
      httpCode: observation.httpCode,
      reason: controller.signal.aborted ? "timeout" : check.type === "http" ? "request_failed" : "connect_failed",
    };
  } finally {
    clearTimeout(deadline);
  }
}

export async function runProbes(config: Config, options: ProbeOptions): Promise<Results> {
  const samples = new Array<[string, ProbeResult]>(config.checks.length);
  let next = 0;
  async function runNext(): Promise<void> {
    while (next < config.checks.length) {
      const index = next++;
      const check = config.checks[index];
      samples[index] = [check.id, await probe(check, options)];
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.checks.length, MAX_PARALLEL) }, () => runNext()));
  return Object.fromEntries(samples);
}
