import { connect } from "cloudflare:sockets";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import type { Config, Results } from "./model.ts";
import { createScheduler } from "./scheduler.ts";
import { createStore } from "./store.ts";
import type { SqlDatabase } from "./store.ts";

interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  LOOKOUT_PRIVATE_USER?: string;
  LOOKOUT_PRIVATE_PASSWORD?: string;
  [name: string]: unknown;
}

interface WorkerContext {
  exports: { ProbeBatch: { run(ids: string[]): Promise<Results> } };
}

const PROBE_BATCH_SIZE = 5;

function workerDatabase(database: D1Database): SqlDatabase {
  const result = (value: { results?: Record<string, unknown>[]; meta: { changes?: number } }) => ({
    rows: value.results ?? [],
    changes: value.meta.changes ?? 0,
  });

  return {
    async execute(sql, params = []) {
      return result(await database.prepare(sql).bind(...params).all());
    },
    async batch(statements) {
      const batch = statements.map(({ sql, params = [] }) => database.prepare(sql).bind(...params));
      return (await database.batch<Record<string, unknown>>(batch)).map(result);
    },
  };
}

async function connectTcp(hostname: string, port: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const socket = connect({ hostname, port });
  const close = () => { void socket.close().catch(() => {}); };
  signal.addEventListener("abort", close, { once: true });
  // Observe both socket promises so a refused connection cannot become unhandled.
  void socket.closed.catch(() => {});
  try {
    await socket.opened;
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}

function probeOptions(env: Env) {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    connectTcp,
    getSecret: (name: string) => typeof env[name] === "string" ? env[name] : undefined,
  };
}

export function createWorker(config: Config) {
  const checksById = new Map(config.checks.map((check) => [check.id, check]));
  const ids = config.checks.map(({ id }) => id);
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += PROBE_BATCH_SIZE) {
    batches.push(ids.slice(start, start + PROBE_BATCH_SIZE));
  }

  class ProbeBatch extends WorkerEntrypoint<Env> {
    async run(ids: string[]): Promise<Results> {
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > PROBE_BATCH_SIZE || new Set(ids).size !== ids.length) {
        throw new TypeError("Invalid probe batch.");
      }
      const checks = Array.from(ids, (id) => {
        const check = checksById.get(id);
        if (!check) throw new TypeError("Unknown probe check.");
        return check;
      });
      const { runProbes } = await import("./probe.ts");
      return runProbes({ ...config, checks }, probeOptions(this.env));
    }
  }

  const handler = {
    async fetch(request: Request, env: Env): Promise<Response> {
      if (new URL(request.url).pathname.startsWith("/assets/")) return env.ASSETS.fetch(request);

      const { createWebHandler } = await import("./web.ts");
      const handle = createWebHandler({
        config,
        store: createStore(workerDatabase(env.DB)),
        privateUser: env.LOOKOUT_PRIVATE_USER,
        privatePassword: env.LOOKOUT_PRIVATE_PASSWORD,
      });
      return handle(request);
    },

    async scheduled(controller: { scheduledTime: number }, env: Env, ctx: WorkerContext): Promise<void> {
      const run = createScheduler({
        config,
        store: createStore(workerDatabase(env.DB)),
        ...probeOptions(env),
        async collectResults() {
          const results: Results = Object.create(null);
          // Loopback calls share the top-level connection limit. Await each batch
          // so they cannot have more than five probes in flight across calls.
          for (const batch of batches) {
            Object.assign(results, await ctx.exports.ProbeBatch.run(batch));
          }
          return results;
        },
        now: Date.now,
        log: (message) => console.warn(message),
      });
      await run(controller.scheduledTime);
    },
  };
  return { handler, ProbeBatch };
}
