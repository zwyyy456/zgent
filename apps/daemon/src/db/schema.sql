-- Local Agent Orchestrator — design schema v1 (2026-11-26).
-- Specification artifact, not an application or an installed database.
-- Execute on a local filesystem. All timestamps are UTC Unix milliseconds.
-- Runtime prerequisite: SQLite >= 3.51.3 with JSON functions enabled.
-- STRICT syntax requires >= 3.37; the higher baseline includes the 2026 WAL-reset fix.
-- Every connection must set foreign_keys and busy_timeout. journal_mode is persistent.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

BEGIN IMMEDIATE;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT;

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind = 'local_owner'),
  label TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;
-- P0 is one local owner per data directory. This is not an OS security sandbox.
CREATE UNIQUE INDEX one_local_owner ON principals(kind);

CREATE TABLE clients (
  client_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  kind TEXT NOT NULL CHECK (kind IN ('agent_client','human_ui','system')),
  label TEXT NOT NULL,
  host_kind TEXT NOT NULL,
  credential_fingerprint TEXT UNIQUE,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  revoked_at_ms INTEGER,
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  label TEXT NOT NULL,
  canonical_root TEXT NOT NULL UNIQUE,
  git_common_dir TEXT NOT NULL UNIQUE,
  approved_base_ref TEXT NOT NULL,
  managed_worktree_root TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled','quarantined')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE client_project_grants (
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  can_submit INTEGER NOT NULL DEFAULT 0 CHECK (can_submit IN (0,1)),
  read_scope TEXT NOT NULL DEFAULT 'own' CHECK (read_scope IN ('none','own','project')),
  control_scope TEXT NOT NULL DEFAULT 'own' CHECK (control_scope IN ('none','own','project')),
  can_read_artifacts INTEGER NOT NULL DEFAULT 0 CHECK (can_read_artifacts IN (0,1)),
  granted_at_ms INTEGER NOT NULL CHECK (granted_at_ms >= 0),
  PRIMARY KEY (client_id, project_id)
) STRICT;

CREATE TABLE profiles (
  profile_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE profile_revisions (
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('codex_app_server','claude_agent_sdk','antigravity_acp')),
  model_id TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('read_only','workspace_write')),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  config_sha256 TEXT NOT NULL CHECK (length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (profile_id, revision)
) STRICT;

CREATE TABLE client_profile_grants (
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
  granted_at_ms INTEGER NOT NULL CHECK (granted_at_ms >= 0),
  PRIMARY KEY (client_id, profile_id)
) STRICT;

CREATE TABLE daemon_epochs (
  epoch_id TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  process_birth_identity TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  last_heartbeat_at_ms INTEGER NOT NULL CHECK (last_heartbeat_at_ms >= started_at_ms),
  stopped_at_ms INTEGER,
  CHECK (stopped_at_ms IS NULL OR stopped_at_ms >= started_at_ms)
) STRICT;

