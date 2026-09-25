# Taylor-Made Movies Viewer Experience Design

**Date:** 2026-09-24  
**Status:** Approved visual direction; awaiting written-spec review before implementation planning  
**Scope:** First synchronized viewer release for web, mobile web, and paired Fire TV

## Goal

Turn Movie Room from a secure movie-file browser into a calm, cinematic private streaming platform that remembers what each viewer watched, where they stopped, and what they saved across the web, phone, and paired Fire TV.

This release covers the viewer experience. Taylor-Made Studio, metadata editing, automated artwork, deep recommendations, and large-scale collection management remain later releases built on the same state and library contracts.

## Product understanding

The user wants a personal/family streaming experience with YouTube-like discoverability and controls, but with Taylor-Made Movies personality rather than a YouTube clone. The user has explicitly requested:

- A featured hero movie with cinematic artwork, metadata, description, Play/Resume, Watch Later, and More Info actions.
- Horizontal shelves rather than a single flat grid.
- Continue Watching with real saved progress and resume behavior.
- Favorites, Watch Later, queue/up-next, history, and profile-aware state.
- Details before playback, with absent metadata hidden rather than shown empty.
- A polished player with seeking, buffering, theater mode, miniplayer, fullscreen, keyboard controls, and optional autoplay.
- Mobile-specific navigation and touch-friendly controls.
- Fire TV shelves, D-pad focus behavior, details, resume, queue/up-next, and persistent pairing.
- Existing secure password authentication, OneDrive playback, multiple viewers, Cast/AirPlay, QR pairing, wake-lock, and seeking must continue working.
- The Mac copy remains separate from the Fire TV APK. Future APK releases go to the `MOVIEROOM` USB only.

### Success criteria

1. After sign-in, the first viewport feels like a streaming home screen instead of a file list.
2. Selecting a title opens details; Play/Resume is an intentional action rather than an accidental card click.
3. Pausing, leaving, or closing a player preserves progress; returning from another device resumes at the stored position.
4. Favorites, Watch Later, queue, history, and settings are profile-scoped and synchronized through the existing durable Vercel store.
5. A paired Fire TV can use the same profile state without receiving a browser session cookie, password, or OneDrive secret.
6. Existing streaming and authentication tests remain green, and web/Android visual and interaction checks cover the new states.

## Release boundaries

### Included in this release

- Dynamic featured hero chosen deterministically from the available library.
- Horizontal content rails: Continue Watching, Recently Added, Taylor-Made Picks, Favorites, Watch Later, folder/category rails, and Movies A-Z.
- Per-profile viewer state synchronized by the server.
- Details dialog/page with available title, poster, folder, size/readiness, and any future metadata fields that are actually present.
- Resume and completion state, history derived from watch records, and explicit restart/mark-unwatched actions.
- Watch Later, Favorites, queue operations, queue drawer, Up Next, and optional autoplay.
- Web player theater mode, miniplayer, fullscreen, keyboard shortcuts, seek controls, buffer visualization, and progress flushes.
- Mobile bottom navigation, swipeable rails, safe-area spacing, and touch-friendly player actions.
- Fire TV featured hero, horizontal shelves, details step, D-pad focus restoration, progress/queue persistence, and Up Next.
- Loading skeletons, actionable empty states, session-expiry state, playback-error retry, and no-raw-error user messaging.

### Deferred intentionally

- Taylor-Made Studio/admin dashboard and metadata editor.
- Automated external metadata/artwork scraping and hover video preview generation.
- Rich cast/director/rating/year/genre data until a trustworthy metadata source is selected.
- Custom collections and user-created lists beyond the first-release queue.
- Cross-account privacy boundaries; Home, Family, and Guest remain organizational profiles under one shared password.
- Transcoding or codec conversion. MP4/H.264/AAC remains the safe Fire TV playback baseline.

## Visual design system

The accepted concepts are:

- Desktop: `C:\Users\kylet\.codex\generated_images\01a0d257-d5c5-7d02-948d-fee3efa8228b\exec-d1c1d86e-077c-4dae-ad8a-4c2b860e4aea.png`
- Mobile: `C:\Users\kylet\.codex\generated_images\01a0d257-d5c5-7d02-948d-fee3efa8228b\exec-8b6d083a-d3fd-4bec-ab15-ed10fc1bde9e.png`
- Fire TV: `C:\Users\kylet\.codex\generated_images\01a0d257-d5c5-7d02-948d-fee3efa8228b\exec-6a5183e6-cf3c-43db-bef5-1a6e4d8d44e8.png`

### Tokens

