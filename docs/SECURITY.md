# Security notes

What is verified (by code review and automated tests) versus what is claimed.

## Credentials

* OpenAI and ElevenLabs keys are entered only in Settings, never in the source tree,
  config files, logs, backups or exports.
* Keys are encrypted with Electron `safeStorage`. On Windows this is DPAPI, bound to the
  signed-in Windows user — the same protection class as Windows Credential Manager,
  without a native add-on (the `keytar` package that wrapped Credential Manager is
  archived). Encrypted blobs live in `%APPDATA%\VoiceForge Studio\secrets.json`.
* The database (`voiceforge.sqlite`) never contains a key. Tests assert that the
  secrets file does not contain the plaintext key and that backups/exports do not
  contain it.
* The structured logger redacts strings that look like provider keys before writing.

## Electron hardening (verified in `src/main/index.ts` and `src/preload/index.ts`)

* `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
* The preload exposes exactly two functions (`invoke`, `on`) through `contextBridge`.
  The event list is a fixed allow-list.
* Every IPC handler validates its payload with zod before running (`IpcRegistry`),
  checks that the sender frame belongs to the app's own origin, and returns
  normalised errors (no stack traces, no secrets).
* Content Security Policy is injected on every response and also declared in
  `index.html`: `default-src 'self'; script-src 'self'; connect-src 'self' vfmedia:` …
  No remote scripts, fonts or styles. The only custom scheme (`vfmedia://`) serves
  audio files that are inside the configured output root (path containment check)
  and ElevenLabs voice previews fetched from an allow-listed host.
* `setWindowOpenHandler` denies all popups (external `https` links open in the system
  browser); `will-navigate` blocks navigation away from the app.
* All permission requests from the renderer are denied.
* No auto-updater and no remote code loading. Updates are a new installer.

## Filesystem

* Folder and file names are sanitised (`safeSegment`): invalid Windows characters,
  reserved device names (CON, NUL, COM1…), trailing dots/spaces, path traversal
  segments and over-long names are all handled; tests cover each case.
* Output paths are computed from the project record, not from user-supplied strings,
  and every write is atomic (temp file + fsync + rename).
* The app never spawns a shell. `shell.openPath` / `showItemInFolder` are the only
  OS integrations.

## Provider content

* Research text retrieved from the web is passed to the writer model inside
  `<research_data>` tags with an explicit instruction that it is untrusted data and
  must not be followed as instructions. The same wrapper is used for user-pasted
  notes and example scripts. This reduces, but cannot eliminate, prompt injection —
  the deterministic validator (URLs, citations, markdown, AI-leak phrases) is the
  second line of defence, and nothing reaches ElevenLabs unless it passes.
* Only official SDKs and documented endpoints are used: `openai` (Responses API with
  the `web_search` tool) and `@elevenlabs/elevenlabs-js` (text-to-speech, voices,
  models, subscription). No scraping, cookies or reverse-engineered endpoints.

## Dependency audit (run on 2026-10-17)

* `npm audit --omit=dev`: **0 vulnerabilities** in production dependencies.
* `npm audit` (including dev tooling): 8 moderate advisories, all in the
  `electron-builder` packaging toolchain (`@electron/get → global-agent → roarr →
  sprintf-js`, a ReDoS in a logging helper). They affect the build machine only and
  are not shipped inside the application. No fixed upstream version exists yet.

## Not verified / known gaps

* No third-party penetration test was performed.
* The portable executable and installer are **not code-signed** (no certificate was
  supplied). Windows SmartScreen will warn on first launch.
* Cloud synchronization is not implemented (see `SYNC_ARCHITECTURE.md`).
