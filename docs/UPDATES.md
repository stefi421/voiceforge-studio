# Updating VoiceForge Studio

You never have to uninstall. There are two ways to move to a newer version; both keep
your database, channel profiles, templates, history and API keys
(`%APPDATA%\VoiceForge Studio`).

## 1. In-app update (recommended, installer builds only)

*Settings → Updates*:

1. **Check for updates** (also runs automatically ~20 s after launch when
   *Check on startup* is on — it only *checks*, it never downloads on its own).
2. If a newer version exists you see its version and release notes → **Download**
   (progress bar). The file is verified against the sha512 published with the
   release; a corrupted download is rejected.
3. **Restart and install** → the app closes, the new installer runs silently over the
   existing installation and the app relaunches. Shortcuts and data stay in place.

The update source is a GitHub repository with Releases (owner / repository fields in
*Settings → Updates*). Pre-releases are ignored unless *Allow pre-releases* is on.

The **portable** build cannot replace its own running `.exe`; it tells you when a new
version exists and opens the releases page so you can download the new file and replace
the old one.

## 2. Manual

Run the new `VoiceForge-Studio-Setup-<version>-x64.exe` over the existing install. The
NSIS installer upgrades in place; nothing has to be removed first.

## Publishing a release (so the updater has something to find)

The updater needs these files attached to a GitHub Release whose tag is `v<version>`:
`VoiceForge-Studio-Setup-<version>-x64.exe`, its `.blockmap`, and `latest.yml`
(electron-builder generates all three). The portable exe is attached for manual
downloads.

`.github/workflows/build-windows.yml` does this automatically. The source lives at
<https://github.com/stefi421/voiceforge-studio> (public).

1. Bump `version` in `package.json` (e.g. `1.2.0`), commit and push to `main`.
2. Either push a tag (`git tag v1.2.0 && git push origin v1.2.0`) **or** open
   *Actions → Build and release Windows app → Run workflow* and tick **publish**.
3. The workflow runs the tests, builds on a Windows runner, creates the tag and the
   release itself, uploads the installer, `.blockmap`, `latest.yml` and the portable
   exe, and removes any half-published release for the same version. Installed copies
   see the new version on their next check.

The full electron-builder log of every run is committed to the `ci-logs` branch
(`run-<id>.log`), so a failure can be diagnosed without signing in to GitHub.

### Public vs. private repository

* The updater downloads release assets **without any token** — so the repository that
  holds the releases must be **public** (the source code can be public too, this is
  the simplest setup).
* To keep the source private: create a second, public, releases-only repository (e.g.
  `voiceforge-studio-releases`), add a fine-grained personal access token with
  *Contents: write* on that repository as the secret `GH_RELEASE_TOKEN`, and set the
  repository variable `RELEASE_REPO=voiceforge-studio-releases` in the private source
  repository. The workflow then publishes there. Point *Settings → Updates →
  Repository* at the public one.

Default feed in this build: `stefi421 / voiceforge-studio`. Change it in Settings if
you use different names.

## Code signing (optional, recommended later)

The installers are currently unsigned (no certificate was supplied), so Windows
SmartScreen warns on the first manual install. In-app updates are not affected by
SmartScreen because the installer is launched by the already-running app, but a
signed build is still the professional option: add the certificate to the workflow
(`CSC_LINK` / `CSC_KEY_PASSWORD` secrets) and electron-updater will additionally verify
the publisher of every downloaded installer.
