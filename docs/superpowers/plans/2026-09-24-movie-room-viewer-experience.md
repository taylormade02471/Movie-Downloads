# Movie Room Viewer Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Ship the synchronized Taylor-Made Movies viewer experience for web, mobile web, and paired Fire TV while preserving the existing secure OneDrive playback and pairing flow.

**Architecture:** Add a versioned server-authoritative viewer-state manager backed by the existing KV abstraction and atomic compare-and-set updates. Build the web experience as focused browser modules around the existing static HTML/JavaScript app, and add a small Fire TV state/repository layer with recycled horizontal shelves, details, playback progress, and D-pad focus restoration. Keep existing authentication, playback-ticket, Cast/AirPlay, QR pairing, wake-lock, and stall-recovery contracts.

**Tech Stack:** Node 22.9+, dependency-free Node HTTP server, MemoryStore/Upstash REST KV, Vercel catch-all functions, vanilla HTML/CSS/JavaScript with Safari-compatible syntax, Android Java, Media3 ExoPlayer, JUnit, Node test runner.

**Spec:** \`docs/superpowers/specs/2026-09-24-movie-room-viewer-experience-design.md\`

## Global Constraints

- Use the visual tokens \`#080808\`, \`#111111\`, \`#181818\`, \`#D4AF37\`, \`#F2CF63\`, \`#FFFFFF\`, \`#AAAAAA\`, and \`#E53935\` from the accepted spec.
- Keep app UI labels and controls code-native; do not bake navigation, buttons, metadata, or state text into artwork.
- Preserve password auth, signed HttpOnly sessions, same-origin mutation checks, rate limits, OneDrive tickets, byte ranges, Cast/AirPlay, QR pairing, token renewal, wake-lock, stall recovery, and Safari-compatible JavaScript.
- Viewer state is synchronized per fixed profile \`home\`, \`family\`, or \`guest\`; profiles are organizational under one shared password.
- Viewer-state JSON must never contain passwords, session IDs, device secrets, playback tickets, OneDrive tokens, or raw cookies.
- Viewer-state routes fail closed with \`503\` when durable storage is unavailable on Vercel.
- Use atomic compare-and-set for state mutations; do not use naive \`get\` → modify → \`set\`.
- Browser progress is flushed about every 15 seconds and on pause, ended, movie switch, visibility loss, pagehide, logout, and session expiry.
- Fire TV APKs go only to the \`MOVIEROOM\` USB; do not copy new APKs into the OneDrive Mac copy.
- Do not reformat the \`MOVIEROOM\` USB during implementation; replace APK files only after a verified build.
- MP4/H.264/AAC remains the safe Fire TV baseline; no transcoder is introduced.
- New browser JavaScript must remain compatible with the existing Safari test: no optional chaining or nullish coalescing without adding a build step.

## Review Focus

- Concurrent state writes: test CAS conflict/retry so browser and TV operations do not disappear.
- Profile leakage: test that Home, Family, and Guest never share progress, flags, or queues.
- Library churn: test missing, renamed, uploading, and temporarily unavailable movies without unsafe pruning.
- Playback lifecycle: test link refresh, stalls, resume restore, completion, pagehide, logout, and expiry together.
- Remote/responsive input: test D-pad focus, keyboard shortcuts, touch rails, modal Back/Escape, and player modes.

---

### Task 1: Atomic storage and viewer-state domain

**Files:**
- Create: \`lib/viewer-state.js\`
- Create: \`test/viewer-state.test.js\`
- Create: \`test/store.test.js\`
- Modify: \`lib/store.js\`

**Interfaces:**
- \`MemoryStore.compareAndSet(key, expectedValue, nextValue, ttlMs)\` returns a boolean.
- \`UpstashStore.compareAndSet(key, expectedValue, nextValue, ttlMs)\` uses one Redis \`EVAL\`.
- \`createDefaultViewerState(profileId, now)\` returns a versioned snapshot.
- \`normalizeViewerState(raw, profileId, now)\` returns a bounded valid snapshot.
- \`applyViewerOperations(state, operations, context)\` returns \`{ state, changed }\`.
- \`createViewerStateManager({ store, listMovies, now, durable, ttlMs })\` exposes \`get(profileId)\` and \`apply(profileId, operations)\`.

- [ ] **Step 1: Write failing store tests.** Cover successful/stale compare-and-set, TTL, serialized updates, one Upstash \`EVAL\`, and Redis error payloads.
- [ ] **Step 2: Run RED:** \`node --test test/store.test.js\`. It must fail because \`compareAndSet\` is absent.
- [ ] **Step 3: Implement store support.** Serialize MemoryStore checks and use a Lua compare/replace/expiry script for Upstash.
- [ ] **Step 4: Run GREEN:** \`node --test test/store.test.js\`.
- [ ] **Step 5: Write failing viewer-state tests.** Cover defaults, progress, completion, flags, queue operations, settings, derived shelves/history, invalid data, dangerous keys, bounded documents, and profile isolation.
- [ ] **Step 6: Run RED:** \`node --test test/viewer-state.test.js\`.
- [ ] **Step 7: Implement \`lib/viewer-state.js\`.** Use \`viewer-state:v1:<profileId>\`, retain orphan records, prune only after successful reconciliation, and never clear explicit completion from late progress.
- [ ] **Step 8: Run GREEN and regression:** \`node --test test/viewer-state.test.js test/store.test.js\`; then \`npm.cmd test\`.
- [ ] **Step 9: Commit:**
~~~powershell
git add lib/store.js lib/viewer-state.js test/store.test.js test/viewer-state.test.js
git commit -m "feat: add atomic synchronized viewer state"
~~~

### Task 2: Authenticated browser and Fire TV state APIs

**Files:**
- Modify: \`server.js\`
- Create: \`api/viewer-state.js\`
- Create: \`api/tv/viewer-state.js\`
- Modify: \`test/server.test.js\`
- Modify: \`.env.example\`
- Modify: \`README.md\`

**Interfaces:**
- Browser \`GET /api/viewer-state?profileId=<id>\` returns a private/no-store snapshot.
- Browser \`PATCH /api/viewer-state\` accepts \`{ profileId, operations }\`.
- Fire TV \`GET /api/tv/viewer-state\` derives profile from its device record.
- Fire TV \`PATCH /api/tv/viewer-state\` accepts only \`{ operations }\`.
- Pairing approval accepts a validated \`profileId\` and stores it on \`tv-device:<deviceId>\`.

- [ ] **Step 1: Write failing HTTP tests.** Cover empty/default state, profile isolation, auth, same-origin rejection, invalid operations, browser↔TV visibility, pairing profile binding, TV override rejection, and durable-storage \`503\`.
- [ ] **Step 2: Run RED:** \`node --test test/server.test.js --test-name-pattern="viewer state|profile|state"\`.
- [ ] **Step 3: Initialize the manager and route dispatch.** Reuse the existing session/device/provider managers and no-store headers; add Vercel wrappers that delegate to the same handler.
- [ ] **Step 4: Bind pairing approval to profile.** Normalize the allowlist and make TV routes derive profile from the stored device record.
- [ ] **Step 5: Document durable state.** Update \`.env.example\` and \`README.md\` without recording real secrets.
- [ ] **Step 6: Run GREEN:** focused HTTP command above, then \`npm.cmd test\`.
- [ ] **Step 7: Commit:**
~~~powershell
git add server.js api/viewer-state.js api/tv/viewer-state.js test/server.test.js .env.example README.md
git commit -m "feat: expose synchronized viewer state APIs"
~~~

### Task 3: Web discovery surface

**Files:**
- Create: \`public/viewer-state.js\`
- Modify: \`public/index.html\`
- Modify: \`public/app.js\`
- Modify: \`test/server.test.js\`

**Interfaces:**
- \`window.MovieRoomViewerState\` and CommonJS export provide \`createDefaultState\`, \`normalizeState\`, \`deriveContinueWatching\`, \`deriveHistory\`, \`deriveShelfMovies\`, and operation builders.
- \`public/app.js\` uses \`viewerStateClient.load(profileId)\`, \`viewerStateClient.apply(operations)\`, and \`viewerStateClient.flush()\`.
- HTML adds \`#hero-banner\`, shelf containers, \`#details-dialog\`, \`#queue-drawer\), and mobile navigation IDs.

- [ ] **Step 1: Write failing browser-state tests.** Cover normalization, shelf order, corrupt cache, stale IDs, profile keys, and Details-versus-Play activation.
- [ ] **Step 2: Run RED:** \`node --test test/server.test.js --test-name-pattern="shelf|details|viewer state|profile"\`.
- [ ] **Step 3: Implement \`public/viewer-state.js\`.** Keep Safari-safe syntax and finite-number guards.
- [ ] **Step 4: Extend the HTML shell.** Add hero, horizontal rails, dialog, queue drawer, visible pre-player status, skeletons, mobile bottom nav, and tokenized responsive CSS.
- [ ] **Step 5: Refactor cards.** Use accessible article/card containers with separate Play, Details, and compact action controls; do not nest buttons.
- [ ] **Step 6: Render hero and shelves.** Choose a deterministic featured movie, show only available metadata, show progress/remaining time, and add scroll-snap/rail controls.
- [ ] **Step 7: Implement Details and flag actions.** Support Play/Resume, Favorite, Watch Later, Queue, close/Back/Escape, and success toasts.
- [ ] **Step 8: Run GREEN:** focused browser command above, then \`npm.cmd test\`.
- [ ] **Step 9: Commit:**
~~~powershell
git add public/viewer-state.js public/index.html public/app.js test/server.test.js
git commit -m "feat: add cinematic web discovery shelves"
~~~

### Task 4: Web playback persistence and player modes

**Files:**
- Modify: \`public/app.js\`
- Modify: \`public/index.html\`
- Modify: \`test/server.test.js\`

**Interfaces:**
- \`savePlaybackProgress(reason)\` batches progress operations at a bounded cadence.
- \`restorePlaybackProgress(movieId)\` seeks once after \`loadedmetadata\`.
- \`setPlayerMode(mode)\` supports \`normal\`, \`theater\), and \`miniplayer\`.
- \`playNextFromQueue()\` selects the next valid queue/shelf item.

- [ ] **Step 1: Write failing playback tests.** Cover exactly-once resume, throttled writes, pause/pagehide/ended/movie-switch flushes, completion, autoplay/up-next, keyboard input filtering, and player-mode transitions.
- [ ] **Step 2: Run RED:** \`node --test test/server.test.js --test-name-pattern="resume|progress|keyboard|theater|miniplayer|queue|autoplay"\`.
- [ ] **Step 3: Implement progress persistence.** Load state after auth/profile switch; flush every 15 seconds and all lifecycle events; keep temporary-link recovery state separate.
- [ ] **Step 4: Implement completion behavior.** Mark at 90% or ended, remove from Continue Watching, show Replay, and support Restart/Mark unwatched.
- [ ] **Step 5: Implement queue/up-next/autoplay.** Add reorder/remove/clear, Play Next/Last, a cancelable countdown, and the \`autoplayNext\` setting.
- [ ] **Step 6: Add modes and controls.** Add Theater, Miniplayer, keyboard shortcuts, watched/buffered/unwatched timeline layers, chapter hooks, captions/audio/speed/quality settings where available, and mobile tap/double-tap behavior without breaking native controls or AirPlay/Cast.
- [ ] **Step 7: Run GREEN:** focused playback command above, then \`npm.cmd test\`.
- [ ] **Step 8: Commit:**
~~~powershell
git add public/index.html public/app.js test/server.test.js
git commit -m "feat: add synchronized resume and player modes"
~~~

### Task 5: Fire TV synchronized viewer

**Files:**
- Create: \`firetv/src/main/java/com/movieroom/firetv/ViewerState.java\`
- Create: \`firetv/src/main/java/com/movieroom/firetv/PlaybackProgressStore.java\`
- Create: \`firetv/src/main/java/com/movieroom/firetv/TvFocusCoordinator.java\`
- Modify: \`firetv/src/main/java/com/movieroom/firetv/MainActivity.java\`
- Modify: \`firetv/src/main/java/com/movieroom/firetv/MovieRoomApi.java\`
- Modify: \`firetv/src/main/java/com/movieroom/firetv/MovieRoomModels.java\`
- Create: \`firetv/src/test/java/com/movieroom/firetv/ViewerStateTest.java\`
- Create: \`firetv/src/test/java/com/movieroom/firetv/PlaybackProgressStoreTest.java\`
- Modify: \`firetv/src/test/java/com/movieroom/firetv/MovieRoomModelsTest.java\`

**Interfaces:**
- \`MovieRoomApi.getViewerState(deviceToken)\` and \`applyViewerOperations(deviceToken, operations)\`.
- \`ViewerState\` is a pure Java model for progress, flags, queue, and settings.
- \`PlaybackProgressStore\` caches unsent checkpoints and last focus only.
- \`TvFocusCoordinator.restore(movieId)\` and \`move(direction)\` provide deterministic D-pad focus.

- [ ] **Step 1: Write failing Java tests.** Cover parsing, progress/completion, queue, bounded values, local checkpoint flush, and focus restore.
- [ ] **Step 2: Run RED:** \`./gradlew.bat :firetv:testDebugUnitTest --no-daemon\` with Android Studio JBR and installed SDK variables set.
- [ ] **Step 3: Implement pure helpers.** Keep credentials in encrypted \`DeviceTokenStore\`; do not put viewer history in token storage.
- [ ] **Step 4: Add API methods and models.** Parse folders/state and honor the server-bound profile.
- [ ] **Step 5: Replace the flat grid.** Use recycled horizontal shelves for Continue Watching, Recently Added, folder/category rows, and All Movies; add hero, details, queue, large focus, Back, and focus restoration.
- [ ] **Step 6: Persist TV playback.** Restore once, checkpoint ExoPlayer listeners, flush on pause/end/Back/lifecycle, mark completion, and show retry states for expired tickets/codecs/network.
- [ ] **Step 7: Run GREEN/build:** \`./gradlew.bat :firetv:testDebugUnitTest --no-daemon\`; then \`./gradlew.bat :firetv:assembleDebug --no-daemon\`.
- [ ] **Step 8: Commit:**
~~~powershell
git add firetv/build.gradle firetv/src/main/java firetv/src/test/java
git commit -m "feat: add synchronized Fire TV viewer experience"
~~~

### Task 6: Cross-surface hardening

**Files:**
- Modify: \`public/index.html\`
- Modify: \`public/app.js\`
- Modify: \`firetv/src/main/java/com/movieroom/firetv/MainActivity.java\`
- Modify: \`test/server.test.js\`
- Modify: Android tests from Task 5

- [ ] **Step 1: Add visible browser states.** Test visible pre-player library errors, useful empty states, expired-session sign-in, and Retry/Home playback errors without raw server text.
- [ ] **Step 2: Add accessibility/responsive behavior.** Verify focus order, dialog labels, aria-live status, Escape/Back, reduced motion, touch targets, safe-area nav, rail keyboard scrolling, and no nested interactive elements.
- [ ] **Step 3: Harden Fire TV lifecycle/media.** Add a \`Player.Listener\` error surface, lifecycle persistence, screen-on behavior, density-safe dimensions, and explicit D-pad mappings; remove unused alpha dependencies.
- [ ] **Step 4: Run all suites:** \`npm.cmd test\`; \`./gradlew.bat :firetv:testDebugUnitTest --no-daemon\`; \`./gradlew.bat :firetv:assembleDebug --no-daemon\`.
- [ ] **Step 5: Commit:**
~~~powershell
git add public/index.html public/app.js firetv/src/main/java firetv/src/test/java test/server.test.js
git commit -m "fix: harden Movie Room viewer states and TV controls"
~~~

### Task 7: Visual QA, deployment, GitHub, and USB handoff

**Files/artifacts:**
- Inspect accepted concept images listed in the design spec.
- Generate temporary desktop/mobile/Fire TV screenshots and remove scratch QA files afterward.
- Build \`firetv/build/outputs/apk/debug/firetv-debug.apk\`.
- Copy only after verification to \`D:\\MovieRoom-FireTV-0.4.0.apk\` and \`D:\\MovieRoom-FireTV-latest.apk\`.

- [ ] **Step 1: Start the local app with temporary injected test settings.** Never write credentials into tracked files.
- [ ] **Step 2: Use Browser/IAB first.** Verify auth, hero Play/Details, shelves, state actions, resume, player modes, keyboard/mobile controls, and expiry/error states at desktop/mobile sizes.
- [ ] **Step 3: Capture screenshots and inspect with \`view_image\`.** Compare hero fade, palette/type, rails/cards, focus states, mobile nav, and player modes against the accepted concepts; repair material drift.
- [ ] **Step 4: Verify APK metadata and production URL.** Confirm version 0.4.0, QR pairing path, base URL, and no new write to the Mac copy.
- [ ] **Step 5: Run fresh verification:**
~~~powershell
npm.cmd test
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME='C:\Users\kylet\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
.\gradlew.bat :firetv:testDebugUnitTest --no-daemon
.\gradlew.bat :firetv:assembleDebug --no-daemon
~~~
Read full output and exit codes before any completion claim.
- [ ] **Step 6: Deploy:** \`vercel.cmd deploy --prod --yes --scope taylormade02471-1195s-projects\`; verify production HTTP 200, \`/api/session\`, and deployed \`/app.js\` markers.
- [ ] **Step 7: Copy APK only to the mounted \`MOVIEROOM\` USB.** Confirm removable-volume identity, copy both filenames, and compare SHA-256. If absent, stop without changing another drive.
- [ ] **Step 8: Push source.** Stage only intended source/docs, push the current branch, and verify \`git ls-remote\`; leave unrelated \`.vercel/\` or generated \`package-lock.json\` untracked.
- [ ] **Step 9: Commit release handoff:**
~~~powershell
git add docs/superpowers/specs docs/superpowers/plans public lib server.js api firetv test README.md .env.example
git commit -m "release: ship synchronized Movie Room viewer experience"
~~~

## Self-review checklist

- Spec coverage: Tasks 1–2 cover synchronized state, durability, CAS, security, and APIs; Tasks 3–4 cover web hero/shelves/details/player/state; Task 5 covers Fire TV shelves/details/focus/progress; Task 6 covers error/accessibility/compatibility; Task 7 covers visual, functional, deployment, GitHub, and USB verification.
- Placeholder scan: the plan contains no unfinished markers or vague steps.
- Interface consistency: \`createViewerStateManager\`, \`viewerStateClient\`, TV API methods, \`ViewerState\`, \`PlaybackProgressStore\`, and \`TvFocusCoordinator\` are defined before downstream tasks consume them.
- Review focus coverage: each risk is owned by a named test step in Tasks 1–6.
- Operational safety: the plan prevents new APK writes to the Mac copy and prevents USB formatting during implementation.
- Intentional deviations: rich metadata, hover previews, Studio, collections, and transcoding are explicitly deferred rather than silently omitted.
