# Changelog

## 1.3.0

**Openings**
- Restored the Game Vault intro you stated ("Welcome back to Game Vault, where we mine the
  hidden gems…"). 1.2.0 dropped it by mistake. It is locked again, enforced by validation, and
  added to existing installs as a new format version that keeps its approval status.
- New **Writing → Opening and closing**: type a fixed intro and/or outro per channel. It is saved
  as locked text in a new version of the channel's default format.
- Channels without a fixed intro now open with a short channel introduction that names the
  channel and the title. You can switch this off per channel.
- Added rules you stated earlier: GameSense and GAMIX 4,000–4,300 characters, Game Vault
  3,500–4,500 with Pros and Cons kept separate, RENVO at most 4,800 characters, RazorFrame
  plain-text section labels with no "Intro" heading, and the title never inside the script.

**Channels unblocked**
- Unverified formats work again in Review before voice and Scripts only, with a warning. Fully
  automatic still needs an approved format.

**Faster**
- AI fact check off by default (Settings → Generation), which removes one OpenAI request per
  script.
- Research: low search context, a tighter output cap, results reused for 30 days across
  channels, and no stop for a title choice when the typed title is the confident top match.
- Script writing: output tokens capped to what the script needs (with an automatic retry at the
  full limit), and a prompt-cache key per format so the stable prompt prefix is reused.
- Parallelism: 6 titles at once, 4 OpenAI and 3 ElevenLabs requests at once. Existing installs
  still on the old defaults (2 / 2 / 1) are raised.
- Voiceover: one request and one write for scripts that fit the model limit, with no part files,
  no re-concatenation and a single MP3 parse.
- Mocked benchmark, 10 titles, provider latencies scaled from real runs: 15.6 → 8.1 minutes for
  the batch.

**Clean output folder**
- The output folder only gets `Script.txt` + `Voice.mp3`, and only when a title is finished.
  Drafts, research, `project.json` and `Narration.txt` stay in app data (`projects/<id>`).
- New **Settings → Storage → Output folder layout**: a folder per title (default), or flat
  `Channel/Title.txt + Title.mp3` for easy sending.
- New generation shows "~N min for this batch".

## 1.2.0
- Channel Style Preservation Studio: reference scripts (TXT/MD/DOCX/PDF), style analysis with
  provenance, locked intro/outro/headings, approval and style tests.
- 18 channel profiles from the channel configuration document; format-aware generation.
- Live-run fixes: updater crash at startup, script length convergence (tighten pass,
  tolerance), "Approve anyway", stage-based progress and ETA, typed title kept.
- Renderer redesign: simpler New generation, dashboard "Needs you", queue grouped by batch with
  a detail drawer, Ctrl+K command palette.

## 1.1.1
- Release flow documented; first update published through GitHub Releases.

## 1.1.0
- Setup wizard, ElevenLabs v4 and own-voice picker, in-app updates, design refresh.
