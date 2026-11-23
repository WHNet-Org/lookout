import { MINUTE_MS } from "../src/model.ts";

export const fixtureTokenName = "LOOKOUT_FIXTURE_TOKEN";
export const fixtureWebhookSecretName = "LOOKOUT_WEBHOOK_URL";
export const markerRegex = '^\\{"status":"ok"';
export const fixtureHealthIds = ["edge", "application", ...Array.from({ length: 17 }, (_, index) => `service-${index + 1}`)];

// Apply to the fixture D1 database. Change the mode through D1 SQL and query
// receipts there too; the public Worker only serves probes and accepts receipts.
export const fixtureSchema = `
CREATE TABLE IF NOT EXISTS fixture_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('healthy', 'cascade', 'dependent'))
) STRICT;
INSERT OR IGNORE INTO fixture_control (id, mode) VALUES (1, 'healthy');
CREATE TABLE IF NOT EXISTS webhook_receipts (
  delivery_id TEXT PRIMARY KEY,
  scheduled_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body))
) STRICT, WITHOUT ROWID;
`;

interface FixtureStatement {
  first<T>(column: string): Promise<T | null>;
  bind(...values: (string | number)[]): FixtureStatement;
  run(): Promise<unknown>;
}

export interface FixtureEnv {
  DB: { prepare(sql: string): FixtureStatement };
  LOOKOUT_FIXTURE_TOKEN?: string;
}

const BODY_BYTES = 16 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const SMALL_BODY = '{"status":"ok"}';
const paddingStart = '{"status":"ok","padding":"';
const paddingEnd = '"}';
const PADDED_BODY = paddingStart + "x".repeat(BODY_BYTES - paddingStart.length - paddingEnd.length) + paddingEnd;
const HEALTH_PATHS = new Set(fixtureHealthIds.map((id) => `/health/${id}`));
const encoder = new TextEncoder();

function reply(status: number, body: string | null = null): Response {
  return new Response(body, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
  });
}

async function authorized(actual: string | null, expected: string): Promise<boolean> {
  if (actual === null) return false;
  const [given, required] = await Promise.all([actual, expected].map((token) =>
    crypto.subtle.digest("SHA-256", encoder.encode(token))));
  const actualHash = new Uint8Array(given);
  const expectedHash = new Uint8Array(required);
  let difference = 0;
  for (let index = 0; index < actualHash.length; index++) difference |= actualHash[index] ^ expectedHash[index];
  return difference === 0;
}

async function health(path: string, env: FixtureEnv): Promise<Response> {
  if (path !== "/health/edge" && path !== "/health/application") return reply(200, PADDED_BODY);
  const mode = await env.DB.prepare("SELECT mode FROM fixture_control WHERE id = 1").first<string>("mode");
  const passes = mode === "healthy" || (mode === "dependent" && path === "/health/edge");
  return passes ? reply(200, SMALL_BODY) : reply(503, '{"status":"unavailable"}');
}

async function readReceipt(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length")) > MAX_RECEIPT_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return text + decoder.decode();
      total += next.value.byteLength;
      if (total > MAX_RECEIPT_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function receipt(request: Request, env: FixtureEnv): Promise<Response> {
  const id = request.headers.get("Idempotency-Key");
  if (!id || !/^lookout-json-\d+$/.test(id)) return reply(400);
  const body = await readReceipt(request);
  if (body === null) return reply(413);
  let data: { delivery_id?: unknown; scheduled_at?: unknown; events?: unknown } | null;
  try {
    data = JSON.parse(body);
  } catch {
    return reply(400);
  }
  const scheduledAt = typeof data?.scheduled_at === "string" ? Date.parse(data.scheduled_at) : NaN;
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt % MINUTE_MS !== 0 ||
    id !== `lookout-json-${scheduledAt}` || data?.delivery_id !== id ||
    !Array.isArray(data.events) || data.events.length === 0) return reply(400);
  await env.DB.prepare("INSERT OR IGNORE INTO webhook_receipts (delivery_id, scheduled_at, received_at, body) VALUES (?, ?, ?, ?)")
    .bind(id, scheduledAt, Date.now(), body).run();
  return reply(204);
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    const token = env.LOOKOUT_FIXTURE_TOKEN;
    if (!token) return reply(404);
    if (request.method === "GET" && HEALTH_PATHS.has(url.pathname) &&
      await authorized(request.headers.get("Authorization"), `Bearer ${token}`)) return health(url.pathname, env);
    if (request.method === "POST" && url.pathname === "/webhook" &&
      await authorized(url.searchParams.get("token"), token)) return receipt(request, env);
    return reply(404);
  },
};
