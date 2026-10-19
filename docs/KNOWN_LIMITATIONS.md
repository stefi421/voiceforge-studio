# Known limitations (v1.6.1)

Honest list of what is not done, partially done, or unverified.

## OpenAI limits and store links (1.6.1)

* Token reservations are estimated from characters (≈ 4 per token) plus a fixed allowance for web
  search results; the real numbers come from OpenAI's headers after each response, so the first
  requests of a model after a restart start from the limits seen last time.
* The provider_calls log has no viewer in the app yet (it is in the SQLite database, table
  `provider_calls`, newest 5,000 rows).
* Only Steam links are recognised as store links; other stores' links are treated as text.
* Retitling a link-derived project only happens before its output folder exists.

## Game Library and reuse (1.6.0)

* **Title matching is rule-based**, not semantic. Exact spellings, punctuation, "The", roman
  numerals and learned aliases match automatically; single typos in longer titles are accepted;
  anything else that looks close (a subtitle, an edition, a missing sequel number) is asked once in
  the research dialog. Two different games with the same normalised name (e.g. a 2018 remake that
  shares the original's title) are treated as one entry — rename one in Games, or choose
  "It's a different game" when asked.
* **Saved research never expires by default.** Patches, DLC and price changes after the research
  date are not picked up unless you click Refresh (or set Settings → Generation → Research again
  after). "May be outdated" is only shown for games that were unreleased / early access when
  researched and whose release date has passed.
* **Savings figures are estimates**: a reused research counts the tokens the original research
  used (or ~9,000 tokens for research imported from 1.5), priced with your pricing table.
* **Voice reuse is by exact text + voice + model + format + settings.** Any change in a part
  (even one comma) voices that part again. Cached parts live in app data for 30 days.
  ElevenLabs output is not deterministic, so a reused file is the *previous take*; use
  "New take (uses characters)" when you want a different delivery.
* **One reference script** is sent to the writer for formats with three or more locked elements
  (fixed intro/outro or required sections); the skeleton still uses all references. Whether this
  changes style fidelity on real models is not measured — the validator still enforces the format.

## Speed features (1.5.0) — unverified against the live APIs

* **Continuity hints on newer voice models**: parallel voice parts send `previous_text` /
  `next_text`. ElevenLabs documents these for its TTS endpoint but does not say whether every
  model (e.g. `eleven_v3` / `eleven_v4`) honours them. If a model rejects them the part is
  retried once without them and that model is remembered for the session; if a model silently
  ignores them, joins may sound slightly less smooth. Set "Voice parts per title" to 1 to rule
  this out.
* **ElevenLabs concurrency per plan** is taken from the docs table (checked 18 Oct 2026); newer
  models are assumed to share the "Multilingual" column. The `current-concurrent-requests` /
  `maximum-concurrent-requests` response headers override it when present.
* **OpenAI adaptive concurrency** relies on `x-ratelimit-*` headers and 429s; the starting value
  (6) and ceiling (10) are conservative guesses, not measured against a real account.
* The benchmark numbers in the changelog come from mocked providers with scaled delays; real
  speed-ups depend on your plans and current provider latency. `gpt-6-luna` being faster than
  `gpt-6.1-sol` for research is not modelled in the benchmark.

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

## Updates

* In-app updates need a GitHub repository with published releases; until the first
  release is published, *Check for updates* reports that no release was found. The
  updater code path (electron-updater, GitHub provider) is exercised only through its
  error handling here — the first real update must be verified once a release exists
  (see `UPDATES.md`).
* The portable build cannot update itself (by design of single-file portables).

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

## Channel formats (1.2.0, updated 1.3.0)

* Game Vault (review), RENVO (YouTube review) and RiftForge Tech (full review) start as
  *provisional* (built from the owner's written rules). Since 1.3.0 every other format can also
  generate in Review before voice / Scripts only, following the channel rules with a "not
  verified" warning; Fully automatic still needs an approved format. Exact intros/outros are only
  enforced where the owner stated them (Game Vault's intro, or text typed in Writing → Opening).
* Channels without a fixed intro open with a short, varied channel introduction written by the
  model (toggle in Writing → Opening). Its wording is not checked word for word.
* GameSense / GAMIX / VELIX should match the "Dark Auction" script, which has not been imported.
* Short-form formats (PlayTopia "Short form", RiftForge "short review", RENVO "short", 1.7.0) are
  **provisional until you approve example shorts**: their structure and lengths (PlayTopia
  350–650 chars / ~35 s; RiftForge and RENVO 120–260 chars / ~11 s) are defaults from your
  request, not measured from approved shorts. They run in Review before voice / Scripts only until
  approved; adjust the length in Channels → Formats after approving your first shorts.
* Short duration is estimated from words per minute; the real length of a short depends on the
  voice's pace (check the first few against the 8–12 s / ~35 s targets).
* Dropping .docx/.pdf onto the window cannot pass file paths through the sandbox; use
  *Choose files* (TXT/MD paste and drop work).

## Speed and output (1.3.0)

* Speed numbers in the changelog come from the mocked benchmark (`VF_BENCH=1`), not from live
  API calls. Real gains depend on OpenAI/ElevenLabs latency and your plan's concurrency limits.
* The AI fact check is off by default (one request less per script). Turn it on in
  Settings → Generation if you want the extra check.
* Only finished Script/Voice files go to the output folder. Projects created before 1.3.0 keep
  their old files (Research.json, project.json, Narration.txt, drafts) where they are.

## Reference pack (1.4.0)

* The 15 pack formats reproduce the pack samples. The pack's README says those samples are
  reconstructions, not the original historical ChatGPT scripts; replace the references in
  Channels → Formats when the originals are available.
* In the pack, the body of the same game is almost identical across channels (11 of 12 body
  paragraphs are word for word the same) — mainly the intro, section labels and outro differ. Channel-specific tone in the body therefore comes from
  the channel instructions, not from the samples.
* PlayTopia, RENVO and RiftForge Tech are not in the pack.
