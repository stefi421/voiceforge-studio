MASTER DEVELOPMENT PROMPT — YouTube AI Voice Production Manager

You are a senior software architect, full-stack desktop application engineer, AI integration specialist, and security engineer.

I want you to BUILD, TEST, PACKAGE, and DELIVER a complete, production-quality Windows desktop application called VoiceForge Studio.

This must be a real, fully functional application, not a prototype, mockup, UI-only demonstration, or unfinished project.

The application will automate my YouTube content production workflow by connecting:

1. OpenAI API — research, script generation, validation, and rewriting.
2. ElevenLabs API — text-to-speech generation using my existing ElevenLabs voices.
3. YouTube channel profiles — each channel has its own writing instructions, voice, generation settings, and output folders.
4. Local storage — automatically organized scripts, audio files, history, and project data.
5. Optional cloud synchronization — allowing the same projects to be accessed from multiple Windows computers.

The main objective is extremely simple:

I select a YouTube channel, enter a list of game titles or product names, press Generate All, and receive completed, correctly named voiceover MP3 files inside automatically created folders for that channel.

I should not need to manually write scripts, copy text into ElevenLabs, generate audio individually, rename files, or organize folders.

Everything must be automated after initial configuration.

⸻

1. REQUIRED TECHNOLOGY STACK

Use a modern, maintainable architecture.

Preferred stack:

* Electron
* React
* TypeScript
* Vite
* SQLite
* Electron Builder
* Secure Electron IPC
* Official OpenAI SDK
* Official ElevenLabs API/SDK
* Windows Credential Manager for sensitive credentials
* Zod or equivalent runtime validation
* Reliable background job queue
* Structured application logging

Use the current stable and compatible versions of all dependencies.

You may improve the architecture if you can justify why the alternative is more reliable or secure.

Do not use unofficial browser automation, scraping of logged-in accounts, session-cookie extraction, or reverse-engineered ElevenLabs endpoints.

Use officially documented APIs.

The application must work on Windows 10 and Windows 11.

Provide:

* Windows installer (.exe)
* Portable Windows version (.exe)
* Complete source code
* README
* Configuration instructions
* Automated tests
* Build instructions

The application must continue working without Claude being involved after development.

⸻

2. MAIN APPLICATION DASHBOARD

Create a premium, professional desktop interface.

Design inspiration:

* Linear
* Notion
* Modern professional productivity software

Visual requirements:

* Dark mode by default
* Optional light mode
* Clean typography
* Rounded panels
* Subtle animations
* Sidebar navigation
* Responsive desktop layout
* Professional icons
* Clear progress indicators
* Excellent usability

Main sidebar:

1. Dashboard
2. New Generation
3. Channels
4. Generation Queue
5. Scripts Library
6. Audio Library
7. Projects
8. Generation History
9. Usage & Costs
10. Settings

The dashboard should display:

* Total channels
* Scripts generated
* Voiceovers completed
* Active jobs
* Pending jobs
* Failed jobs
* OpenAI usage
* ElevenLabs usage
* Recent projects
* Recent audio files

Include quick actions:

* Generate New Voiceovers
* Add Channel
* Open Output Folder
* Resume Failed Jobs

⸻

3. YOUTUBE CHANNEL PROFILE SYSTEM

This is one of the most important features.

I manage multiple YouTube channels.

Every channel must have its own independent configuration.

Initially create editable profiles for:

* PlayTopia
* Game Vault
* VoidPulse
* RiftForge Tech
* RENVO

Allow unlimited additional profiles.

Each channel must support:

* Channel name
* Channel icon
* Channel color
* Channel description
* Content category
* Default language
* Script-writing instructions
* Script structure
* Target duration
* Minimum and maximum character counts
* Writing style
* Intro requirements
* Outro requirements
* Forbidden phrases
* Pronunciation rules
* ElevenLabs voice
* ElevenLabs model
* ElevenLabs voice settings
* Default output folder
* Preferred OpenAI model
* Research settings
* Validation rules

Channel profiles must be completely independent.

Changing one channel must never modify another channel.

I must be able to duplicate, export, import, edit, and delete profiles.

Before deleting a profile, require confirmation and preserve existing project files unless I explicitly request deletion.

⸻

