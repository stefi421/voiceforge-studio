/**
 * SQLite schema. Migrations are additive and tracked in `schema_migrations`.
 * All JSON columns hold validated structures serialized with JSON.stringify.
 */
export const MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#7C5CFF',
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'gaming',
  language TEXT NOT NULL DEFAULT 'en',
  writing_instructions TEXT NOT NULL DEFAULT '',
  writing_style TEXT NOT NULL DEFAULT '',
  intro_requirements TEXT NOT NULL DEFAULT '',
  outro_requirements TEXT NOT NULL DEFAULT '',
  target_duration_sec INTEGER NOT NULL DEFAULT 240,
  min_chars INTEGER NOT NULL DEFAULT 0,
  max_chars INTEGER NOT NULL DEFAULT 5000,
  pronunciation_rules_json TEXT NOT NULL DEFAULT '[]',
  eleven_voice_id TEXT,
  eleven_voice_name TEXT,
  eleven_model_id TEXT NOT NULL DEFAULT 'eleven_multilingual_v2',
  eleven_voice_settings_json TEXT NOT NULL DEFAULT '{}',
  output_format TEXT NOT NULL DEFAULT 'mp3_44100_128',
  output_folder TEXT,
  openai_model TEXT,
  research_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  active_template_version_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_slug ON channels(slug);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_channel ON templates(channel_id);

CREATE TABLE IF NOT EXISTS template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  structure_json TEXT NOT NULL DEFAULT '[]',
  example_script TEXT,
  notes TEXT NOT NULL DEFAULT '',
  placeholder INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(template_id, version)
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  folder_path TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_channel ON projects(channel_id);
CREATE INDEX IF NOT EXISTS idx_projects_title ON projects(channel_id, title_normalized);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  research_attempts INTEGER NOT NULL DEFAULT 0,
  script_attempts INTEGER NOT NULL DEFAULT 0,
  audio_attempts INTEGER NOT NULL DEFAULT 0,
  research_id TEXT,
  script_id TEXT,
  audio_id TEXT,
  last_error_json TEXT,
  resume_status TEXT,
  manual_research_notes TEXT,
  overrides_json TEXT,
  next_run_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);

CREATE TABLE IF NOT EXISTS research_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_job ON research_results(job_id);
CREATE INDEX IF NOT EXISTS idx_research_project ON research_results(project_id);

CREATE TABLE IF NOT EXISTS research_cache (
  cache_key TEXT PRIMARY KEY,
  research_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  job_id TEXT,
  version INTEGER NOT NULL,
  template_version_id TEXT,
  template_version_number INTEGER,
  text TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  word_count INTEGER NOT NULL,
  estimated_duration_sec INTEGER NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  validation_json TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_scripts_project ON scripts(project_id);

CREATE TABLE IF NOT EXISTS audio_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  script_id TEXT NOT NULL,
  job_id TEXT,
  version INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  voice_name TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL,
  voice_settings_json TEXT NOT NULL DEFAULT '{}',
  output_format TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  duration_sec REAL,
  sha256 TEXT,
  characters INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_audio_project ON audio_files(project_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT,
  job_id TEXT,
  channel_id TEXT,
  project_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  characters INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  reported_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_channel ON usage_events(channel_id);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_job_events_at ON job_events(at);

CREATE TABLE IF NOT EXISTS favorite_voices (
  voice_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_cache (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  path TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  app_version TEXT NOT NULL
);
`
  },
  {
    id: 2,
    name: 'force_approve_and_canonical_title',
    sql: `
ALTER TABLE scripts ADD COLUMN approved_with_issues INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN canonical_title TEXT;
`
  }
]