CREATE TABLE daemon_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_epoch_id TEXT REFERENCES daemon_epochs(epoch_id),
  global_max_active_attempts INTEGER NOT NULL DEFAULT 2 CHECK (global_max_active_attempts BETWEEN 1 AND 16),
  protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version = 1),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  created_by_client_id TEXT NOT NULL REFERENCES clients(client_id),
  conversation_tag TEXT,
  parent_task_id TEXT REFERENCES tasks(task_id),
  retry_of_task_id TEXT REFERENCES tasks(task_id),
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  task_spec_json TEXT NOT NULL CHECK (json_valid(task_spec_json)),
  task_spec_sha256 TEXT NOT NULL CHECK (length(task_spec_sha256) = 64 AND task_spec_sha256 NOT GLOB '*[^0-9a-f]*'),
  base_commit_oid TEXT NOT NULL CHECK (length(base_commit_oid) IN (40,64) AND base_commit_oid NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued','starting','running','waiting_input','cancelling','recovering',
    'succeeded','failed','cancelled','interrupted'
  )),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  desired_action TEXT NOT NULL DEFAULT 'run' CHECK (desired_action IN ('run','cancel')),
  cancel_requested_at_ms INTEGER,
  cancel_reason TEXT,
  deadline_at_ms INTEGER,
  result_summary_json TEXT CHECK (result_summary_json IS NULL OR json_valid(result_summary_json)),
  review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_state IN ('unreviewed','accepted','rejected')),
  reviewed_by_client_id TEXT REFERENCES clients(client_id),
  reviewed_at_ms INTEGER,
  error_code TEXT,
  error_detail_json TEXT CHECK (error_detail_json IS NULL OR json_valid(error_detail_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  finished_at_ms INTEGER,
  FOREIGN KEY (profile_id, profile_revision) REFERENCES profile_revisions(profile_id, revision),
  CHECK ((desired_action = 'cancel') = (cancel_requested_at_ms IS NOT NULL)),
  CHECK (cancel_requested_at_ms IS NULL OR cancel_requested_at_ms >= created_at_ms),
  CHECK (deadline_at_ms IS NULL OR deadline_at_ms >= created_at_ms),
  CHECK ((state IN ('succeeded','failed','cancelled','interrupted')) = (finished_at_ms IS NOT NULL)),
  CHECK (finished_at_ms IS NULL OR finished_at_ms >= created_at_ms),
  CHECK (
    (review_state = 'unreviewed' AND reviewed_by_client_id IS NULL AND reviewed_at_ms IS NULL)
    OR (review_state <> 'unreviewed' AND reviewed_by_client_id IS NOT NULL AND reviewed_at_ms IS NOT NULL)
  ),
  CHECK (parent_task_id IS NULL OR parent_task_id <> task_id),
  CHECK (retry_of_task_id IS NULL OR retry_of_task_id <> task_id)
) STRICT;
CREATE INDEX tasks_queue ON tasks(state, created_at_ms);
CREATE INDEX tasks_project_read ON tasks(project_id, created_at_ms);
CREATE INDEX tasks_client_read ON tasks(created_by_client_id, project_id, created_at_ms);
CREATE INDEX tasks_parent ON tasks(parent_task_id);

CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  managed_path TEXT NOT NULL UNIQUE,
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
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  removed_at_ms INTEGER,
  UNIQUE (project_id, branch_name),
  UNIQUE (workspace_id, task_id),
  CHECK ((state = 'removed') = (removed_at_ms IS NOT NULL)),
  CHECK (state <> 'quarantined' OR quarantine_reason IS NOT NULL)
) STRICT;
CREATE INDEX workspaces_reconcile ON workspaces(project_id, state);

