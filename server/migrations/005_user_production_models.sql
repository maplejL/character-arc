ALTER TABLE user_ai_configs ADD COLUMN ai_profiles_json JSONB NOT NULL DEFAULT '[]';
ALTER TABLE user_ai_configs ADD COLUMN active_ai_profile_id TEXT NOT NULL DEFAULT '';
ALTER TABLE user_ai_configs ADD COLUMN production_models_json JSONB NOT NULL DEFAULT '{}';