```text
background: #080808
surface-1: #111111
surface-2: #181818
gold: #D4AF37
gold-highlight: #F2CF63
text-primary: #FFFFFF
text-secondary: #AAAAAA
danger: #E53935
success: #74D99A
focus-ring: #F2CF63
radius-small: 8px
radius-medium: 12px
radius-large: 16px
motion-fast: 140ms
motion-standard: 220ms
motion-drawer: 280ms
```

Use the existing vanilla HTML/CSS/JavaScript architecture. Do not migrate to React or add a bundler for this release; the current Vercel static/API deployment is already working and must remain easy to deploy to the user's existing project.

### Desktop composition

- Sticky top bar: Taylor-Made Movies wordmark, Home/Movies navigation, search, profile, queue/saved controls, and logout.
- Full-width hero with natural edge fade into black. UI copy remains HTML, not baked into artwork.
- Rails use horizontal overflow with scroll-snap, visible keyboard focus, left/right controls, and no giant hover zoom.
- Cards use stable image ratios, gold focus borders, muted metadata, progress bars, and a compact action menu.
- Details open in a dialog or route-like full-screen layer over the same shell; the player is not forced open by browsing.

### Mobile composition

- Compact top bar with TM Movies wordmark, search, and profile.
- Hero copy is reduced to the title, essential metadata, description, and Play/More Info/Watch Later actions.
- Rails are swipeable and retain large touch targets.
- Fixed bottom navigation: Home, Search, Saved, History, Library.
- Player supports double-tap seek, tap-to-reveal controls, swipe-down minimization where supported, safe-area padding, and full-screen fallback.

### Fire TV composition

- Overscan-safe margins and large text.
- Hero plus horizontal shelves; no dense desktop grid.
- D-pad up/down moves between rails; left/right moves within a rail; center opens details or activates the focused action; Back returns to the previous layer.
- Focused cards receive a gold outline, restrained scale increase, and shadow. Focus is restored to the last card when returning from details or playback.
- Player relies on Media3 controls but adds explicit retry, progress, queue, and Back behavior.

## Viewer-state architecture

Use one server-authoritative, versioned JSON snapshot per fixed profile:

`viewer-state:v1:<profileId>`

The browser and Fire TV send operations rather than replacing whole documents. The manager applies operations with bounded validation and an atomic compare-and-set retry so simultaneous viewers do not silently overwrite one another.

### Canonical state

```json
{
  "schemaVersion": 1,
  "profileId": "family",
  "revision": 12,
  "updatedAt": 1790270000000,
  "settings": {
    "autoplayNext": false,
    "resumeEnabled": true,
    "hideCompleted": false
  },
  "movies": {
    "provider-movie-id": {
      "positionSeconds": 842.5,
      "durationSeconds": 7100,
      "lastWatchedAt": 1790270000000,
      "completedAt": null,
      "favorite": true,
      "watchLater": false
    }
  },
  "queue": ["provider-movie-id", "another-movie-id"]
}
```

History and Continue Watching are derived from movie records. Continue Watching includes meaningful progress that is not completed; history sorts by `lastWatchedAt`; completed titles show Replay rather than Resume. A normal late progress update must not clear an explicit completion state.

### Operations

The state manager accepts a bounded array containing:

- `progress`: finite movie ID, position, duration, and playback status.
- `setCompleted`: explicit completed/uncompleted transition.
- `setFlag`: `favorite` or `watchLater` boolean.
- `queueAdd`, `queueRemove`, and `queueMove`.
- `settings`: only whitelisted playback/appearance/library/privacy keys.

Validate profile IDs against `home`, `family`, and `guest`; reject dangerous object keys, invalid numbers, unknown operation types, oversized queues, oversized snapshots, and excessive operation counts. Orphaned movie records remain until a successful library reconciliation; provider failure must never prune state.

### Synchronization cadence

- Browser sends progress approximately every 15 seconds while playing.
- Browser flushes on pause, ended, movie switch, `visibilitychange`, `pagehide`, logout, and session expiry.
- Fire TV checkpoints from ExoPlayer listeners and activity/player lifecycle callbacks.
- Mutations are authenticated by browser session or paired-device token and return the updated revision/snapshot.

### Storage and security

- Extend the existing store with atomic compare-and-set; MemoryStore must serialize it for tests and Upstash must use one Redis `EVAL` operation.
- Vercel viewer-state routes fail closed with `503` when durable storage is unavailable.
- State never contains passwords, session IDs, device secrets, playback tickets, OneDrive tokens, or raw cookies.
- Browser mutations require same-origin checks. Fire TV mutations derive the profile from the stored device record and never accept a profile override.
- Pairing approval includes the selected profile. Because all profiles share one password, profile separation is organizational rather than a security boundary.
- Keep private/no-store response headers on state endpoints.

