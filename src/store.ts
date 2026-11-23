import { MINUTE_MS } from "./model.ts";
import type { Delivery, GroupState, ProbeResult, Run, Store } from "./model.ts";

export type SqlValue = string | number | null;

interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  changes: number;
}

export interface SqlDatabase {
  execute(sql: string, params?: SqlValue[]): Promise<SqlResult>;
  batch(statements: SqlStatement[]): Promise<SqlResult[]>;
}

const DELIVERY_LIFETIME_MS = 60 * MINUTE_MS;
const DELIVERY_LEASE_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 3;

interface ClaimedDelivery extends Delivery {
  attempts: number;
  expiresAt: number;
  leaseToken: string;
}

interface StoreWithOutbox extends Store {
  claimDelivery(now: number): Promise<ClaimedDelivery | null>;
  completeDelivery(delivery: ClaimedDelivery): Promise<void>;
  retryDelivery(delivery: ClaimedDelivery, availableAt: number, pauseUntil?: number): Promise<void>;
}

function decodeJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export function createStore(db: SqlDatabase): StoreWithOutbox {
  return {
    async latest() {
      const { rows: [row] } = await db.execute(
        `SELECT scheduled_at, results, alert_states, group_states
         FROM runs ORDER BY scheduled_at DESC LIMIT 1`,
      );
      if (!row) return null;
      return {
        scheduledAt: Number(row.scheduled_at),
        results: decodeJson<Run["results"]>(row.results),
        alertStates: decodeJson<Run["alertStates"]>(row.alert_states),
        groupStates: decodeJson<Record<string, GroupState>>(row.group_states),
      };
    },

    async commit(run, previousAt, deliveries) {
      const { changes } = await db.execute(
        `INSERT INTO runs (scheduled_at, results, alert_states, group_states, deliveries)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE (SELECT scheduled_at FROM runs ORDER BY scheduled_at DESC LIMIT 1) IS ?6
           AND (?6 IS NULL OR ?1 > ?6)`,
        [
          run.scheduledAt,
          JSON.stringify(run.results),
          JSON.stringify(run.alertStates),
          JSON.stringify(run.groupStates),
          JSON.stringify(deliveries),
          previousAt,
        ],
      );
      return changes > 0;
    },

    async daily(kind, ids, fromDay) {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(", ");
      const { rows } = await db.execute(
        `SELECT id, day, observed, up, latency_sum FROM daily_rollups
         WHERE day >= ? AND kind = ? AND id IN (${placeholders})
         ORDER BY day, id`,
        [fromDay, kind, ...ids],
      );
      return rows.map((row) => ({
        id: String(row.id),
        day: Number(row.day),
        observed: Number(row.observed),
        up: Number(row.up),
        latencySum: row.latency_sum === null ? null : Number(row.latency_sum),
      }));
    },

    async history(id, from, until) {
      const { rows } = await db.execute(
        `SELECT scheduled_at, results->?1 AS probe FROM runs
         WHERE scheduled_at >= ?2 AND scheduled_at < ?3
           AND json_type(results, ?1) = 'object'
         ORDER BY scheduled_at DESC`,
        [`$."${id}"`, from, until],
      );
      return rows.map((row) => ({
        scheduledAt: Number(row.scheduled_at),
        result: decodeJson<ProbeResult>(row.probe),
      }));
    },

    async claimDelivery(now) {
      const leaseToken = crypto.randomUUID();
      // Choose the oldest entry before checking eligibility so later messages
      // cannot pass a leased or delayed outage.
      const { rows: [row] } = await db.execute(
        `UPDATE webhook_queue
         SET attempts = attempts + 1, lease_until = ?1, lease_token = ?2
         WHERE id = (
           SELECT id FROM webhook_queue
           WHERE queued_at > ?4 AND (attempts < ?5 OR lease_until > ?3)
           ORDER BY queued_at, id
           LIMIT 1
         )
           AND available_at <= ?3 AND attempts < ?5
           AND (lease_until IS NULL OR lease_until <= ?3)
           AND NOT EXISTS (SELECT 1 FROM webhook_pause WHERE resume_at > ?3)
         RETURNING id, body, attempts, queued_at`,
        [now + DELIVERY_LEASE_MS, leaseToken, now, now - DELIVERY_LIFETIME_MS, MAX_DELIVERY_ATTEMPTS],
      );
      if (!row) return null;
      return {
        id: String(row.id),
        body: String(row.body),
        attempts: Number(row.attempts),
        expiresAt: Number(row.queued_at) + DELIVERY_LIFETIME_MS,
        leaseToken,
      };
    },

    async completeDelivery({ id, leaseToken }) {
      await db.execute("DELETE FROM webhook_queue WHERE id = ? AND lease_token = ?", [id, leaseToken]);
    },

    async retryDelivery(delivery, availableAt, pauseUntil) {
      const { id, leaseToken, expiresAt, attempts } = delivery;
      const queueChange = attempts < MAX_DELIVERY_ATTEMPTS && availableAt < expiresAt
        ? {
            sql: `UPDATE webhook_queue SET available_at = ?, lease_until = NULL, lease_token = NULL
                  WHERE id = ? AND lease_token = ?`,
            params: [availableAt, id, leaseToken],
          }
        : {
            sql: "DELETE FROM webhook_queue WHERE id = ? AND lease_token = ?",
            params: [id, leaseToken],
          };
      if (pauseUntil === undefined) {
        await db.execute(queueChange.sql, queueChange.params);
        return;
      }
      await db.batch([
        {
          sql: `INSERT INTO webhook_pause (id, resume_at)
                SELECT 1, ? FROM webhook_queue WHERE id = ? AND lease_token = ?
                ON CONFLICT (id) DO UPDATE SET resume_at = max(resume_at, excluded.resume_at)`,
          params: [pauseUntil, id, leaseToken],
        },
        queueChange,
      ]);
    },
  };
}