4. CHANNEL-SPECIFIC SCRIPT FORMATS

Every YouTube channel has a different script style.

The application must NEVER use the same generic format for all channels.

Each channel needs its own configurable system prompt.

PlayTopia

Gaming review channel.

Requirements:

* English scripts
* Fixed approved structure
* Maximum 4,700 characters
* Consistent introduction and conclusion
* Natural spoken narration
* No URLs
* No citations inside the final narration
* No unnecessary formatting
* No invented gameplay experiences

The exact approved PlayTopia script template will be supplied by me.

Do not invent an exact template when it has not been provided.

Game Vault

Gaming review channel.

Required structure:

1. Gameplay
2. Combat or Combat & Exploration
3. Pros
4. Cons
5. Conclusion

Requirements:

* Approximately 4–5 minutes of narration
* Natural review style
* No URLs in narration
* Avoid the term “AAA”
* Consistent section order
* Accurate information about each game

VoidPulse

Gaming review channel with its own unique writing identity.

Requirements:

* English
* Distinctive narration style
* Independent structure
* Consistent formatting across scripts
* No URLs
* No copied channel templates

The approved format will be supplied separately.

RiftForge Tech

Technology reviews.

Requirements:

* English
* Product-focused review
* Accurate technical specifications
* Natural narration
* No invented benchmark results
* No invented hands-on testing
* No URLs inside narration

Support product reviews, unboxings, and shorter voiceover formats.

RENVO

Premium technology review channel.

Default sections:

1. Introduction
2. Unboxing
3. Build Quality & Design
4. Features
5. Performance & Testing
6. Pros & Cons
7. Final Verdict

Allow the structure to be customized.

The exact approved template will be supplied by me.

Critical requirement

Create a dedicated Script Template Editor.

I must be able to paste a previously approved script and its writing instructions.

The application should help identify its structure and generate an editable template.

It must not assume that one example is sufficient to infer every stylistic requirement.

Include template versioning.

Every generated script must record which template version was used.

⸻

5. MAIN GENERATION WORKFLOW

This is the primary function of the application.

I want the following workflow.

Step 1 — Select YouTube Channel

Example:

PlayTopia

Step 2 — Enter Game Titles

Provide a large text field where I can enter multiple game titles.

Example:

Emberward
Police Chief Simulator
RuneScape: Dragonwilds
Active Matter
ENDLESS Legend 2
iRacing Studios NASCAR 26

Each line represents a separate generation job.

Also support:

* Paste from clipboard
* Import TXT
* Import CSV
* Import XLSX
* Remove duplicates
* Edit titles before processing
* Reorder jobs
* Select individual jobs
* Assign different channels to selected jobs

Step 3 — Choose Generation Mode

Provide three modes.

Fully Automatic

Research → Script → Validation → ElevenLabs → Save Files.

No manual approval required when confidence and validation checks pass.

Review Before Voice

Research → Script → Validation → Wait for my approval → ElevenLabs.

Scripts Only

Research → Script → Validation → Save TXT.

Step 4 — Press Generate All

The application automatically processes all jobs.

Show the status of each game:

* Pending
* Researching
* Research Review Required
* Writing Script
* Validating Script
* Script Ready
* Awaiting Approval
* Generating Audio
* Saving Files
* Completed
* Failed
* Paused

I must be able to pause, resume, retry, or cancel individual jobs.

I must also be able to pause or resume the entire queue.

⸻

6. OPENAI API INTEGRATION

The application must use the official OpenAI API.

Important:

This integration is separate from the ChatGPT website and my existing ChatGPT conversations.

The application must not pretend to access my ChatGPT conversation history or memory automatically.

Instead, the application must use the exact channel-specific prompts, templates, examples, and settings I provide.

Requirements:

* Secure API key configuration
* Model selection
* Generation parameters
* Request timeout handling
* Rate-limit handling
* Usage tracking
* Error reporting
* Request cancellation where supported
* Retry logic
* Structured generation results

For each game:

1. Identify the correct game.
2. Gather reliable information.
3. Generate a script following the selected channel template.
4. Validate its structure and length.
5. Save the script.
6. Send the approved or automatically validated narration text to ElevenLabs.

Do not hardcode a single model.

Allow selecting supported models through configuration.

