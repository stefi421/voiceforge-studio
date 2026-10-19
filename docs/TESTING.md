# Automated tests

`npm test` runs vitest against the main-process code with **mocked providers**
(`tests/helpers/mockProviders.ts`). No real API credits are ever used by the
automated suite. The integration tests spin up a real SQLite database in a temp
directory, run the real queue engine and pipeline, and write real files.

Result at delivery: **58 tests, all passing** (`npm test`, Node 22.22, Linux). A third file,
`tests/demo-data.smoke.test.ts`, is skipped by default; with `VF_DEMO_DIR=<dir>` it generates a
populated database for UI smoke-testing.

Updater (`tests/updater.test.ts`, electron + electron-updater mocked): check → available
→ download (progress events) → install after a clean shutdown; never auto-downloads;
"up to date"; 404 → actionable error; feed follows Settings; portable build reports
unsupported.

## Headless UI smoke test

`VF_SMOKE_TEST=<dir> VF_SMOKE_PAGES=dashboard,generate,… electron .` starts the real app
(main process + preload + renderer, real SQLite), navigates through the listed pages, saves a
screenshot per page and the renderer console into `<dir>`, then quits. At delivery this was run
under Xvfb against the demo database for all 10 pages: every page rendered and the renderer
console was empty (no errors or warnings).

| # | Required test | Where |
|---|---|---|
| 1 | Channel creation | `integration › creates, edits and isolates channels` |
| 2 | Channel editing | same |
| 3 | Channel isolation | same (editing A never changes B) |
| 4 | Template selection | `integration › versions templates and records the active version per channel` |
| 5 | Template versioning | same + `scripts record templateVersionId/Number` in the pipeline test |
| 6 | Batch job creation | `integration › creates jobs, skips duplicates and runs research → script → audio → files` |
| 7 | Duplicate detection | same (`emberward` vs `Emberward`) + `unit › parses lines … removes duplicates` |
| 8 | Script validation | `unit › script validation` (6 cases) |
| 9 | Character limits | `unit › flags character limits` |
| 10 | Research ambiguity handling | `integration › asks the user when the title is ambiguous …` and `stops when research is insufficient …` |
| 11 | OpenAI request handling | pipeline tests (research/script/review calls, rewrite loop, parameters) |
| 12 | ElevenLabs request handling | `chunks long narration and concatenates audio in order`, `regenerates audio …` |
| 13 | API rate limits | `integration › schedules automatic retries for rate limits …` + `unit › retry behaviour` |
| 14 | Retry behavior | `unit › retries transient errors and stops on permanent ones`, `gives up after maxRetries` |
| 15 | Cancellation | `integration › cancels a running job and can retry it from the failed stage` |
| 16 | Pause and resume | `integration › pauses and resumes a running job and the whole queue` |
| 17 | Crash recovery | `integration › recovers interrupted jobs after a restart …`, `adopts a complete audio file …` |
| 18 | SQLite persistence | `integration › persists channels, settings, jobs and history across reopen` |
| 19 | File naming | `unit › file naming` |
| 20 | Folder creation | pipeline test (folder layout `Channel/Title/{Script.txt,Voice.mp3,Research.json,project.json}`) |
| 21 | Atomic file writes | `unit › atomic writes and temp cleanup` |
| 22 | API key storage | `unit › API key storage` |
| 23 | Invalid credentials | `integration › rejects invalid audio … invalid keys` |
| 24 | Insufficient credits | same (`quota` error surfaced with action) |
| 25 | Audio validation | `unit › mp3 parsing and concatenation`, pipeline rejects non-MP3 bytes |
| 26 | Cost tracking | `unit › cost tracking`, usage summary assertions in the pipeline test, spending-limit test |
| 27 | Backup and restore | `integration › backup and restore` (2 tests) |
| 28 | Electron IPC security | `IpcRegistry` validates every payload with zod and checks sender origin (code-reviewed; not unit-tested because it needs a live `ipcMain`) |
| 29 | Installer build | `npm run package:win` — artifact in `release/` (see `BUILD.md`); CI workflow builds on Windows |
| 30 | Portable application build | same |

1.6.1 (`tests/v161.test.ts`): Steam link parsing (store/community/s.team/steam:// variants, slug
→ title), link jobs researched with the app id and retitled to the official name, app id beats
name, URL-vs-name duplicates, the 1.6.0 URL-title repair, script/research token caps and the
one-time full-cap fallback, per-model token budget (refill, ordering, isolation between models),
SDK `maxRetries: 0`, `retry-after-ms`/`retry-after`/reset parsing, `waitingFor` set and cleared,
provider_calls rows (429 then 200 with retry 1) and pruning.

1.7.0 (`tests/v17.test.ts`, `tests/v17.ipc.test.ts`): migration defaults (existing formats long
with channel limits, `short_review` short), per-format length in validator / prompt / estimate,
short-form validator rules (URL, markdown, heading lines, product name), idempotent short-format
seed that never touches owner-edited formats or lengths, one TTS request per short with parallel
parts on, `<Title> (Short)` folder and flat files, Games library research reused long ↔ short
(no extra research calls), `templates:list` / `templates:setLimits` over IPC.

`VF_BENCH=1 npx vitest run tests/ratelimit.bench.test.ts` runs 3 and 10 titles against a mock
OpenAI that enforces tokens/min per model (sol 30k, luna 200k, 429 + Retry-After, scaled 100×).

Additional coverage: review-before-voice approval flow, scripts-only mode, placeholder
template blocking, research cache, spending limits pausing the queue, per-provider
concurrency with 100 queued jobs, never sending an invalid script to TTS, channel
export/import without secrets, log redaction, model capability filtering for voice
settings, XLSX/CSV import.

## Manual end-to-end mode

`docs/E2E_MANUAL_TEST.md` (also shown in-app when *Settings → Advanced → Manual E2E
test mode* is on) walks through the acceptance test with real credentials. It is
explicitly labelled as spending credits.
