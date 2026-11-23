import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBuildInfo } from "./build-info.ts";
import { readMonitorConfig } from "./config-file.ts";
import { MINUTE_MS, minuteAt } from "./model.ts";
import { createScheduler } from "./scheduler.ts";
import { migrateSqlite, sqliteDatabase } from "./sqlite.ts";
import { createStore } from "./store.ts";
import { createWebHandler } from "./web.ts";

const config = readMonitorConfig(process.env.LOOKOUT_CONFIG ?? "/etc/lookout/monitors.json");
const port = Number(process.env.PORT ?? 8787);
const host = process.env.LOOKOUT_HOST ?? "127.0.0.1";
const trustProxy = process.env.LOOKOUT_TRUST_PROXY === "1";

if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT.");
if (trustProxy && host !== "127.0.0.1" && host !== "::1") {
  throw new Error("LOOKOUT_TRUST_PROXY requires a loopback listener.");
}

const dbFile = resolve(process.env.LOOKOUT_DB ?? ".local/lookout.sqlite");
mkdirSync(dirname(dbFile), { recursive: true });
const database = new DatabaseSync(dbFile);
database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
migrateSqlite(database);
const store = createStore(sqliteDatabase(database));

const run = createScheduler({
  config,
  store,
  fetch: globalThis.fetch,
  connectTcp,
  getSecret: (name) => process.env[name],
  now: Date.now,
  log: (message) => console.warn(message),
});
const handle = createWebHandler({
  config,
  store,
  buildInfo: createBuildInfo(process.env.LOOKOUT_BUILD_SHA),
  privateUser: process.env.LOOKOUT_PRIVATE_USER,
  privatePassword: process.env.LOOKOUT_PRIVATE_PASSWORD,
});

const assets = new Map([
  ["/assets/lookout.svg", "image/svg+xml"],
  ["/assets/whnet-mosaic.svg", "image/svg+xml"],
  ["/assets/whnet-grid.svg", "image/svg+xml"],
  ["/assets/mosaic.css", "text/css; charset=utf-8"],
  ["/assets/styles.css", "text/css; charset=utf-8"],
  ["/assets/dashboard.js", "text/javascript; charset=utf-8"],
  ["/assets/embed-guide.js", "text/javascript; charset=utf-8"],
  ["/assets/lookout-status.js", "text/javascript; charset=utf-8"],
  ["/assets/lookout-status.css", "text/css; charset=utf-8"],
  ["/assets/whnet-mosaic-LICENSE.txt", "text/plain; charset=utf-8"],
  ["/assets/re2js-LICENSE.txt", "text/plain; charset=utf-8"],
]);

function connectTcp(host: string, port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = createConnection({ host, port });
    const close = () => {
      signal.removeEventListener("abort", abort);
      socket.destroy();
    };
    const abort = () => {
      close();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => {
      close();
      reject(error);
    });
    socket.once("connect", () => {
      close();
      resolve();
    });
  });
}

async function reply(response: Response, outgoing: ServerResponse, head = false): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(head || !response.body ? undefined : Buffer.from(await response.arrayBuffer()));
}

async function handleIncoming(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const { method = "GET", url = "/" } = incoming;
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    await reply(new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS", "Cache-Control": "no-store" },
    }), outgoing);
    return;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }

  // Use a fixed authority. A request target, Host, or forwarded host cannot change
  // which routes receive credentials. A local TLS proxy supplies the verified scheme.
  const secure = trustProxy && incoming.headers["x-forwarded-proto"] === "https";
  const authority = secure ? "https://lookout.local" : "http://lookout.local";
  if (!url.startsWith("/") || url.startsWith("//") || url.startsWith("/\\")) {
    await reply(new Response("Invalid request target", { status: 400 }), outgoing);
    return;
  }
  const request = new Request(authority + url, { method, headers });
  const path = new URL(request.url).pathname;
  const contentType = assets.get(path);

  if (contentType && (method === "GET" || method === "HEAD")) {
    const body = readFileSync(new URL(path.slice(1), new URL("../public/", import.meta.url)));
    await reply(new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
        ...(path === "/assets/lookout-status.js" || path === "/assets/lookout-status.css" ? { "Access-Control-Allow-Origin": "*" } : {}),
      },
    }), outgoing, method === "HEAD");
    return;
  }
  await reply(await handle(request), outgoing, method === "HEAD");
}

const server = createServer((incoming, outgoing) => {
  void handleIncoming(incoming, outgoing).catch(() => {
    console.error("Lookout request failed.");
    if (outgoing.headersSent) outgoing.destroy();
    else {
      outgoing.writeHead(500, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
      outgoing.end("Lookout is temporarily unavailable.");
    }
  });
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});

const address = server.address();
if (address && typeof address !== "string") console.log(`Lookout listening on ${host}:${address.port}`);

let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let inFlight: Promise<void>;

function schedule(at: number): void {
  if (stopping) return;
  inFlight = run(at)
    .catch(() => console.error("Scheduled Lookout run failed."))
    .finally(() => {
      if (stopping) return;
      const next = minuteAt(Date.now()) + MINUTE_MS;
      timer = setTimeout(() => schedule(next), Math.max(0, next - Date.now()));
    });
}

schedule(minuteAt(Date.now()));

function stop(): void {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  server.close(() => void inFlight.finally(() => database.close()));
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