CREATE TABLE run_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  workspace_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN (
    'prepared','starting','running','waiting_input','cancelling','recovering',
    'succeeded','failed','cancelled','interrupted'
  )),
  owner_epoch_id TEXT NOT NULL REFERENCES daemon_epochs(epoch_id),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  provider_start_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (provider_start_status IN (
    'not_sent','send_intent_recorded','acknowledged'
  )),
  runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('codex_app_server','claude_agent_sdk','antigravity_acp')),
  runtime_instance_id TEXT UNIQUE,
  executable_fingerprint TEXT,
  process_pid INTEGER CHECK (process_pid IS NULL OR process_pid > 0),
  process_birth_identity TEXT,
  supervision_json TEXT CHECK (supervision_json IS NULL OR json_valid(supervision_json)),
  provider_session_id TEXT,
  provider_thread_id TEXT,
  provider_turn_id TEXT,
  provider_version TEXT,
  provider_model_id TEXT,
  capabilities_json TEXT CHECK (capabilities_json IS NULL OR json_valid(capabilities_json)),
  last_runtime_event_at_ms INTEGER,
  last_liveness_probe_at_ms INTEGER,
  process_stop_confirmed_at_ms INTEGER,
  exit_code INTEGER,
  termination_reason TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  finished_at_ms INTEGER,
  UNIQUE (task_id, attempt_no),
  UNIQUE (attempt_id, task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES workspaces(workspace_id, task_id),
  CHECK ((state IN ('succeeded','failed','cancelled','interrupted')) = (finished_at_ms IS NOT NULL)),
  CHECK (state <> 'interrupted' OR process_stop_confirmed_at_ms IS NOT NULL),
  CHECK (finished_at_ms IS NULL OR finished_at_ms >= created_at_ms),
  CHECK (process_stop_confirmed_at_ms IS NULL OR process_stop_confirmed_at_ms >= created_at_ms),
  CHECK (process_pid IS NULL OR process_birth_identity IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX one_live_attempt_per_task ON run_attempts(task_id) WHERE finished_at_ms IS NULL;
CREATE INDEX attempts_recovery ON run_attempts(owner_epoch_id, state);

CREATE TABLE pending_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT NOT NULL,
  runtime_instance_id TEXT NOT NULL,
  runtime_request_key TEXT NOT NULL,
  owner_epoch_id TEXT NOT NULL REFERENCES daemon_epochs(epoch_id),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  kind TEXT NOT NULL CHECK (kind IN (
    'command_approval','file_approval','permission_grant','user_question','billing_confirmation'
  )),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending','decision_recorded','provider_resolved','invalidated','expired'
  )),
  delivery_state TEXT NOT NULL DEFAULT 'not_sent' CHECK (delivery_state IN ('not_sent','sent','delivery_unknown')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  allowed_decisions_json TEXT NOT NULL CHECK (json_valid(allowed_decisions_json)),
  expires_at_ms INTEGER,
  decision_json TEXT CHECK (decision_json IS NULL OR json_valid(decision_json)),
  decided_by_client_id TEXT REFERENCES clients(client_id),
  decided_at_ms INTEGER,
  response_sent_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE (attempt_id, runtime_request_key),
  FOREIGN KEY (attempt_id, task_id) REFERENCES run_attempts(attempt_id, task_id),
  CHECK (
    (decision_json IS NULL AND decided_by_client_id IS NULL AND decided_at_ms IS NULL)
    OR (decision_json IS NOT NULL AND decided_by_client_id IS NOT NULL AND decided_at_ms IS NOT NULL)
  ),
  CHECK (state NOT IN ('decision_recorded','provider_resolved') OR decision_json IS NOT NULL),
  CHECK (delivery_state <> 'sent' OR response_sent_at_ms IS NOT NULL)
) STRICT;
CREATE INDEX pending_requests_open ON pending_requests(task_id, state, created_at_ms);

CREATE TABLE idempotency_keys (
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  operation TEXT NOT NULL CHECK (operation IN (
    'delegate_task','send_to_task','cancel_task','resolve_pending_request','review_task'
  )),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  canonical_payload_sha256 TEXT NOT NULL CHECK (
    length(canonical_payload_sha256) = 64 AND canonical_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('in_progress','completed','failed')),
  task_id TEXT REFERENCES tasks(task_id),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  PRIMARY KEY (client_id, operation, request_id),
  CHECK (state = 'in_progress' OR response_json IS NOT NULL)
) STRICT;

CREATE TABLE task_commands (
  command_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT,
  created_by_client_id TEXT NOT NULL REFERENCES clients(client_id),
  operation TEXT NOT NULL CHECK (operation IN ('send_to_task','cancel_task')),
  request_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued','send_intent_recorded','acknowledged','rejected','delivery_unknown'
  )),
  expected_fencing_token INTEGER,
  provider_receipt_json TEXT CHECK (provider_receipt_json IS NULL OR json_valid(provider_receipt_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (attempt_id, task_id) REFERENCES run_attempts(attempt_id, task_id),
  FOREIGN KEY (created_by_client_id, operation, request_id)
    REFERENCES idempotency_keys(client_id, operation, request_id)
) STRICT;
CREATE INDEX commands_delivery ON task_commands(task_id, state, created_at_ms);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id TEXT,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_relative_path TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (attempt_id, task_id) REFERENCES run_attempts(attempt_id, task_id)
) STRICT;

-- Durable event journal doubles as the source for replay. Delivery is at least once.
-- Client cursors are per consumer, and authorization filtering is applied on every read.
CREATE TABLE events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT REFERENCES projects(project_id),
  task_id TEXT REFERENCES tasks(task_id),
  attempt_id TEXT,
  task_state_version INTEGER,
  event_type TEXT NOT NULL,
  producer_epoch_id TEXT NOT NULL REFERENCES daemon_epochs(epoch_id),
  fencing_token INTEGER,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (attempt_id, task_id) REFERENCES run_attempts(attempt_id, task_id),
  CHECK (attempt_id IS NULL OR task_id IS NOT NULL),
  CHECK (task_id IS NULL OR (project_id IS NOT NULL AND task_state_version IS NOT NULL))
) STRICT;
CREATE INDEX events_task_replay ON events(task_id, event_seq);
CREATE INDEX events_project_replay ON events(project_id, event_seq);

