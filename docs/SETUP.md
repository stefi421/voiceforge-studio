# Setup guide

## 1. Install

* **Installer:** run `VoiceForge-Studio-Setup-<version>-x64.exe`. Choose the install
  folder, finish, launch from the Start menu or desktop shortcut.
* **Portable:** copy `VoiceForge-Studio-Portable-<version>-x64.exe` anywhere and run it.
  Settings and the database still live in `%APPDATA%\VoiceForge Studio` (so the
  installer and portable builds share the same data on one PC).

Windows 10 (1809+) and Windows 11, 64-bit. The executables are not code-signed, so
SmartScreen shows "Windows protected your PC" on first run → *More info → Run anyway*.

On first launch a setup wizard walks through steps 2–4 below (keys → voices per
channel → output folder). You can skip it and come back via *Settings → General → Run
setup again*.

## 2. Enter API keys (once per PC)

1. **Settings → OpenAI** — paste the key from <https://platform.openai.com/api-keys>,
   click *Save*, then *Test connection*. Pick the default, research and review models
   (the list comes from your account; defaults are `gpt-6.1-sol` for research and
   writing and `gpt-6-luna` for the review pass — `gpt-6-astra` is the flagship if
   you want maximum quality at ~5× the price).
2. **Settings → ElevenLabs** — paste the key from the ElevenLabs profile page, *Save*,
   *Test connection*, then *Refresh voices*. Your own voices (instant and
   professional clones, designed voices) are listed under **My voices**; the public
   library is a separate tab. The default model is **Eleven v4** (newest, most
   expressive; stability + similarity only, understands audio tags such as
   `[laughs]`). If a professional clone has not been tuned for v4 in your ElevenLabs
   account, pick `eleven_multilingual_v2` for that channel instead — it has every
   slider and is the most stable long-form model.

Keys are encrypted with Windows DPAPI for your user account and never leave the PC.

## 3. Choose the output folder

**Settings → General → Output root.** Default: `Documents\VoiceForge Studio`. Each
channel gets a sub-folder; each title gets its own folder with `Script.txt`,
`Voice.mp3`, `Research.json` and `project.json`. A channel can override the root in
its *Output* tab.

## 4. Configure each channel

Channels → pick a channel → tabs:

| Tab | What to set |
|---|---|
| Identity | name, icon, colour, category (gaming / tech), language |
| Writing | instructions, style, intro/outro requirements, target duration, min/max characters, forbidden phrases, pronunciation rules |
| Voice | ElevenLabs voice (with preview), model, stability / similarity / style / speaker boost / speed, output format |
| Research | mode (**OpenAI web search** recommended), minimum confidence, ask on ambiguity |
| Validation | URL/citation/markdown rules, section order, AI review pass, rewrite attempts, words-per-minute |
| Output | per-channel folder and OpenAI model overrides |
| Templates | the script template versions (see below) |

### Templates (required before generating)

PlayTopia, VoidPulse and RENVO ship with **placeholder** templates because their
approved scripts were not supplied. Generation for those channels is blocked until
you:

1. Open *Channels → channel → Templates*.
2. Paste an approved script and its writing instructions into *Analyze pasted script*.
3. Review the suggested structure and prompt **and the caveats** — one example cannot
   reveal every rule, so add fixed intro/outro sentences, length limits and forbidden
   words yourself.
4. *Use as new version* → adjust → *Save version* → *Set active*.

Every generated script records the template version it was written with, so you can
always trace which rules produced a given voiceover.

Game Vault and RiftForge Tech ship with working v1 templates built from the rules you
gave (section order, fixed intro, no "AAA", 4–5 minutes, …). Add an approved example
script to them for closer style matching.

## 5. Generate

New Generation → channel → paste titles (one per line, or import TXT/CSV/XLSX) → mode:

* **Fully Automatic** — research → script → validation → voice → files, no questions
  unless research is ambiguous/insufficient.
* **Review Before Voice** — stops after validation so you can edit/approve each script.
* **Scripts Only** — no ElevenLabs usage.

Generate All shows the estimated cost first. Then watch the queue; completed jobs
have an *Open folder* button.

## 6. Daily workflow

Open the app → New Generation → pick channel → paste list → Generate All → wait →
open the channel folder. Everything else (naming, folders, voice, retries, chunking
of long scripts, cost tracking, backups) is automatic.

## 7. Backups

Settings → Storage. Automatic backups every 24 h (default) into
`%APPDATA%\VoiceForge Studio\backups`; *Create backup* and *Restore* are manual. A
backup is a consistent SQLite snapshot without API keys. Restoring relaunches the app.

## 8. Logs & diagnostics

Settings → Advanced: log level, *Open logs folder*
(`%APPDATA%\VoiceForge Studio\logs\voiceforge.log`, JSON lines, secrets redacted),
*Database integrity check*, *Reset settings*.
