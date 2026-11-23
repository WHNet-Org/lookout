import { groupState, MINUTE_MS } from "./model.ts";
import type { AlertEvent, AlertState, Check, Config, ProbeResult, Results, Run } from "./model.ts";

function identity({ id, name }: Check): { id: string; name: string } {
  return { id, name };
}

export function evaluateRun(config: Config, scheduledAt: number, results: Results, previous: Run | null): {
  run: Run;
  events: AlertEvent[];
} {
  const events: AlertEvent[] = [];
  const states = new Map<string, AlertState>();
  const failing = new Map<string, { check: Check; result: ProbeResult; state: AlertState }>();
  const consecutive = previous?.scheduledAt === scheduledAt - MINUTE_MS;

  for (const check of config.checks) {
    const result = Object.hasOwn(results, check.id) ? results[check.id] : undefined;
    const prior = previous && Object.hasOwn(previous.alertStates, check.id)
      ? previous.alertStates[check.id] : undefined;
    const failed = result?.ok === false;
    const state: AlertState = {
      streak: failed ? 1 + (consecutive ? prior?.streak ?? 0 : 0) : 0,
      reported: [],
    };
    if (prior?.incidentId && result?.ok !== true) {
      state.incidentId = prior.incidentId;
      state.reported = prior.reported;
    }
    states.set(check.id, state);
    if (failed) failing.set(check.id, { check, result, state });
    if (result?.ok && prior?.incidentId && !check.alert.muted) {
      events.push({ kind: "recovery", incidentId: prior.incidentId, check: identity(check), result, affected: [] });
    }
  }

  const roots = new Map<string, Set<string>>();
  // Resolve all fresh failures together. An existing independent outage stays open through a later cascade.
  function failureRoots(id: string): Set<string> {
    const cached = roots.get(id);
    if (cached) return cached;
    const failed = failing.get(id);
    const result = new Set<string>();
    if (failed) {
      if (!failed.state.incidentId) {
        for (const dependency of failed.check.dependsOn) {
          for (const root of failureRoots(dependency)) result.add(root);
        }
      }
      if (result.size === 0) result.add(id);
    }
    roots.set(id, result);
    return result;
  }

  const impacts = new Map<string, Check[]>();
  for (const [id, { check }] of failing) {
    if (check.alert.muted) continue;
    for (const root of failureRoots(id)) {
      if (root === id) continue;
      const checks = impacts.get(root) ?? [];
      checks.push(check);
      impacts.set(root, checks);
    }
  }

  for (const [id, { check, result, state }] of failing) {
    if (check.alert.muted || !failureRoots(id).has(id)) continue;
    const newlyAffected = (impacts.get(id) ?? []).filter((item) => !state.reported.includes(item.id));
    const affected = newlyAffected.map(identity);
    const reported = [...state.reported, ...newlyAffected.map((item) => item.id)];
    if (!state.incidentId && state.streak >= check.alert.threshold) {
      state.incidentId = `${id}:${scheduledAt}`;
      state.reported = reported;
      events.push({ kind: "outage", incidentId: state.incidentId, check: identity(check), result, affected });
    } else if (state.incidentId && affected.length > 0) {
      state.reported = reported;
      events.push({ kind: "impact", incidentId: state.incidentId, check: identity(check), result, affected });
    }
  }

  return {
    run: {
      scheduledAt,
      results,
      alertStates: Object.fromEntries(states),
      groupStates: Object.fromEntries(config.groups.map((group) => [group.id, groupState(group, results)])),
    },
    events,
  };
}
