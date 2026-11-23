export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export interface AlertPolicy {
  threshold: number;
  muted: boolean;
}

interface CheckBase {
  id: string;
  name: string;
  visibility: "public" | "private";
  dependsOn: string[];
  timeoutMs: number;
  alert: AlertPolicy;
}

export interface HttpCheck extends CheckBase {
  type: "http";
  url: string;
  method: "GET" | "HEAD";
  expectedCodes?: number[];
  headers?: Record<string, string | { secret: string }>;
  bodyRegex?: string;
  redirects?: { maxHops: number; allowedOrigins: string[] };
}

export interface TcpCheck extends CheckBase {
  type: "tcp";
  host: string;
  port: number;
}

export type Check = HttpCheck | TcpCheck;

export interface Group {
  id: string;
  name: string;
  visibility: "private" | "detailed" | "aggregate";
  checks: string[];
}

export interface Config {
  checks: Check[];
  groups: Group[];
  defaultGroup?: string;
  allowedOrigins: string[];
  webhook?: { format: "json" | "discord"; urlSecret: string };
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  httpCode: number | null;
  reason?: string;
}

export type Results = Record<string, ProbeResult>;
export type GroupState = "operational" | "outage" | "degraded" | "unknown";

export interface AlertState {
  streak: number;
  incidentId?: string;
  reported: string[];
}

export type AlertStates = Record<string, AlertState>;

interface CheckIdentity {
  id: string;
  name: string;
}

export interface AlertEvent {
  kind: "outage" | "impact" | "recovery";
  incidentId: string;
  check: CheckIdentity;
  result: ProbeResult;
  affected: CheckIdentity[];
}

export interface Run {
  scheduledAt: number;
  results: Results;
  alertStates: AlertStates;
  groupStates: Record<string, GroupState>;
}

export interface Delivery {
  id: string;
  body: string;
}

export interface DailyRollup {
  id: string;
  day: number;
  observed: number;
  up: number;
  latencySum: number | null;
}

export interface HistoryEntry {
  scheduledAt: number;
  result: ProbeResult;
}

export interface Store {
  latest(): Promise<Run | null>;
  commit(run: Run, previousAt: number | null, deliveries: Delivery[]): Promise<boolean>;
  daily(kind: "check" | "group", ids: string[], fromDay: number): Promise<DailyRollup[]>;
  history(id: string, from: number, until: number): Promise<HistoryEntry[]>;
}

export function minuteAt(now: number): number {
  return Math.floor(now / MINUTE_MS) * MINUTE_MS;
}

export function currentResult(run: Run | null, id: string, now: number): ProbeResult | undefined {
  const minute = minuteAt(now);
  if (!run || run.scheduledAt > minute || minute - run.scheduledAt >= 3 * MINUTE_MS) {
    return undefined;
  }
  return Object.hasOwn(run.results, id) ? run.results[id] : undefined;
}

export function groupState(group: Group, results: Results): GroupState {
  if (group.checks.length === 0) return "unknown";
  let up = 0;
  let down = 0;
  for (const id of group.checks) {
    const result = Object.hasOwn(results, id) ? results[id] : undefined;
    if (result?.ok === true) up++;
    if (result?.ok === false) down++;
  }
  if (up === group.checks.length) return "operational";
  if (down === group.checks.length) return "outage";
  return down > 0 ? "degraded" : "unknown";
}
