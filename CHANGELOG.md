# Changelog

## 1.7.0

**Long form or Short form for PlayTopia, RiftForge Tech and RENVO**
- New generation: a *Long form | Short form* switch for channels that have both (remembered per
  channel); the format pills show only the formats of the chosen length. The length shown, the
  cost/character estimate and the pre-flight checks use the chosen format's length.
- Every format is long-form or short-form and can have its own length (min/max characters,
  target duration); empty fields use the channel length from the Writing tab, which stays the
  default. Edit it in Channels → Formats (presets: Short 15/30/60 s, Long 3/5/8/10 min).
- New short formats (provisional — adjust after approving your first shorts):
  - PlayTopia *Short form*: Hook → what the game is → 2–3 key points → closing line (not locked),
    350–650 characters, ~35 s, no heading lines. Only the general owner rules apply; the long
    PlayTopia review format is not used.
  - RiftForge *short review* (now short-form) and RENVO *short*: HOOK → product NAME → 3–4 key
    specs, ~8–12 s (120–260 characters, target 11 s), lowercase acronyms (usb-c, qmk, via, ghz),
    no invented benchmarks.
  - Added once, only where missing; formats you edited, approved or gave a length are not changed.
- Shorts are written as one continuous voiceover: no section labels, no long channel intro/outro,
  no long-form paragraph skeleton (unless the short format's own approved references define one).
  The validator checks the short's length window, URLs and markdown, and that the game/product is
  named. Shorts are always voiced in one request (never split into parallel parts).
- Output: `Channel/<Title> (Short)/Script.txt + Voice.mp3` (flat layout: `<Title> (Short).txt/.mp3`).
  A short and a long-form script of the same title are separate projects, so neither is skipped
  as a duplicate of the other. Saved research (Games library) is reused between them — no new
  research credits.
- Queue rows and batches of shorts carry a *Short* badge; Channels and Formats show each format's
  form factor.


## 1.6.1

**OpenAI limits per model — scripts no longer queue behind each other's reservations**
- OpenAI's limits are per model (e.g. gpt-6.1-sol 30,000 tokens/min on the Build tier, gpt-6-luna
  200,000). Each model now has its own lane: research on the small model never waits for scripts
  on the large one, and vice versa. 1.6.0 kept one shared rate-limit reading for all models, so a
  research response could make a script wait (up to 15 s per request) or let it run into a 429.
- Each lane has a token budget learned from OpenAI's response headers (nothing is limited before
  the first response). A request is sent when its reservation — prompt + max output tokens, which
  is what OpenAI counts when the request arrives — fits in what is left of the window, in priority
  order (audio > script > research). Adaptive concurrency (AIMD) is per model too.