CREATE TABLE event_outbox (
  event_seq INTEGER PRIMARY KEY REFERENCES events(event_seq),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at_ms INTEGER NOT NULL CHECK (next_attempt_at_ms >= 0),
  last_error TEXT,
  dispatched_at_ms INTEGER
) STRICT;
CREATE INDEX outbox_ready ON event_outbox(dispatched_at_ms, next_attempt_at_ms);

CREATE TRIGGER event_enqueue AFTER INSERT ON events
BEGIN
  INSERT INTO event_outbox(event_seq, next_attempt_at_ms)
  VALUES (NEW.event_seq, NEW.created_at_ms);
END;

CREATE TRIGGER profile_revision_no_update BEFORE UPDATE ON profile_revisions
BEGIN SELECT RAISE(ABORT, 'profile revision is immutable'); END;
CREATE TRIGGER profile_revision_no_delete BEFORE DELETE ON profile_revisions
BEGIN SELECT RAISE(ABORT, 'profile revision history is retained'); END;

CREATE TRIGGER task_acceptance_immutable BEFORE UPDATE ON tasks
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.created_by_client_id IS NOT OLD.created_by_client_id
  OR NEW.profile_id IS NOT OLD.profile_id
  OR NEW.profile_revision IS NOT OLD.profile_revision
  OR NEW.task_spec_json IS NOT OLD.task_spec_json
  OR NEW.task_spec_sha256 IS NOT OLD.task_spec_sha256
  OR NEW.base_commit_oid IS NOT OLD.base_commit_oid
  OR NEW.parent_task_id IS NOT OLD.parent_task_id
  OR NEW.retry_of_task_id IS NOT OLD.retry_of_task_id
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'accepted task inputs are immutable'); END;

CREATE TRIGGER task_version_guard BEFORE UPDATE ON tasks
WHEN NEW.state_version <> OLD.state_version + 1
BEGIN SELECT RAISE(ABORT, 'task update requires one version increment'); END;

CREATE TRIGGER task_initial_state BEFORE INSERT ON tasks
WHEN NEW.state <> 'queued' OR NEW.state_version <> 0 OR NEW.review_state <> 'unreviewed'
BEGIN SELECT RAISE(ABORT, 'new task must begin queued at version zero'); END;

CREATE TRIGGER task_transition_guard BEFORE UPDATE OF state ON tasks
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'queued' AND NEW.state IN ('starting','cancelled','failed')) OR
  (OLD.state = 'starting' AND NEW.state IN ('running','waiting_input','cancelling','recovering','succeeded','failed','interrupted')) OR
  (OLD.state = 'running' AND NEW.state IN ('waiting_input','cancelling','recovering','succeeded','failed','interrupted')) OR
  (OLD.state = 'waiting_input' AND NEW.state IN ('running','cancelling','recovering','succeeded','failed','interrupted')) OR
  (OLD.state = 'cancelling' AND NEW.state IN ('cancelled','recovering','succeeded','failed','interrupted')) OR
  (OLD.state = 'recovering' AND NEW.state IN ('running','waiting_input','cancelling','succeeded','failed','cancelled','interrupted'))
)
BEGIN SELECT RAISE(ABORT, 'illegal task state transition'); END;

CREATE TRIGGER task_interrupted_requires_stopped_attempt BEFORE UPDATE OF state ON tasks
WHEN NEW.state = 'interrupted' AND NOT EXISTS (
  SELECT 1 FROM run_attempts a WHERE a.task_id = NEW.task_id
  AND a.state = 'interrupted' AND a.process_stop_confirmed_at_ms IS NOT NULL
  AND a.attempt_no = (SELECT MAX(a2.attempt_no) FROM run_attempts a2 WHERE a2.task_id = NEW.task_id)
)
BEGIN SELECT RAISE(ABORT, 'interrupted requires a confirmed stopped attempt'); END;

