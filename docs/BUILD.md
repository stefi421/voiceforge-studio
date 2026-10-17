# Building from source

## Requirements

* Node.js 22 LTS (the project was built with 22.22) and npm 10.
* Windows 10/11 for a native build. Linux/macOS can cross-build the Windows targets
  when `wine` (64- and 32-bit) is installed — electron-builder needs it to generate
  the NSIS uninstaller stub.
* No Visual Studio / Python build tools are needed: the app has **no native Node
  modules** (SQLite comes from Electron's built-in `node:sqlite`).

## Commands

```bash
npm ci                 # install exact dependency versions from package-lock.json
npm run typecheck      # tsc for main/preload and renderer
npm test               # vitest, mocked providers, no API credits used
npm run dev            # electron-vite dev server with hot reload
npm run build          # compiles to out/
npm run package:win    # out/ + electron-builder → release/*.exe (nsis + portable)
```

Artifacts land in `release/`:

* `VoiceForge-Studio-Setup-<version>-x64.exe` — NSIS installer (per-user, custom
  install directory allowed, desktop + Start menu shortcuts, uninstaller keeps
  `%APPDATA%` data).
* `VoiceForge-Studio-Portable-<version>-x64.exe` — single-file portable build.
* `win-unpacked/` — the raw app folder (useful for debugging).

## Reproducible Windows build on GitHub Actions

`.github/workflows/build-windows.yml` builds both executables on a `windows-latest`
runner on every `v*` tag or manual dispatch and uploads them as a workflow artifact.
This is the recommended way to produce release builds: push the repo to GitHub, tag
`v1.0.1`, download the artifact.

## Code signing (optional)

Add `win.certificateFile` / `win.certificatePassword` (or `signtoolOptions`) to
`electron-builder.yml`, or set `CSC_LINK` / `CSC_KEY_PASSWORD` in the CI environment.
Unsigned builds work but trigger SmartScreen on first launch.

## Updating

There is no auto-updater by design (no remote code). Ship a new installer; it
upgrades in place and keeps `%APPDATA%\VoiceForge Studio` (database, secrets, logs).
Database migrations run automatically on first start of a newer version.