Use the currently supported OpenAI API endpoints and SDK methods.

⸻

7. AUTOMATIC GAME RESEARCH

I will frequently enter only a game title.

The application must be able to research that game before writing a review.

Create a research subsystem using legitimate, documented search or information APIs.

Research sources may include:

* Official game websites
* Official developer announcements
* Steam store pages
* Publisher websites
* Official release information
* Other reputable gaming publications

Do not assume the OpenAI model has access to live internet information unless a supported research/search tool is explicitly configured.

The system must identify:

* Correct game title
* Developer
* Publisher
* Genre
* Release status
* Platforms
* Gameplay mechanics
* Combat systems
* Exploration systems
* Multiplayer features
* Important mechanics
* Confirmed technical information

Distinguish confirmed information from uncertainty.

Never fabricate:

* Personal gameplay experiences
* FPS results
* Performance benchmarks
* Playtime
* Release dates
* Game mechanics
* Personal opinions presented as firsthand testing

If multiple games have similar names, the application must ask me to choose the correct game.

If a title is unreleased, the script must clearly distinguish previews from reviews.

If reliable information is insufficient, stop the job and request additional information rather than generating a fictional review.

Keep research sources in project metadata, not in the final narration script.

For technology products, use the same principle: prioritize manufacturer documentation and verifiable specifications, and distinguish specifications from actual testing.

⸻

8. SCRIPT QUALITY CONTROL

Create a complete automatic script validation system.

Before generating audio, validate:

* Correct channel selected
* Correct game or product
* Correct template version
* Required sections present
* Required section order
* Character count
* Estimated narration duration
* Language
* No unwanted URLs
* No citation markers
* No unsupported claims
* No prohibited words
* No unnecessary markdown formatting
* No accidental AI instructions in narration

Use deterministic checks for structural rules.

Use an additional AI review pass for semantic accuracy when necessary.

If the script fails validation, allow automatic rewriting up to a configurable maximum number of attempts.

Do not create infinite regeneration loops.

Do not send a failed script to ElevenLabs.

Provide a script preview and editor.

Allow me to:

* Edit
* Approve
* Reject
* Regenerate
* Compare versions
* Restore previous versions

Every script must be saved before audio generation begins.

⸻

9. ELEVENLABS INTEGRATION

Integrate the official ElevenLabs text-to-speech API.

This is the second most important feature.

I already use ElevenLabs and want to continue using my existing voices.

The application must allow me to enter my ElevenLabs API key securely.

After connecting:

* Retrieve accessible voices
* Display voice names
* Display available voice IDs
* Allow previewing voices
* Allow selecting a voice per channel
* Allow choosing supported models
* Allow configuring voice settings

Where supported by the selected model, expose:

* Stability
* Similarity boost
* Style
* Speaker boost
* Speed

Only show controls supported by the chosen ElevenLabs model.

Do not invent unsupported API parameters.

Preserve exact voice settings for each channel.

When a script is ready:

1. Retrieve the channel voice configuration.
2. Check available usage information when supported.
3. Submit narration to ElevenLabs.
4. Receive generated audio.
5. Validate the audio file.
6. Save the audio to the correct output directory.
7. Mark the job completed.

Support MP3 as the default output format.

Allow additional supported formats where available.

Support long scripts using appropriate officially supported endpoints or chunking strategies.

If chunking is required:

* Split at natural sentence or paragraph boundaries.
* Preserve the original text.
* Minimize audible discontinuities.
* Combine audio in the correct order.
* Verify the final file.
* Avoid duplicated or missing speech.

Allow audio preview inside the application.

Allow regenerating audio without rewriting the script.

Allow changing the voice and generating a new audio version.

Do not overwrite existing audio versions without explicit permission.

⸻

10. AUTOMATIC FOLDER ORGANIZATION

The application must automatically create a clean folder structure.

Example:

VoiceForge Studio/
PlayTopia/
Emberward/
Script.txt
Voice.mp3
Research.json
Police Chief Simulator/
Script.txt
Voice.mp3

Game Vault/
    Active Matter/
        Script.txt
        Voice.mp3
VoidPulse/
RiftForge Tech/
RENVO/

I must be able to select the root output folder.

The application must create missing folders automatically.

Use safe Windows filenames.

