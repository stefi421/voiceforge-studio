# Known limitations (v1.0.1)

Honest list of what is not done, partially done, or unverified.

## Not verified live

* **No OpenAI or ElevenLabs calls were made during development** — no credentials
  were available in the build environment. Both integrations use the official SDKs
  with the documented request shapes (`responses.create` with `web_search` tool and
  strict JSON schema; `textToSpeech.convert`, `voices.search`, `models.list`,
  `user.subscription.get`), and all pipeline logic is tested against mocked
  providers. Run `docs/E2E_MANUAL_TEST.md` with real keys; model-specific parameter
  rejections (e.g. a model that refuses `temperature`) are handled by an automatic
  retry without the parameter, but new models may still surface edge cases.
* The Windows executables were produced on Linux with electron-builder + wine
  (installer and portable both built). They have **not been launched on a Windows
  machine from this environment**. `.github/workflows/build-windows.yml` reproduces
  the build natively on Windows for release purposes.
* Not code-signed → SmartScreen warning on first launch.

## Templates

* PlayTopia, VoidPulse and RENVO use **placeholder** templates; generation is blocked
  for them until the approved scripts are pasted into the Template Editor. Game Vault
  and RiftForge Tech have working v1 templates built from the stated rules only — no
  approved example script is attached yet, so style matching is rule-based.
* The template analyzer is an aid, not an oracle: it always reminds you that one
  example cannot infer every rule.

## Research

* Research quality depends on the model and the `web_search` tool. The app enforces
  structure (confirmed vs uncertain facts, candidates, insufficient reason) but
  cannot guarantee factual correctness. The validator blocks firsthand/benchmark
  claims and URLs; the AI review pass flags unsupported claims as issues.
* "Model knowledge only" mode is offered but not recommended — it will be outdated
  for new releases and the UI says so.

## Audio

* MP3 chunks are concatenated frame-wise with ID3 tags stripped; this is valid for
  the CBR MP3 formats ElevenLabs returns, but there is no crossfade — a very small
  discontinuity at a chunk boundary is possible on some sentences. `previous_text` /
  `next_text` continuity hints are sent to reduce prosody jumps.
* PCM/Opus output formats are saved raw (no container); MP3 is the supported default.
* Duration is computed by parsing MP3 frames (no decoder), accurate to one frame.

## Queue

* Duplicate-billing window on crash (see `ARCHITECTURE.md`): a request that completed
  at the provider milliseconds before a crash may be repeated once on recovery.
* Scheduled batches (run at a future time) are **not implemented**; nothing runs
  while the app is closed.
* The queue runs in the main process event loop; it is I/O-bound and tested with 100
  queued jobs, but it is not a multi-process worker pool.

## Sync & accounts

* Multi-PC cloud synchronization is **not implemented** (architecture in
  `SYNC_ARCHITECTURE.md`). Each PC has its own database; use Export/Import for
  channel profiles and templates.

## UI

* Language toggle (English/Serbian) is stored but the interface strings are English.
* Waveform display is a lightweight visualisation (decoded via WebAudio when the file
  is small enough; otherwise level bars).
* No drag-and-drop reordering of queue rows (up/down buttons instead).

## Dependencies

* 8 moderate `npm audit` advisories in the electron-builder tool-chain (dev only,
  `sprintf-js` ReDoS, no upstream fix). 0 in production dependencies.
* `node:sqlite` prints an "experimental feature" warning in Node 22 test runs; in
  Electron 44 (Node 24) it is stable.
