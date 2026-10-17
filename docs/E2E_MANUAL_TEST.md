# Manual end-to-end test (uses real API credits)

Automated tests never touch the real APIs. This checklist is the **manual** verification
of the acceptance test from the specification. Enable *Settings → Advanced → Manual E2E
test mode* to show the same checklist inside the app on the New Generation page.

Each step spends real credits where marked (💳). Expect roughly 5 research + 5 script
+ 5 review calls (a few cents to a few tens of cents on gpt-5-class models) and about
20,000 ElevenLabs characters for five ~4,000-character scripts.

| # | Step | Expected result | Status |
|---|------|-----------------|--------|
| 1 | Install `VoiceForge-Studio-Setup-1.0.0-x64.exe` (or run the portable exe) | App opens on Dashboard, dark theme, 5 seeded channels | ☐ |
| 2 | Settings → OpenAI → paste key → Save → Test connection | "Connected to OpenAI. N models visible" | ☐ |
| 3 | Settings → ElevenLabs → paste key → Save → Test connection | Shows plan tier and characters used/limit | ☐ |
| 4 | Channels → PlayTopia → Templates → paste the approved PlayTopia script + instructions → Analyze → review caveats → Use as new version → set active (placeholder flag off) | Channel card no longer shows "placeholder" | ☐ |
| 5 | Channels → PlayTopia → Voice → Refresh voices → pick your existing voice → preview → Save | Voice name shown on the channel card | ☐ |
| 6 | New Generation → PlayTopia → paste 5 titles → Fully Automatic → Generate All 💳 | Estimate dialog shows cost; 5 jobs appear in the queue | ☐ |
| 7 | Watch the queue | Statuses move Researching → Writing Script → Validating → Generating Audio → Saving → Completed | ☐ |
| 8 | Scripts Library | 5 scripts, template version 2 (your approved one), ≤ 4,700 chars, no URLs | ☐ |
| 9 | Audio Library → play each | 5 MP3s play; duration roughly matches script length | ☐ |
| 10 | Open channel folder | `Documents\VoiceForge Studio\PlayTopia\<Title>\Script.txt`, `Voice.mp3`, `Research.json`, `project.json` for each title | ☐ |
| 11 | Close and reopen the app | Dashboard counters, history, scripts and audio unchanged | ☐ |
| 12 | Audio Library → one item → Regenerate with voice X 💳 | New `Voice_v2.mp3`, original `Voice.mp3` untouched, no new script version | ☐ |
| 13 | Channels → Game Vault → Voice → pick a different voice; New Generation → Game Vault → 2 titles → Generate All 💳 | Scripts follow Gameplay / Combat / Pros / Cons / Conclusion, start with the fixed intro, never contain "AAA" | ☐ |
| 14 | Enter a deliberately ambiguous title (e.g. "Doom") | Job stops at *Research Review Required* and offers candidates | ☐ |
| 15 | Settings → Spending → daily limit $0.01 → queue a job | Job stays Pending, notification "Spending limit reached"; raising the limit resumes it | ☐ |
| 16 | Pull the network cable mid-batch, reconnect | Jobs show a network error, retry automatically, then complete | ☐ |

Record the date, app version and outcome of each row here when the test is performed.
As of delivery, rows 1–16 are **awaiting live verification** because no API credentials
were available to the build environment.
