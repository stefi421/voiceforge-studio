# Changelog

## 1.5.0

**Much faster batches** (mock benchmark, same work: 10 titles 3.7 → 2.4 min, 30 titles 9.9 → 4.5 min, 1 title 1.6 → 1.4 min)
- Long voiceovers are split into up to 3 parts (Settings → Generation → Voice parts per title, 1–4)
  that are generated at the same time and joined frame by frame. Each part gets the text before and
  after it so intonation flows across the joins; models that refuse that context fall back to
  plain parts automatically. Every part is saved as soon as it is ready, so a crash or restart
  only redoes the missing parts. The finished file is checked against the expected length.
- Research for every title in a batch starts right away; titles closest to finishing get the
  next free slot (save → voice → script → research), so the first finished files arrive sooner.
- Research uses `gpt-6-luna` by default (faster); scripts are still written with `gpt-6.1-sol`.
  Settings still on the old research default switch once; any other research model you picked stays.
  "Titles at the same time" still at the old default 6 moves to 16 (provider slots do the real limiting).

**Automatic speed (recommended, on by default)**
- ElevenLabs: uses your plan's real number of requests at once (from the response headers, or
  your plan: Free 2, Starter 3, Creator 5, Pro 10, Scale/Business 15) and lowers it by one if
  ElevenLabs says there are too many at once.
- OpenAI: starts at 6 requests at once, adds one after 3 successes in a row (up to 10), halves on
  a rate limit, and waits briefly before sending when your rate-limit headers say the minute's
  budget is almost used up.
- Settings → Generation → Speed shows the live values and where they come from. Turn Automatic
  off to set the numbers yourself as before.

**Fewer failures**
- Pre-flight checks in the start dialog: OpenAI and ElevenLabs keys, ElevenLabs characters left
  vs. needed, every channel's voice still in your account, the format, the output folder (write
  test) and free disk space. Blocking problems disable Start; low credits or disk space offer
  "Start anyway". The same checks run again when the batch is created.
- Time limits per request (research 2 min, script 3 min, each voice part 2 min) so a hung request
  is retried instead of blocking a slot.
- If a provider fails several times in a row, new requests to it pause for 30 s instead of
  burning retries; the queue shows a short-pause notice.
- A wrong key or an empty quota now stops the whole queue with one notification and one failed
  job, instead of failing every title. Fix it and press Resume queue.

**See where the time goes**
- Job details: a bar with research, script, checks, voice and save times.
- Batch header: median time per stage once titles finish.
- Usage: "Where time goes" across your last 50 titles.

## 1.4.0

**Your reference pack is built in (15 channels)**
- The 75 scripts you sent on 18 Oct 2026 ship with the app and are applied once on first start:
  AperoX, AxioS, THE BLAZE, Fluxor, GAMIX, GameSense, Game Vault, Nexora, NexPlay Gaming,
  Nyx Shadow, PixelDrop, RazorFrame, VELIX, VIR3ON and VoidPulse (Review format).
- Each of those formats gets the 5 scripts as references and a new **approved** version with
  the intro locked as the first paragraph, the outro locked as the last paragraph, and the five
  section labels in the same order. Fully automatic works for them right away.
- Game Vault keeps the intro you stated earlier ("Welcome back to Game Vault, where we mine the
  hidden gems…") instead of the pack's shorter line; the closing comes from the pack.
- Length for these channels: 4,500–5,000 characters, aiming for about 4,750 like the samples
  (only where you had not changed the limits yourself).
- A format you had edited yourself is not replaced: the pack version waits for your approval
  in Channels → channel → Formats.
- The pack's own README calls the samples reconstructions rather than the original historical
  scripts; that note is kept in each version.
- PlayTopia, RENVO and RiftForge Tech are not in the pack and still need their own references.

**Scripts follow the format exactly**
- The writer gets a format skeleton: exact intro, each section label with its usual number of
  paragraphs, exact outro, plus two of the reference scripts (their game facts are never reused).
- Validation checks that the first and last paragraphs are exactly the locked intro and outro and
  that the labels appear in order.
- Small presentation slips (label case or "## Pros:", curly vs straight quotes, dashes, the intro
  or outro glued to the next paragraph) are fixed automatically instead of costing a rewrite.

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
