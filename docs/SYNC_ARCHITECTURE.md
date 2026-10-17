# Multi-PC synchronization — architecture (NOT IMPLEMENTED in v1.0)

**Status: designed, not built.** VoiceForge Studio 1.0 works fully offline on a single
Windows PC. Nothing in this document is active in the shipped application, and the
Settings → Synchronization page says so. This file exists so the feature can be added
without rewriting the data model.

## Why the current data model is sync-ready

* Every row has a globally unique id (`randomUUID`) — no auto-increment ids to collide
  across machines (the only autoincrement table, `job_events`, is append-only history).
* Every mutable row carries `created_at`/`updated_at` ISO timestamps.
* Secrets are **not** in the database (`secrets.json`, encrypted per machine), so a
  synchronized database never carries API keys.
* Large binaries (MP3) are files on disk referenced by path; the database only stores
  metadata and checksums (`sha256`), which is what a file-sync layer needs.

## Recommended backend: Supabase (Postgres + Auth + Storage)

Stefan already runs a Supabase project for another tool, so the operational model is familiar.

| Layer | Supabase feature | Notes |
|---|---|---|
| Authentication | Supabase Auth (email + password) | One account; all PCs sign in as the same user. |
| Shared data | Postgres tables mirroring `channels`, `templates`, `template_versions`, `projects`, `scripts`, `audio_files` (metadata), `job_events`, `usage_events` | Row Level Security: `user_id = auth.uid()` on every table. |
| Optional audio files | Supabase Storage bucket `voiceforge-audio` | Upload is optional per channel; checksum must match the local file before marking it synced. |
| Realtime | Postgres changes subscription | Other PCs pull updates immediately; not required for correctness. |

### What is NOT synchronized

* API keys (never leave the machine).
* The local job queue (`jobs`) — a job runs on the PC where it was created. Shared
  history is enough; running the same job on two PCs would double-bill the providers.
* The SQLite file itself. Live SQLite databases must never be placed in OneDrive /
  Google Drive / Dropbox folders; WAL files and partial syncs corrupt them.

### Sync algorithm (outline)

1. Each PC keeps `sync_state` with the last pulled server timestamp per table.
2. Push: rows with `updated_at > last_pushed_at` are upserted (id as conflict key).
3. Pull: rows changed on the server since `last_pulled_at` are applied locally.
4. Conflicts: last-writer-wins on `updated_at`, **except** template versions, which are
   immutable (a new version is always created rather than edited), so they never
   conflict. Channel edits made on two PCs within the same minute are surfaced in the
   UI (Settings → Synchronization → Conflicts) with both copies.
5. Interrupted sync: operations are idempotent upserts keyed by id, so a crashed push
   simply reruns.

### Cost and prerequisites

* Supabase Free tier is sufficient for metadata; audio storage beyond 1 GB requires a
  paid plan (or keeping audio local-only).
* Requires creating a Supabase project, running the migration SQL, and entering the
  project URL + anon key in Settings → Synchronization (these are not secrets; the
  user's password and session token are handled by Supabase Auth and stored via
  `safeStorage`).

Until this is built and tested on three real machines, the UI must keep reporting
"Cloud synchronization is not implemented in this version".
