import { evaluateRun } from "./engine.ts";
import { minuteAt } from "./model.ts";
import type { Config, Results } from "./model.ts";
import type { createStore } from "./store.ts";
import { deliverQueued, prepareDeliveries } from "./webhook.ts";

interface SchedulerOptions {
  config: Config;
  store: ReturnType<typeof createStore>;
  fetch: typeof fetch;
  connectTcp(host: string, port: number, signal: AbortSignal): Promise<void>;
  getSecret(name: string): string | undefined;
  collectResults?(): Promise<Results>;
  now: () => number;
  log(message: string): void;
}

export function createScheduler(options: SchedulerOptions) {
  const { config, store, getSecret, now, log } = options;
  const collectResults = options.collectResults ?? (async () => {
    const { runProbes } = await import("./probe.ts");
    return runProbes(config, options);
  });
  return async (scheduled: number): Promise<void> => {
    const scheduledAt = minuteAt(scheduled);
    let previous = await store.latest();
    if (previous && previous.scheduledAt >= scheduledAt) return;

    const results = await collectResults();
    const target = webhookUrl(config, getSecret);
    if (config.webhook && !target) log("The configured webhook secret is missing or invalid.");

    // Concurrent invocations may finish out of order. Reuse the observations, but
    // recalculate transitions from the newest committed alert state.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { run, events } = evaluateRun(config, scheduledAt, results, previous);
      const deliveries = config.webhook ? prepareDeliveries(config.webhook.format, scheduledAt, events) : [];
      if (!config.webhook) run.alertStates = {};
      if (await store.commit(run, previous?.scheduledAt ?? null, deliveries)) {
        if (target) await deliverQueued(store, target, options);
        return;
      }
      previous = await store.latest();
      if (previous && previous.scheduledAt >= scheduledAt) return;
    }
    throw new Error("Could not commit scheduled observations after concurrent updates.");
  };
}

function webhookUrl(config: Config, getSecret: SchedulerOptions["getSecret"]): string | undefined {
  if (!config.webhook) return undefined;
  const raw = getSecret(config.webhook.urlSecret);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return undefined;
    }
    if (config.webhook.format === "discord" && url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