Prevent path traversal, invalid characters, reserved names, and excessively long paths.

If two projects have identical names, use stable project identifiers to prevent collisions.

Support:

* Open project folder
* Open channel folder
* Copy file path
* Export script
* Export audio
* Export entire project
* Rename project
* Archive project

Save scripts as UTF-8 TXT.

Save generated audio as valid MP3 files.

Use atomic file writes wherever practical.

Never mark a job completed before its output files are safely written and validated.

⸻

11. BATCH GENERATION ENGINE

The application must be designed for large workloads.

Example:

I select Game Vault and enter 50 game titles.

The application should automatically:

1. Create 50 jobs.
2. Research each game.
3. Generate each script.
4. Validate each script.
5. Generate each voiceover.
6. Save every output.
7. Display the final results.

Support at least 100 queued jobs without UI instability.

Do not send 100 simultaneous requests.

Implement configurable concurrency limits separately for OpenAI and ElevenLabs.

Respect API rate limits and provider usage restrictions.

Use exponential backoff with jitter for transient errors.

Honor retry-after information where provided.

Do not retry permanent errors indefinitely.

Provide accurate progress reporting.

Example:

Total: 50
Completed: 31
Processing: 2
Pending: 15
Failed: 2

The queue must survive application restarts.

Use persistent job state in SQLite.

On restart, inspect unfinished jobs and recover safely.

Never assume that an interrupted API request failed before checking whether an output or result was already persisted.

Prevent duplicate generation caused by repeated clicks, crashes, or concurrent workers.

Use idempotency mechanisms where available.

Where an external provider does not support idempotency, explain and minimize the remaining duplicate-billing risk.

⸻

12. USAGE AND COST TRACKING

Create a dedicated Usage & Costs dashboard.

Track:

* OpenAI requests
* Input tokens
* Output tokens
* Estimated OpenAI costs
* ElevenLabs character usage or other applicable billing units
* Estimated ElevenLabs costs
* Jobs per channel
* Costs per channel
* Costs per project
* Daily usage
* Monthly usage

Use provider-reported usage whenever available.

Clearly label estimated values.

Do not invent remaining ElevenLabs credits if the API does not expose them.

Allow manual configuration of pricing when necessary.

Include spending safeguards:

* Warning before large batches
* Estimated batch cost
* Configurable daily spending limit
* Configurable monthly spending limit
* Confirmation before expensive regeneration

If a spending limit is reached, pause new API requests.

Make clear that local spending limits are safeguards, not guaranteed provider-side billing caps.

⸻

13. SCRIPT AND AUDIO LIBRARY

Create searchable libraries.

Scripts Library:

* Game or product title
* Channel
* Creation date
* Template version
* Character count
* Word count
* Estimated duration
* Status
* Script versions

Audio Library:

* Title
* Channel
* Voice
* ElevenLabs model
* Duration
* File size
* Generation date
* Audio versions
* Output location

Include search, filters, sorting, and bulk actions.

I should be able to find any previously generated script or voiceover in seconds.

⸻

14. MULTIPLE WINDOWS COMPUTERS

I may install the application on three different Windows computers.

Design the architecture so optional synchronization can be added or enabled.

The application must work locally without a cloud subscription.

For multi-PC synchronization, provide a secure architecture using a suitable backend, such as Supabase or another well-supported solution.

Requirements:

* User authentication
* Shared channel profiles
* Shared project metadata
* Shared scripts
* Shared generation history
* Optional shared audio files
* Conflict handling
* Secure access controls
* Recovery from interrupted synchronization

Do not synchronize raw API keys.

Each computer should store its own secrets securely.

Never directly synchronize a live SQLite database file through OneDrive or Google Drive.

Do not claim multi-PC synchronization is implemented unless it has been built and tested.

If cloud sync requires external infrastructure or payment, explain this clearly.

⸻

15. SECURITY REQUIREMENTS

Treat security as a critical engineering requirement.

Requirements:

* Official provider APIs only
* No browser cookie extraction
* No password scraping
* No unofficial login automation
* No API keys in source code
* No plaintext API keys in SQLite
* Secure Windows credential storage
* No secrets in logs
* Secure IPC boundaries
* Electron context isolation
* Electron sandbox where compatible
* Node integration disabled in renderer
* Strict Content Security Policy
* Validate all IPC inputs
* Validate file paths
* Prevent arbitrary command execution
* Avoid unsafe shell interpolation
* Protect against malicious research content
* Do not execute instructions embedded in retrieved webpages
* Dependency vulnerability scanning