CREATE TRIGGER task_review_requires_human BEFORE UPDATE ON tasks
WHEN (NEW.review_state IS NOT OLD.review_state
  OR NEW.reviewed_by_client_id IS NOT OLD.reviewed_by_client_id
  OR NEW.reviewed_at_ms IS NOT OLD.reviewed_at_ms)
AND (
  NEW.state NOT IN ('succeeded','failed','cancelled','interrupted') OR NOT EXISTS (
    SELECT 1 FROM clients c WHERE c.client_id = NEW.reviewed_by_client_id
    AND c.kind = 'human_ui' AND c.revoked_at_ms IS NULL
  )
)
BEGIN SELECT RAISE(ABORT, 'review requires a terminal task and enrolled human UI client'); END;

CREATE TRIGGER workspace_project_guard BEFORE INSERT ON workspaces
WHEN NOT EXISTS (
  SELECT 1 FROM tasks t JOIN profile_revisions p
    ON p.profile_id=t.profile_id AND p.revision=t.profile_revision
  WHERE t.task_id=NEW.task_id AND t.project_id=NEW.project_id
    AND t.base_commit_oid=NEW.base_commit_oid AND p.access_mode=NEW.access_mode
)
BEGIN SELECT RAISE(ABORT, 'workspace contract does not match accepted task'); END;

CREATE TRIGGER attempt_identity_immutable BEFORE UPDATE ON run_attempts
WHEN NEW.task_id IS NOT OLD.task_id OR NEW.attempt_no IS NOT OLD.attempt_no
  OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.runtime_kind IS NOT OLD.runtime_kind
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR (OLD.runtime_instance_id IS NOT NULL AND NEW.runtime_instance_id IS NOT OLD.runtime_instance_id)
  OR (OLD.process_pid IS NOT NULL AND NEW.process_pid IS NOT OLD.process_pid)
  OR (OLD.process_birth_identity IS NOT NULL AND NEW.process_birth_identity IS NOT OLD.process_birth_identity)
BEGIN SELECT RAISE(ABORT, 'attempt execution identity is immutable once assigned'); END;

CREATE TRIGGER attempt_transition_guard BEFORE UPDATE OF state ON run_attempts
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'prepared' AND NEW.state IN ('starting','cancelled','failed','recovering','interrupted')) OR
  (OLD.state = 'starting' AND NEW.state IN ('running','waiting_input','cancelling','recovering','succeeded','failed','interrupted')) OR
  (OLD.state = 'running' AND NEW.state IN ('waiting_input','cancelling','recovering','succeeded','failed','interrupted')) OR
  (OLD.state = 'waiting_input' AND NEW.state IN ('running','cancelling','recovering','succeeded','failed','interrupted')) OR
  (OLD.state = 'cancelling' AND NEW.state IN ('cancelled','recovering','succeeded','failed','interrupted')) OR
  (OLD.state = 'recovering' AND NEW.state IN ('running','waiting_input','cancelling','succeeded','failed','cancelled','interrupted'))
)
BEGIN SELECT RAISE(ABORT, 'illegal attempt state transition'); END;

CREATE TRIGGER pending_request_initial_state BEFORE INSERT ON pending_requests
WHEN NEW.state <> 'pending' OR NEW.delivery_state <> 'not_sent'
  OR NEW.decision_json IS NOT NULL OR NEW.revision <> 1
BEGIN SELECT RAISE(ABORT, 'new protected request must begin pending without a decision'); END;

CREATE TRIGGER pending_request_revision_guard BEFORE UPDATE ON pending_requests
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'protected request update requires one revision increment'); END;

CREATE TRIGGER pending_request_runtime_binding BEFORE INSERT ON pending_requests
WHEN NOT EXISTS (
  SELECT 1 FROM run_attempts a WHERE a.attempt_id=NEW.attempt_id AND a.task_id=NEW.task_id
  AND a.runtime_instance_id=NEW.runtime_instance_id AND a.owner_epoch_id=NEW.owner_epoch_id
  AND a.fencing_token=NEW.fencing_token AND a.finished_at_ms IS NULL
)
BEGIN SELECT RAISE(ABORT, 'protected request must bind to the live attempt identity'); END;

