CREATE TABLE IF NOT EXISTS user_app_settings (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme                TEXT NOT NULL DEFAULT 'ocean',
  selected_project_id  TEXT NOT NULL DEFAULT '',
  auto_save_interval   TEXT NOT NULL DEFAULT '3000',
  ui_scale             REAL NOT NULL DEFAULT 1,
  dark_mode            BOOLEAN NOT NULL DEFAULT false,
  dark_mode_style      TEXT NOT NULL DEFAULT 'standard',
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