## API surface

Browser, session-authenticated:

- `GET /api/viewer-state?profileId=<home|family|guest>`
- `PATCH /api/viewer-state`

Fire TV, device-token-authenticated:

- `GET /api/tv/viewer-state`
- `PATCH /api/tv/viewer-state`

Example mutation:

```json
{
  "profileId": "family",
  "operations": [
    {
      "type": "progress",
      "movieId": "movie-1",
      "positionSeconds": 842.5,
      "durationSeconds": 7100,
      "playbackStatus": "paused"
    },
    { "type": "setFlag", "movieId": "movie-1", "flag": "favorite", "value": true },
    { "type": "queueAdd", "movieId": "movie-2" }
  ]
}
```

## Web component/data boundaries

Keep `public/app.js` as composition glue and extract focused helpers where possible:

- `viewer-state.js` or an equivalent module for normalization, persistence, operation batching, and derived shelves.
- `MovieCard` construction that can render the main catalog and every rail without nested interactive buttons.
- `HeroBanner` behavior for featured selection, Play/Resume, Details, and Watch Later.
- `DetailsDialog` with safe conditional metadata rendering.
- `Shelf` rendering with keyboard and touch behavior.
- `PlayerState` for resume restore, progress flushes, player modes, queue/up-next, and keyboard shortcuts.

The existing auth, playback-link refresh, Cast/AirPlay, Fire TV pairing, wake-lock, and stall-recovery helpers remain the integration points rather than being replaced.

## Fire TV component/data boundaries

Keep device-token encryption and API ticketing unchanged. Add focused units rather than expanding `MainActivity` indefinitely:

- `ViewerState`/progress helper with pure Java normalization and queue operations.
- `PlaybackProgressStore` for local unsent checkpoints and last-focus fallback.
- Shelf/card presenters or adapters using recycled horizontal rows.
- Details and player layers with explicit Back and focus restoration.
- `MovieRoomModels` parsing for folders and viewer-state responses.
- `MovieRoomApi` GET/PATCH methods for TV viewer state.

Avoid the current non-virtualized all-movie `ScrollView`/`GridLayout` for the new home surface; use horizontal recycled rows so a larger library does not create focus and memory problems.

## Testing and verification

### Server tests

Add tests for:

- Empty/default state and profile isolation.
- Progress, completion, derived Continue Watching/history, favorites, Watch Later, queue order, and settings.
- Invalid profile/movie/operation/numeric limits and dangerous keys.
- Same-origin browser enforcement and unauthenticated rejection.
- Browser mutation visible to paired TV and TV mutation visible to browser.
- Pairing profile binding and rejection of TV profile overrides.
- CAS conflict/retry and idempotent operations.
- Durable-store failure returning `503`.
- Bounded snapshot/queue behavior and safe library reconciliation.

Retain all existing authentication, playback-ticket, concurrent-viewer, range-seeking, OneDrive, Cast, AirPlay, pairing, token renewal, and Safari-compatibility tests.

### Browser tests

Test profile switching, resume restore exactly once, progress throttling and flush events, completed-title behavior, stale/corrupt local cache, details-versus-play activation, shelf membership/order, keyboard shortcuts, theater/miniplayer/fullscreen interactions, mobile bottom navigation, visible pre-player errors, and disabled local storage.

### Android tests

Add model/progress/queue tests, then Robolectric or instrumentation coverage for hero → shelf → details → player, D-pad focus movement, Back restoration, progress checkpointing, completion/up-next, retry UI, and lifecycle persistence. Run the existing Android unit suite and a debug APK build before USB replacement.

### Visual verification

Use Browser/IAB first. Check desktop, mobile-sized, and Fire TV-sized viewports. Capture the implementation at the closest practical size to the accepted concepts, inspect screenshots with `view_image`, and record a fidelity ledger covering at least:

1. Hero composition and edge fade.
2. Gold/black palette and typography scale.
3. Rail/card anatomy and progress bars.
4. Focus/hover/selected states.
5. Mobile bottom navigation and Fire TV overscan/focus behavior.
6. Player mode controls and visible state transitions.

Do not claim completion from tests alone; the rendered workflow must be inspected.

## Operational constraints

- Do not copy new APKs into the OneDrive Mac copy.
- Do not reformat the `MOVIEROOM` USB again unless explicitly requested; copy new APKs there after verified builds.
- Do not place credentials, passwords, session secrets, refresh tokens, or device tokens in source, screenshots, docs, GitHub, or chat.
- Do not publish or expose a movie catalog when durable auth/state storage is unavailable.
- Keep MP4/H.264/AAC compatibility guidance visible for Fire TV users.