CREATE TRIGGER pending_request_identity_immutable BEFORE UPDATE ON pending_requests
WHEN NEW.task_id IS NOT OLD.task_id OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.runtime_instance_id IS NOT OLD.runtime_instance_id
  OR NEW.runtime_request_key IS NOT OLD.runtime_request_key
  OR NEW.owner_epoch_id IS NOT OLD.owner_epoch_id OR NEW.fencing_token IS NOT OLD.fencing_token
  OR NEW.kind IS NOT OLD.kind OR NEW.request_json IS NOT OLD.request_json
  OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.allowed_decisions_json IS NOT OLD.allowed_decisions_json
BEGIN SELECT RAISE(ABORT, 'protected request scope is immutable'); END;

CREATE TRIGGER pending_request_transition_guard BEFORE UPDATE OF state ON pending_requests
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state='pending' AND NEW.state IN ('decision_recorded','invalidated','expired')) OR
  (OLD.state='decision_recorded' AND NEW.state IN ('provider_resolved','invalidated','expired'))
)
BEGIN SELECT RAISE(ABORT, 'illegal protected request state transition'); END;

CREATE TRIGGER pending_request_human_insert BEFORE INSERT ON pending_requests
WHEN NEW.decided_by_client_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM clients c WHERE c.client_id = NEW.decided_by_client_id
  AND c.kind = 'human_ui' AND c.revoked_at_ms IS NULL
)
BEGIN SELECT RAISE(ABORT, 'protected decision requires enrolled human UI client'); END;

CREATE TRIGGER pending_request_human_update BEFORE UPDATE ON pending_requests
WHEN NEW.decided_by_client_id IS NOT NULL
AND (NEW.decision_json IS NOT OLD.decision_json
  OR NEW.decided_by_client_id IS NOT OLD.decided_by_client_id
  OR NEW.decided_at_ms IS NOT OLD.decided_at_ms)
AND NOT EXISTS (
  SELECT 1 FROM clients c WHERE c.client_id = NEW.decided_by_client_id
  AND c.kind = 'human_ui' AND c.revoked_at_ms IS NULL
)
BEGIN SELECT RAISE(ABORT, 'protected decision requires enrolled human UI client'); END;

CREATE TRIGGER pending_request_decision_immutable BEFORE UPDATE ON pending_requests
WHEN OLD.decision_json IS NOT NULL AND (
  NEW.decision_json IS NOT OLD.decision_json
  OR NEW.decided_by_client_id IS NOT OLD.decided_by_client_id
  OR NEW.decided_at_ms IS NOT OLD.decided_at_ms
)
BEGIN SELECT RAISE(ABORT, 'recorded human decision is immutable'); END;

CREATE TRIGGER idempotency_identity_immutable BEFORE UPDATE ON idempotency_keys
WHEN NEW.client_id IS NOT OLD.client_id OR NEW.operation IS NOT OLD.operation
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.canonical_payload_sha256 IS NOT OLD.canonical_payload_sha256
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR (OLD.state <> 'in_progress' AND (
    NEW.state IS NOT OLD.state OR NEW.response_json IS NOT OLD.response_json OR NEW.task_id IS NOT OLD.task_id
  ))
BEGIN SELECT RAISE(ABORT, 'idempotency identity and completed receipt are immutable'); END;

CREATE TRIGGER event_task_project_guard BEFORE INSERT ON events
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tasks t WHERE t.task_id=NEW.task_id AND t.project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'event project must match task'); END;

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'event journal is append only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'event journal retention requires explicit maintenance'); END;

INSERT INTO schema_migrations(version, description, applied_at_ms)
VALUES (1, 'Local single-owner orchestration schema v1 design', 0);
-- Zero here is specification bootstrap metadata, not a claimed migration execution time.
-- A production migration runner records its own observed UTC timestamp when applying v1.
INSERT INTO daemon_control(singleton, global_max_active_attempts, protocol_version, updated_at_ms)
VALUES (1, 2, 1, 0);

COMMIT;
