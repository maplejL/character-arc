CREATE TABLE IF NOT EXISTS auto_creation_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL,
  volume_id             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'queued','running','paused','completed','failed','cancelled'
                        )),
  pause_reason          TEXT CHECK (pause_reason IN ('user','api_error','config_error','quality_limit')),
  pause_message         TEXT NOT NULL DEFAULT '',
  config_json           JSONB NOT NULL,
  chapter_queue_json    JSONB NOT NULL DEFAULT '[]',
  current_index         INT NOT NULL DEFAULT 0,
  current_step          TEXT,
  completed_chapter_ids JSONB NOT NULL DEFAULT '[]',
  skipped_chapter_ids   JSONB NOT NULL DEFAULT '[]',
  failed_chapter_id     TEXT,
  worker_id             TEXT,
  started_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS auto_creation_runs_user_project ON auto_creation_runs (user_id, project_id);
CREATE INDEX IF NOT EXISTS auto_creation_runs_active ON auto_creation_runs (status) WHERE status IN ('queued','running','paused');