- After a 429 the model pauses for exactly as long as OpenAI says (`retry-after-ms`, `retry-after`,
  then the window reset); up to 8 rate-limit retries per request (other errors keep "Max
  retries"). The SDK's own hidden retries stay off.
- **Visible waits**: the queue row says "Waiting for OpenAI limit · 18 s" (live countdown; hover
  for why) and the batch header shows the soonest wait. One log line per wait.
- **Settings → OpenAI → Rate limits per model**: "gpt-6.1-sol: 30,000 tokens/min, 500 requests/min
  — detected from OpenAI". Limits rise automatically with your OpenAI usage tier.
- Every OpenAI request is recorded (model, status, latency, wait, reserved tokens, retry number,
  remaining/limit/reset for requests and tokens) in a compact log (newest 5,000 kept).

**Smaller reservations** (same scripts — only the unused headroom goes)
- Script max output tokens: max characters / 3.2 + reasoning headroom (low effort: +600).
  4,700 chars: 4,186 → 2,069 · 5,000 chars: 4,358 → 2,163 · 6,000 chars: 4,929 → 2,475.
- Research: 5,000 → 1,500 (with low search context).
- If a model still runs out, the request is retried once with the full limit — now shown in the
  job's history instead of happening silently inside the slot.
- Mock benchmark with OpenAI-style limits (sol 30k / luna 200k TPM, 429 + Retry-After):
  10 titles 169 s → 100 s, 4 → 0 rate-limit errors; 3 titles unchanged (65 s → 67 s, nothing to
  wait for).

**Steam links as titles**
- Paste `store.steampowered.com/app/<id>/<Name>` (or a steamcommunity.com / s.team / steam://
  link): the job is named after the link ("Brick_by_Brick_Tidy_Up_the_Small_Town" → "Brick by
  Brick Tidy Up the Small Town", "DisneyPixar_Toy_Story_3…" → "Disney Pixar Toy Story 3…") and New
  generation shows that name next to the link.
- Research gets the app id and store page as a hint and never asks "which game did you mean?".
  The official title then becomes the job, project and folder name (the one exception to "the
  folder keeps your title" — a URL is not a title).
- Games remember the Steam app id (unique): a link matches by app id before any name; a game with
  the same name but another app id is a different game. The link and the link's title become
  aliases. A link and the same game typed by name in one batch are duplicates.
- One-time repair of 1.6.0 rows titled with a URL (Games entries and projects): official title
  from the saved research, app id stored, URL kept as an alias. Only database titles change;
  files and folders are not moved.

## 1.6.0

**Research once, reuse forever (Games)**
- Every game or product is researched once; its facts are saved in the new **Games** page
  (sidebar → Library) and reused for every later script on every channel — no research request,
  no research wait. "Civilization 6" = "Civilization VI", "The Witcher 3" = "Witcher 3", ™/®,
  punctuation and capitals don't matter; a close-but-unsure title ("Hollow Knight: Silksong" vs
  "Hollow Knight") is asked once and the answer is remembered as an alias.
- Research saved by earlier versions is imported automatically on first start.
- Games page: search, details, your notes (sent with the facts), add a fact, mark a fact wrong
  (never sent again), sources, aliases, Refresh (one research), Delete, Import/Export JSON.
  Backups include the library. "May be outdated" for games researched before release.
- New generation shows per title "Saved research" / "New research" / "you'll confirm once", and
  the estimate only counts new research.

**Fewer credits** (mock measurement per script, VELIX / Game Vault formats with the reference pack)
- First draft prompt ~23,000 → ~16,000 characters (−30%): compact fact sheet instead of JSON
  research (−32%), one full reference instead of two for strict formats.
- Rewrites ~28,000 → ~15,000 characters (−47%): a short correction prompt without references.
- URLs, citations, markdown, a title line or an "Intro:" label are fixed locally instead of
  costing a rewrite.
- Reused research: one research request (~9,000 tokens with web search) saved per script.
- ElevenLabs: an identical voiceover (same words, voice, model and settings) is never paid for
  twice ("0 characters — reused"); after a small edit only the changed parts are voiced again
  (parts cached 30 days). "New take (uses characters)" forces a fresh voiceover.
- Usage page: new "Saved by reuse" card.

**Faster and easier**
- Second run of the same 10 titles (mock benchmark): 2.4 → 1.2 min, first file 85 → 59 s.
- Dashboard **Paste & generate**: titles from the clipboard, last channel / format / mode, straight
  to the start dialog (2 clicks). New generation remembers your last choices; Ctrl+Enter starts,
  and Ctrl+Enter again in the dialog confirms.
- Batch finished toast: **Open finished folder**. Queue: **Copy all scripts** per batch (title above
  each script).
- Failed jobs show one sentence and one fix button: Retry, Fix key, Check billing, Choose game,
  Approve anyway…, Raise limit, Pick a voice / Open format, Choose folder.

**Fixes**
- Ctrl+Enter on New generation could start a batch with the previously selected format.
- A job that failed validation could not be approved anyway from the Queue (only via Scripts).
- "™" in a title turned into the letters "TM" during matching.

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
