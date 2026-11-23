CREATE TABLE lookout_monitor_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL CHECK (json_valid(config_json))
) STRICT;
