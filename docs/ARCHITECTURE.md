# Architecture

```
src/
  shared/      types.ts (domain types) · ipc.ts (IpcContract) · schemas.ts (zod) · defaults.ts (settings, seed profiles)
  preload/     contextBridge: window.vf.invoke(channel, payload) / window.vf.on(event, fn)
  main/
    index.ts           app bootstrap, window, CSP, vfmedia:// protocol, shutdown, restore
    db/                database.ts (node:sqlite wrapper, migrations) · schema.ts · repos/*
    services/          settings · secrets (safeStorage) · logger (JSONL, redaction) · files (safe names, atomic writes)
                       projects (folder layout) · generation (batches, estimates) · backup · seed · container (DI + event bus)
    providers/         openai.ts (Responses API) · elevenlabs.ts (TTS SDK) · prompts.ts · factory.ts · types.ts
    pipeline/          pipeline.ts (stage runners) · validator.ts · chunker.ts · mp3.ts · cost.ts · titles.ts · xlsx.ts
    queue/engine.ts    durable worker loop (leases, backoff, pause/resume/cancel, recovery)
    ipc/               registry.ts (validation + sender check) · handlers.ts (one handler per contract key)
  renderer/            React app (pages, components, zustand stores, CSS tokens)
tests/                 vitest: unit.test.ts (pure modules) · integration.test.ts (end-to-end with mocked providers)
```

## Process model

* **Main process** owns the database, secrets, providers and the queue. All work
  (API calls, file writes) happens here.
* **Renderer** is a sandboxed React app with no Node access. It only calls
  `window.vf.invoke` (request/response) and subscribes to a fixed set of push events
  (`job:changed`, `queue:stats`, `batch:completed`, `notification`,
  `settings:changed`, `secrets:changed`).
* **Preload** is ~60 lines and exposes exactly those two functions.

## Database (SQLite, WAL mode, `node:sqlite`)

| Table | Purpose |
|---|---|
| `settings` | JSON settings document + small flags (`queue_paused`, `seeded_v1`) |
| `channels` | one row per profile; JSON columns for voice settings, research and validation rules |
| `templates`, `template_versions` | immutable versions; `channels.active_template_version_id` points at the active one |
| `batches`, `jobs` | queue state: `status`, `stage`, attempts per stage, ids of persisted results, lease, `next_run_at`, `overrides_json` |
| `projects` | one per (channel, title); folder name/path; stable id prevents collisions |
| `research_results`, `research_cache` | structured research + sources; 7-day cache keyed by normalised title |
| `scripts` | every version (AI, rewrite, manual) with validation report and template version |
| `audio_files` | every voiceover version with voice/model/settings, bytes, duration, sha256 |
| `usage_events` | provider usage (tokens/characters) with estimated cost, per job/channel/project |
| `job_events` | audit trail shown in Generation History |
| `favorite_voices`, `provider_cache`, `backups`, `schema_migrations` | misc |

Migrations are additive SQL blocks in `schema.ts`, applied in a transaction on startup.

## Job lifecycle

```
stage:  research ─► script ─► (approval) ─► audio ─► save ─► done
status: pending → researching → writing_script → validating_script → script_ready / awaiting_approval
        → generating_audio → saving_files → completed | failed | cancelled | paused
```

* `Pipeline.step(jobId)` executes **one stage**, persists its result (research row,
  script row + `Script.txt`, audio row + `Voice_vN.mp3`) and advances `jobs.stage`.
  The engine loops until the step returns `wait` (user input needed) or `done`.
* Every stage first checks whether its result already exists (`researchId`,
  `scriptId`, `audioId` + file on disk). That is what makes retry and crash recovery
  idempotent: a retried job never repeats a stage whose output was persisted.
* Audio chunks are written as `Voice.mp3.chunkN.part` as they arrive; a restart
  reuses valid chunks and only regenerates missing ones, then the final file is
  written atomically and the chunks deleted.
* The queue engine claims jobs with a lease (`lease_owner`, `lease_expires_at`,
  heartbeat every 40 s) so a duplicate dispatch within one process is impossible,
  and stale leases from a crashed process are cleared on startup.

## Idempotency and duplicate billing

Neither the OpenAI Responses API (for this use) nor the ElevenLabs TTS endpoint
offers client idempotency keys. The remaining duplicate-billing window is: the
provider finished a request, but the process died before the result was persisted
(for TTS: before the chunk `.part` file was written). The app minimises this by
persisting immediately after every response, reusing persisted chunks, and never
re-running a stage whose output exists. It cannot be reduced to zero without
provider-side idempotency, which is documented in the UI's Known Limitations.

## Error model

`AppError { kind, message, action, retryable, retryAfterMs }`. Provider errors are
mapped once (`mapOpenAIError`, `mapElevenError`): 401 → `auth`, 429 quota → `quota`,
429 → `rate_limit` (retryable, honours `Retry-After`), 5xx → `provider_down`,
connection/timeout → `network`, 400/404 model → `config`. Jobs store the last
`JobError` and show the `action` text in the queue.

## Cost model

`usage_events.estimated_cost` = tokens × pricing table (Settings → Spending) or
characters × per-1k price. Provider-reported usage objects are stored verbatim in
`reported_json`. Daily/monthly spend is summed from these rows; limits pause the
queue (`QueueEngine.spendingPaused`) and are re-checked every tick.
