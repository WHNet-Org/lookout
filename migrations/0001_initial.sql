CREATE TABLE runs (
  scheduled_at INTEGER PRIMARY KEY,
  results TEXT NOT NULL,
  alert_states TEXT NOT NULL,
  group_states TEXT NOT NULL,
  deliveries TEXT NOT NULL
) STRICT;

CREATE TABLE daily_rollups (
  day INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('check', 'group')),
  id TEXT NOT NULL,
  observed INTEGER NOT NULL,
  up INTEGER NOT NULL,
  latency_sum INTEGER,
  PRIMARY KEY (kind, id, day)
) STRICT, WITHOUT ROWID;

CREATE TABLE webhook_queue (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  queued_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  lease_token TEXT
) STRICT, WITHOUT ROWID;

CREATE TABLE webhook_pause (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  resume_at INTEGER NOT NULL
) STRICT;

-- A rejected run does not fire this trigger. One accepted insert commits
-- observations, daily counters, alert state, and webhook deliveries together.
CREATE TRIGGER commit_run AFTER INSERT ON runs BEGIN
  INSERT INTO daily_rollups (day, kind, id, observed, up, latency_sum)
    SELECT NEW.scheduled_at - NEW.scheduled_at % 86400000,
           'check', key, 1, value->>'$.ok',
           CASE WHEN value->>'$.ok' THEN value->>'$.latencyMs' ELSE 0 END
    FROM json_each(NEW.results)
    WHERE true
    ON CONFLICT (kind, id, day) DO UPDATE SET
      observed = observed + excluded.observed,
      up = up + excluded.up,
      latency_sum = latency_sum + excluded.latency_sum;

  INSERT INTO daily_rollups (day, kind, id, observed, up, latency_sum)
    SELECT NEW.scheduled_at - NEW.scheduled_at % 86400000,
           'group', key, 1, value = 'operational', NULL
    FROM json_each(NEW.group_states)
    WHERE value <> 'unknown'
    ON CONFLICT (kind, id, day) DO UPDATE SET
      observed = observed + excluded.observed,
      up = up + excluded.up;

  INSERT INTO webhook_queue (id, body, queued_at, available_at)
    SELECT value->>'$.id', value->>'$.body', NEW.scheduled_at, NEW.scheduled_at
    FROM json_each(NEW.deliveries);

  -- Delivery bodies live in the outbox only while needed.
  UPDATE runs SET deliveries = '[]'
    WHERE scheduled_at = NEW.scheduled_at AND NEW.deliveries <> '[]';

  DELETE FROM runs WHERE scheduled_at <= NEW.scheduled_at - 14 * 86400000;
  -- The first committed run of a UTC day can prune all obsolete day buckets.
  DELETE FROM daily_rollups
    WHERE day < NEW.scheduled_at - NEW.scheduled_at % 86400000 - 13 * 86400000
      AND NOT EXISTS (
        SELECT 1 FROM runs
        WHERE scheduled_at >= NEW.scheduled_at - NEW.scheduled_at % 86400000
          AND scheduled_at < NEW.scheduled_at
      );
  DELETE FROM webhook_queue WHERE queued_at <= NEW.scheduled_at - 3600000;
END;