Do not enable unnecessary permissions.

Do not use remote code execution or auto-update mechanisms that bypass integrity checks.

The application must not require access to my YouTube account.

It only generates scripts and voiceovers.

Do not request YouTube OAuth permissions.

Do not upload videos.

Do not publish content to YouTube.

⸻

16. ERROR HANDLING

Handle real-world failures gracefully.

Examples:

* No internet connection
* Invalid OpenAI API key
* Invalid ElevenLabs API key
* Insufficient credits
* API rate limits
* API downtime
* Research unavailable
* Ambiguous game title
* Invalid script
* Unsupported voice settings
* Audio generation failure
* Disk full
* Missing output folder
* Windows permission errors
* Application crash
* Interrupted generation

Every error must produce a useful explanation.

Do not display generic messages such as “Something went wrong” without additional actionable information.

Allow retrying failed stages without unnecessarily repeating completed stages.

⸻

17. SETTINGS PAGE

Create a complete Settings page with the following sections.

General

* Theme
* Language
* Startup behavior
* Notifications
* Default output directory

OpenAI

* API key
* Connection test
* Model selection
* Research configuration
* Generation settings
* Request limits

ElevenLabs

* API key
* Connection test
* Voice refresh
* Default model
* Audio settings
* Usage information

Generation

* Automatic or manual approval
* Maximum concurrent jobs
* Retry settings
* Validation strictness
* Duplicate detection
* Default output format

Storage

* Output folder
* Database location
* Backup location
* Export data
* Import data
* Restore backup

Synchronization

* Enable or disable cloud sync
* Account settings
* Synchronization status
* Conflict resolution

Advanced

* Diagnostic logs
* API error details
* Database integrity checks
* Reset settings
* Application version

⸻

18. BACKUP AND RECOVERY

Create an automatic backup system.

Support:

* Manual backup
* Scheduled local backups
* Restore from backup
* Export configuration
* Export channel templates
* Export projects
* Export generation history

Backups must be consistent and validated.

Avoid exposing API credentials inside exported backup files.

Provide a recovery mechanism for corrupted application state.

⸻

19. AUTOMATED TESTING

Write meaningful automated tests.

At minimum, test:

1. Channel creation
2. Channel editing
3. Channel isolation
4. Template selection
5. Template versioning
6. Batch job creation
7. Duplicate detection
8. Script validation
9. Character limits
10. Research ambiguity handling
11. OpenAI request handling
12. ElevenLabs request handling
13. API rate limits
14. Retry behavior
15. Cancellation
16. Pause and resume
17. Crash recovery
18. SQLite persistence
19. File naming
20. Folder creation
21. Atomic file writes
22. API key storage
23. Invalid credentials
24. Insufficient credits
25. Audio validation
26. Cost tracking
27. Backup and restore
28. Electron IPC security
29. Installer build
30. Portable application build

Use mocked API responses for automated tests.

Do not spend real API credits during automated testing unless I explicitly authorize live integration tests.

Also create a clearly labeled manual end-to-end test mode.

⸻

20. DEVELOPMENT AND DELIVERY PROCESS

I do not want a conceptual explanation or a collection of code snippets.

I want you to implement the application.

Follow this process:

Phase 1 — Architecture

Define the database schema, module boundaries, IPC contracts, queue design, security architecture, and provider integrations.

Phase 2 — Core Application

Build the Electron application, React interface, SQLite database, settings, and channel management.

Phase 3 — AI Pipeline

Implement research, OpenAI script generation, template validation, and script persistence.

Phase 4 — ElevenLabs Pipeline

Implement voice configuration, speech generation, audio persistence, and regeneration.

Phase 5 — Automation

Implement batch processing, concurrency control, retries, cancellation, and recovery.

Phase 6 — Libraries and Analytics

Implement scripts, audio, projects, history, usage, and cost tracking.

Phase 7 — Testing and Security

Run tests, review dependencies, test recovery, and fix critical issues.

Phase 8 — Windows Packaging

