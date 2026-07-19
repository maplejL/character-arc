CREATE TABLE IF NOT EXISTS user_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  TEXT,
  purpose     TEXT NOT NULL CHECK (purpose IN ('cover','reference-novel','project-skill','export')),
  file_name   TEXT NOT NULL,
  disk_path   TEXT NOT NULL,
  mime_type   TEXT NOT NULL DEFAULT '',
  size_bytes  BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_files_user ON user_files (user_id);
CREATE INDEX IF NOT EXISTS user_files_project ON user_files (project_id);
