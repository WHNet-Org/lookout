import { MINUTE_MS } from "./model.ts";
import type { AlertEvent, Delivery } from "./model.ts";
import type { createStore } from "./store.ts";

const DISCORD_CONTENT_LIMIT = 2_000;
const DISCORD_DELIVERY_PREFIX = "lookout-discord-";
const DISCORD_SUPPRESS_EMBEDS = 4;
const WEBHOOK_TIMEOUT_MS = 5_000;
const DELIVERIES_PER_TICK = 2;

const alertTitles = {
  outage: "Outage",
  impact: "New impact",
  recovery: "Recovery",
};

function discordName(name: string): string {
  const normalized = name.replace(/\s+/g, " ").trim();
  const shortened = normalized.length > 120 ? `${normalized.slice(0, 119).toWellFormed()}…` : normalized;
  return shortened.replace(/[\\`*_~|<>\[\]()]/g, "\\$&");
}

function packLines(lines: string[], limit: number): string[] {
  const messages: string[] = [];
  let content = "";
  for (const line of lines) {
    if (content.length + 1 + line.length > limit && content) {
      messages.push(content);
      content = "";
    }
    content = content ? `${content}\n${line}` : line;
  }
  if (content) messages.push(content);
  return messages;
}

function discordBlocks(event: AlertEvent): string[] {
  const { httpCode, latencyMs } = event.result;
  const measurement = httpCode === null ? `${latencyMs} ms` : `HTTP ${httpCode}, ${latencyMs} ms`;
  const heading = `${alertTitles[event.kind]} · ${discordName(event.check.name)} (${measurement})`;
  if (event.affected.length === 0) return [heading];

  const affected = packLines(
    event.affected.map(({ name }) => `• ${discordName(name)}`),
    DISCORD_CONTENT_LIMIT - heading.length - "\nAffected\n".length,
  );
  return affected.map((lines) => `${heading}\nAffected\n${lines}`);
}

export function prepareDeliveries(
  format: "json" | "discord",
  scheduledAt: number,
  events: AlertEvent[],
): Delivery[] {
  if (events.length === 0) return [];
  if (format === "json") {
    const id = `lookout-json-${scheduledAt}`;
    return [{ id, body: JSON.stringify({ delivery_id: id, scheduled_at: new Date(scheduledAt).toISOString(), events }) }];
  }

  return packLines(events.flatMap(discordBlocks), DISCORD_CONTENT_LIMIT).map((content, index) => ({
    id: `${DISCORD_DELIVERY_PREFIX}${scheduledAt}-${String(index + 1).padStart(3, "0")}`,
    body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: DISCORD_SUPPRESS_EMBEDS }),
  }));
}

function retryAfter(header: string | null, now: number): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const at = /^\d+(\.\d+)?$/.test(value)
    ? now + Math.ceil(Number(value) * 1_000)
    : Date.parse(value);
  return Number.isSafeInteger(at) && at > now ? at : undefined;
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

interface DeliveryOptions {
  fetch: typeof fetch;
  now: () => number;
  log(message: string): void;
}

export async function deliverQueued(
  store: ReturnType<typeof createStore>,
  url: string,
  { fetch, now, log }: DeliveryOptions,
): Promise<void> {
  for (let sent = 0; sent < DELIVERIES_PER_TICK; sent++) {
    const delivery = await store.claimDelivery(now());
    if (!delivery) return;

    let response: Response;
    try {
      const target = new URL(url);
      if (delivery.id.startsWith(DISCORD_DELIVERY_PREFIX)) target.searchParams.set("wait", "true");
      response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": delivery.id },
        body: delivery.body,
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch {
      log("Webhook delivery failed before a response arrived.");
      await store.retryDelivery(delivery, now() + delivery.attempts * MINUTE_MS);
      continue;
    }

    void response.body?.cancel().catch(() => {});
    if (response.ok) {
      await store.completeDelivery(delivery);
      continue;
    }

    log(`Webhook delivery failed (HTTP ${response.status}).`);
    if (retryable(response.status)) {
      const receivedAt = now();
      const pauseUntil = retryAfter(response.headers.get("Retry-After"), receivedAt);
      const availableAt = Math.max(receivedAt + delivery.attempts * MINUTE_MS, pauseUntil ?? receivedAt);
      await store.retryDelivery(delivery, availableAt, pauseUntil);
    } else {
      await store.completeDelivery(delivery);
    }
  }
}
