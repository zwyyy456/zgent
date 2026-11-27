CREATE TABLE main_sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  client_id TEXT NOT NULL UNIQUE REFERENCES clients(client_id),
  previous_session_id TEXT REFERENCES main_sessions(session_id),
  title TEXT NOT NULL,
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  native_session_id TEXT,
  runtime_version TEXT,
  state TEXT NOT NULL CHECK (state IN ('ready','running','waiting_input','stopping','disconnected','closed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX main_sessions_project ON main_sessions(project_id, updated_at_ms DESC);

CREATE TABLE main_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES main_sessions(session_id),
  input_sha256 TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('running','completed','cancelled','disconnected','failed')),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  error_summary TEXT,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER
) STRICT;
CREATE INDEX main_turns_session ON main_turns(session_id, created_at_ms);
