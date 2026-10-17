# Automated tests

`npm test` runs vitest against the main-process code with **mocked providers**
(`tests/helpers/mockProviders.ts`). No real API credits are ever used by the
automated suite. The integration tests spin up a real SQLite database in a temp
directory, run the real queue engine and pipeline, and write real files.

Result at delivery: **2 files, 55 tests, all passing** (`npm test`, Node 22.22, Linux).

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

Additional coverage: review-before-voice approval flow, scripts-only mode, placeholder
template blocking, research cache, spending limits pausing the queue, per-provider
concurrency with 100 queued jobs, never sending an invalid script to TTS, channel
export/import without secrets, log redaction, model capability filtering for voice
settings, XLSX/CSV import.

## Manual end-to-end mode

`docs/E2E_MANUAL_TEST.md` (also shown in-app when *Settings → Advanced → Manual E2E
test mode* is on) walks through the acceptance test with real credentials. It is
explicitly labelled as spending credits.
