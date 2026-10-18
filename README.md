# VoiceForge Studio

Windows desktop app that turns a list of game or product titles into channel-specific
YouTube voiceover scripts (OpenAI) and finished MP3 voiceovers (ElevenLabs), saved into
automatically organised folders.

```
Select channel → paste titles → Generate All → open the channel folder
```

```
VoiceForge Studio/            ← only finished files, written when a title completes
  Game Vault/
    Emberward/
      Script.txt
      Voice.mp3
  PlayTopia/
  …
```

Optional flat layout (Settings → Storage): `Game Vault/Emberward.txt` + `Game Vault/Emberward.mp3`.
Drafts, research, `project.json` and `Narration.txt` stay in app data
(`%APPDATA%\VoiceForge Studio\projects\<id>\`). See `CHANGELOG.md` for what changed per version.

## Highlights

* **Channel profiles** — unlimited independent profiles (PlayTopia, Game Vault,
  VoidPulse, RiftForge Tech, RENVO are seeded). Writing rules, structure, length,
  forbidden phrases, pronunciation rules, ElevenLabs voice + model + settings,
  research and validation rules, output folder — all per channel.
* **Template editor with versioning** — paste an approved script, get a suggested
  structure/prompt, edit, save as a version, activate. Every script records the
  template version that produced it.
* **Research → Script → Validation → Voice pipeline** — OpenAI Responses API with the
  official `web_search` tool for research, strict JSON output, ambiguity and
  "insufficient information" stops, deterministic validator (sections, order, length,
  URLs, citations, markdown, forbidden words, AI leakage, firsthand claims) plus an
  optional AI fact-check pass, automatic rewrites up to a limit, nothing invalid is
  ever sent to ElevenLabs.
* **ElevenLabs** — your existing voices, live model list with per-model controls,
  long scripts chunked at sentence boundaries with continuity hints, MP3 frames
  verified, versions never overwritten (`Voice.mp3`, `Voice_v2.mp3`, …).
* **Durable queue** — SQLite-backed jobs survive restarts; per-provider concurrency,
  exponential backoff with jitter, Retry-After honoured, pause/resume/cancel/retry per
  job or whole queue, crash recovery that reuses already-persisted results, spending
  limits that pause the queue.
* **Libraries & analytics** — searchable scripts/audio/projects/history, usage and
  cost dashboard (provider-reported tokens/characters, clearly-labelled estimates).
* **Reference pack (1.4.0)** — the owner's 75 sample scripts are built in: 15 channel formats
  are approved with the intro, section labels and outro locked exactly.
* **Games library (1.6.0)** — each game/product is researched once and reused for every later
  script on every channel (no research credits); identical voiceovers and unchanged parts are
  never paid for twice. Notes, corrections, aliases, refresh and import/export on the Games page.
* **Updates without reinstalling** — Settings → Updates checks GitHub Releases,
  downloads the verified installer on request and upgrades in place; data is kept.
* **First-run setup wizard** — keys → voices → output folder in a few minutes.
* **Security** — DPAPI-encrypted keys, sandboxed renderer, zod-validated IPC, strict
  CSP, no native modules, official SDKs only (updates only on request).

## Status of this build

| Area | Status |
|---|---|
| Core pipeline, queue, libraries, settings, backups | Implemented, covered by 55 automated tests (mocked APIs) + a headless Electron smoke test over all 11 pages |
| Windows installer + portable exe | Built with electron-builder on Linux + wine (`release/VoiceForge-Studio-Setup-1.6.0-x64.exe`, `release/VoiceForge-Studio-Portable-1.6.0-x64.exe`, checksums in `release/SHA256SUMS.txt`) — unsigned, not yet launched on a Windows machine |
| Live OpenAI / ElevenLabs calls | **Awaiting live verification** — no credentials were available during development; see `docs/E2E_MANUAL_TEST.md` |
| PlayTopia / VoidPulse / RENVO templates | **Placeholders** — generation is blocked until you paste the approved templates |
| Multi-PC cloud sync | **Not implemented** — architecture only (`docs/SYNC_ARCHITECTURE.md`) |
| Scheduling a batch for later | Not implemented |

See `docs/KNOWN_LIMITATIONS.md` for the complete list.

## Documentation

* `docs/SETUP.md` — installation and configuration walkthrough
* `docs/BUILD.md` — building from source, CI workflow, code signing
* `docs/SECURITY.md` — what is verified and what is not
* `docs/TESTING.md` — automated test matrix and results
* `docs/E2E_MANUAL_TEST.md` — the manual acceptance test (uses real credits)
* `docs/ARCHITECTURE.md` — modules, database schema, IPC contract, queue design
* `docs/UPDATES.md` — in-app updates, publishing a release
* `docs/KNOWN_LIMITATIONS.md`

## Quick start for developers

```bash
npm ci
npm run typecheck
npm test
npm run dev          # launches Electron with hot reload
npm run package:win  # release/*.exe
```

Stack: Electron 44 · React 19 · TypeScript 5.9 · Vite 8 (electron-vite) · SQLite via
`node:sqlite` · zod · official `openai` and `@elevenlabs/elevenlabs-js` SDKs ·
electron-builder · vitest.
