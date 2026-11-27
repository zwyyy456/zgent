ALTER TABLE projects ADD COLUMN personal INTEGER NOT NULL DEFAULT 0 CHECK (personal IN (0,1));
ALTER TABLE projects ADD COLUMN recent_checkout TEXT;
ALTER TABLE main_sessions ADD COLUMN checkout TEXT;
ALTER TABLE main_sessions ADD COLUMN default_worker TEXT;
ALTER TABLE main_sessions ADD COLUMN base_mode TEXT NOT NULL DEFAULT 'head' CHECK (base_mode IN ('head','snapshot'));
ALTER TABLE main_turns ADD COLUMN base_mode TEXT NOT NULL DEFAULT 'head' CHECK (base_mode IN ('head','snapshot'));
ALTER TABLE main_turns ADD COLUMN base_oid TEXT;
ALTER TABLE main_turns ADD COLUMN resume_task_id TEXT REFERENCES tasks(task_id);
ALTER TABLE main_turns ADD COLUMN summary_of TEXT REFERENCES main_turns(turn_id);
CREATE UNIQUE INDEX main_turn_summary ON main_turns(summary_of) WHERE summary_of IS NOT NULL;

CREATE TABLE task_applications (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
  checkout TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applying','applied','needs_confirmation')),
  applied_at_ms INTEGER
) STRICT;

CREATE TABLE workspaces_next (
  workspace_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  managed_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_commit_oid TEXT NOT NULL CHECK (length(base_commit_oid) IN (40,64) AND base_commit_oid NOT GLOB '*[^0-9a-f]*'),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('read_only','workspace_write')),
  state TEXT NOT NULL DEFAULT 'allocating' CHECK (state IN (
    'allocating','ready','in_use','retained','quarantined','removing','removed','allocation_failed'
  )),
  quarantine_reason TEXT,
  last_observed_head_oid TEXT,
  dirty_state TEXT NOT NULL DEFAULT 'unknown' CHECK (dirty_state IN ('unknown','clean','dirty')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  removed_at_ms INTEGER,
  UNIQUE (project_id, branch_name),
  UNIQUE (workspace_id, task_id),
  CHECK ((state = 'removed') = (removed_at_ms IS NOT NULL)),
  CHECK (state <> 'quarantined' OR quarantine_reason IS NOT NULL)
) STRICT;
INSERT INTO workspaces_next SELECT * FROM workspaces;
DROP TABLE workspaces;
ALTER TABLE workspaces_next RENAME TO workspaces;
CREATE UNIQUE INDEX workspaces_live_path ON workspaces(managed_path) WHERE state <> 'removed';
CREATE INDEX workspaces_reconcile ON workspaces(project_id, state);

CREATE TRIGGER workspace_project_guard BEFORE INSERT ON workspaces
WHEN NOT EXISTS (
  SELECT 1 FROM tasks t JOIN profile_revisions p
    ON p.profile_id=t.profile_id AND p.revision=t.profile_revision
  WHERE t.task_id=NEW.task_id AND t.project_id=NEW.project_id
    AND t.base_commit_oid=NEW.base_commit_oid AND p.access_mode=NEW.access_mode
)
BEGIN SELECT RAISE(ABORT, 'workspace contract does not match accepted task'); END;