Build the installer and portable executable.

Phase 9 — Final Delivery

Deliver the complete source code and built application.

At the end, provide:

* Installer download
* Portable executable
* Complete source archive
* README
* Setup guide
* Test results
* Security notes
* Known limitations

If the environment cannot build a genuine Windows executable, clearly explain the limitation and provide a reproducible Windows build process.

Do not claim an installer exists unless the actual file was successfully built.

Do not fabricate test results.

⸻

21. REQUIRED USER EXPERIENCE

The application should feel extremely simple despite its advanced architecture.

My normal daily workflow must be:

1. Open VoiceForge Studio.
2. Select a YouTube channel.
3. Paste a list of game titles.
4. Click Generate All.
5. Wait for processing.
6. Open the channel folder.
7. Find the completed MP3 voiceovers and TXT scripts.

That is all.

No manual copying between ChatGPT and ElevenLabs.

No manual audio downloads.

No manually creating folders.

No repeatedly configuring the same voice.

No manually renaming dozens of files.

All channel-specific settings must persist.

⸻

22. ADDITIONAL PREMIUM FEATURES

Implement these features where practical:

* Drag-and-drop script import
* Drag-and-drop game lists
* Batch regeneration
* Regenerate only selected jobs
* Built-in audio player
* Waveform visualization
* Keyboard shortcuts
* Desktop completion notifications
* Estimated queue completion time
* Export job report
* Import/export channel profiles
* Script version comparison
* Favorite voices
* Per-channel generation presets
* Research cache
* Script cache
* Audio file integrity verification
* Automatic cleanup of temporary files

Optional advanced feature:

Allow scheduling a batch for a future time.

Scheduled jobs must run only while the application or a properly installed background service is running.

Do not claim that a closed application can execute scheduled jobs unless an actual background execution mechanism has been implemented.

⸻

23. NON-NEGOTIABLE RULES

* Build a real application.
* Do not stop at UI mockups.
* Do not create fake API integrations.
* Do not hardcode demo responses as real generation results.
* Do not fabricate game information.
* Do not fabricate benchmarks or firsthand experiences.
* Do not expose API keys.
* Do not require my YouTube login.
* Do not automatically publish YouTube videos.
* Do not overwrite completed audio without permission.
* Do not silently discard failed jobs.
* Do not charge API credits for tests without permission.
* Do not claim cloud synchronization works unless tested.
* Do not claim security guarantees that have not been verified.
* Do not claim successful builds without real artifacts.

The core functionality must be fully implemented before spending time on optional visual enhancements.

Prioritize reliability, security, and automation over unnecessary complexity.

⸻

24. FINAL ACCEPTANCE TEST

The application will be considered successful when I can do the following:

1. Install VoiceForge Studio on Windows.
2. Enter my OpenAI API key.
3. Enter my ElevenLabs API key.
4. Configure my PlayTopia channel.
5. Import the exact PlayTopia script template.
6. Select my existing ElevenLabs voice.
7. Enter five game titles.
8. Click Generate All.
9. Watch the application research the games.
10. Receive five valid scripts following the correct template.
11. Receive five correctly generated MP3 voiceovers.
12. Find all ten files in their correct folders.
13. Close and reopen the application without losing history.
14. Regenerate one voice without regenerating its script.
15. Repeat the process using Game Vault with a different template and voice.

All external API requests must use real, supported integrations.

If an integration cannot be tested because I have not supplied credentials, mark it as awaiting live verification rather than claiming success.

⸻

25. IMPORTANT FINAL INSTRUCTION

I want this to become my long-term production tool for managing voiceover generation across multiple YouTube channels.

Treat this as a serious desktop software project, not a small automation script.

Make sound engineering decisions independently.

Use professional architecture, clean code, meaningful tests, and maintainable components.

You may ask me for information that is genuinely required, such as API credentials, approved script templates, or voice selections.

Never ask me to paste secret API keys into the conversation or source code. Instead, implement a secure settings screen where I enter them locally.

Start implementing the application now.

Continue through development, testing, and packaging rather than stopping after the architecture plan.

When a feature cannot be completed, state exactly what remains unfinished.

The final result must be a working Windows application that transforms game titles into channel-specific scripts and completed ElevenLabs voiceovers with minimal manual interaction.