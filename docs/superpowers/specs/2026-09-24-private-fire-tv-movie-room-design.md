# Private Fire TV Movie Room Design

## Purpose

Build a simple private Fire TV app for Movie Room so the user's Insignia Fire TV / Fire Stick can browse the existing OneDrive-backed movie library and play movies directly on the TV. The first version is for private sideloading only, not Amazon Appstore publishing.

The app must make watching from the couch easier than casting from a phone. The phone and iPhone path can remain as-is; Fire TV gets its own TV-first remote-control experience.

## Goals

- Show a pairing code on the Fire TV app.
- Let an already signed-in Movie Room web user approve that pairing code.
- Let the Fire TV list folders and movies from the existing Movie Room backend.
- Let the Fire TV request a short-lived playback URL and play the selected movie directly.
- Avoid storing the shared password, session cookie, OneDrive refresh token, client secret, or Vercel secrets in the APK.
- Support private sideloading to Fire TV devices such as the Insignia NS-65F301NA23.
- Keep the first version intentionally small: pair, browse, play, pause, seek, and recover clear errors.

## Non-Goals

- No Amazon Appstore submission in the first version.
- No Vizio native app in the first version.
- No phone-to-TV casting dependency for Fire TV playback.
- No live transcoding server. The first version plays files the Fire TV can decode from the provided stream URL.
- No in-app OneDrive OAuth login on the TV.
- No TV entry of the shared Movie Room password.

## Existing System

Movie Room currently has:

- A password-protected web UI in `public/`.
- A Node server in `server.js`.
- Local and OneDrive providers under `lib/providers/`.
- Durable KV storage through `lib/store.js`.
- Short-lived Cast playback tickets at `/api/cast/playback` and `/api/cast/stream`.
- Vercel API entrypoints under `api/`, including explicit nested Cast routes for Vercel.

The Fire TV design should reuse the provider abstraction and the existing Cast ticket idea. That keeps TV playback cookie-free while still requiring a trusted approval step before a TV can list or play movies.

## Recommended Architecture

Use a small native Android Fire TV app plus a few backend TV endpoints.

### Backend

Add a TV device layer to `server.js`:

- `POST /api/tv/pairings`
  - Called by the unpaired TV app.
  - Creates a short-lived pairing request and returns a human-readable code.
  - Does not require a browser session.

- `GET /api/tv/pairings/:pairingId`
  - Called by the TV app while it waits.
  - Requires the TV's polling secret.
  - Returns pending, expired, rejected, or approved.
  - On approved, returns a one-time device credential.

- `POST /api/tv/pairings/approve`
  - Called by the web UI.
  - Requires the normal Movie Room signed-in browser session and same-origin checks.
  - Approves a valid pairing code.
  - Records the TV device as trusted.

- `GET /api/tv/library`
  - Called by the paired TV app.
  - Requires `Authorization: Bearer <device token>`.
  - Returns the same normalized library shape as `/api/library`.

- `POST /api/tv/playback`
  - Called by the paired TV app.
  - Requires `Authorization: Bearer <device token>`.
  - Accepts `{ "movieId": "..." }`.
  - Returns a short-lived playback URL, title, content type, and expiration.
  - Uses the same movie validation and ticket logic as Cast.

Add explicit Vercel function files for nested TV routes so Vercel does not miss them:

- `api/tv/pairings.js`
- `api/tv/pairings/[...path].js`
- `api/tv/library.js`
- `api/tv/playback.js`

### Web UI

Add a small pairing control to the existing Movie Room web UI:

- A "Pair Fire TV" button available only after login.
- A simple code entry form.
- Approval result messages: approved, expired, already used, invalid code.
- Plain language explaining that the TV gets access to the movie library but not the shared password or OneDrive secrets.

The web UI does not need a full device management screen in version one, but the backend record format must include `revokedAt` so a revocation screen can be added without changing the token format.

### Fire TV App

Create `firetv/` as a separate native Android project for Fire TV.

The first version should use:

- Java Android code to avoid adding a Kotlin toolchain requirement to the first private build.
- AndroidX Media3 ExoPlayer for playback.
- A simple remote-friendly UI with large focusable rows.
- Android secure local storage for the device token.
- A configurable production base URL defaulting to `https://movie-downloads-six.vercel.app`.

App screens:

- Pairing screen:
  - Shows a short code.
  - Polls until approved or expired.
  - Shows clear instructions: "Open Movie Room on your Mac, sign in, choose Pair Fire TV, and enter this code."

- Library screen:
  - Shows folders and movies.
  - Uses TV remote directional navigation.
  - Shows "still uploading" items but does not play them.

- Player screen:
  - Plays the selected movie.
  - Supports play, pause, seek, back to library, and error messages.
  - Requests a fresh playback link when the user starts a movie.

## Pairing and Security

Pairing must avoid putting account secrets on the TV.

Proposed pairing flow:

1. TV generates a random polling secret locally.
2. TV calls `POST /api/tv/pairings` with a device label and a hash of that polling secret.
3. Server stores a pairing record in KV for 10 minutes.
4. Server returns `{ pairingId, code, expiresAt }`.
5. TV displays `code` and polls `GET /api/tv/pairings/:pairingId` with the raw polling secret in an authorization header.
6. User opens Movie Room in the browser, signs in, opens Pair Fire TV, and enters the code.
7. Browser calls `POST /api/tv/pairings/approve`.
8. Server creates a device credential and stores only a hash of it in KV.
9. TV's next poll receives the device credential one time.
10. TV stores the credential in secure local app storage and uses it as a bearer token for TV endpoints.

Credential rules:

- Pairing codes expire after 10 minutes.
- Pairing codes are one-use.
- Device tokens expire after 30 days in version one.
- Server stores token hashes, not raw device tokens.
- TV endpoints return `401` for missing, expired, revoked, or malformed tokens.
- Playback URLs remain short-lived and movie-scoped.
- The TV never receives Movie Room cookies, shared password, OneDrive refresh token, session secret, or Microsoft client secret.

## Playback

The Fire TV app should play the server-provided playback URL directly.

For OneDrive:

- `/api/tv/playback` returns a Movie Room playback ticket URL.
- The TV calls the ticket URL.
- The ticket endpoint resolves a fresh OneDrive HTTPS playback URL and redirects the TV.
- The ticket is short-lived and can be requested again from the TV app if playback needs a fresh URL.

For local development:

- The same TV playback response can point at a local stream URL or the existing ticket stream route.
- Range requests must keep working for seeking and buffering.

Codec expectations:

- MP4 with H.264 video and AAC audio is the safe target.
- MKV or unsupported codecs may fail on Fire TV depending on the file.
- Version one should show a useful unsupported-format message rather than trying to transcode.

## Data Model

KV records:

- `tv-pairing:<pairingId>`
  - `codeHash`
  - `pollSecretHash`
  - `deviceLabel`
  - `status`
  - `createdAt`
  - `expiresAt`
  - `approvedAt`
  - `approvedBy`
  - `deviceId`
  - `oneTimeDeviceToken`

- `tv-code:<normalizedCode>`
  - `pairingId`
  - Same 10 minute TTL as the pairing record.

- `tv-device:<deviceId>`
  - `tokenHash`
  - `deviceLabel`
  - `createdAt`
  - `expiresAt`
  - `revokedAt`

The long-lived raw TV device token must never be stored in `tv-device:<deviceId>`. The pairing record may store a one-time raw delivery token only until the first successful approved poll or until the 10 minute pairing TTL expires, whichever comes first.

## Error Handling

Backend errors should be explicit and stable:

- `400`: malformed code, malformed body, missing movie id.
- `401`: missing or invalid TV device token.
- `403`: browser approval attempted without signed-in session or wrong origin.
- `404`: movie not found or pairing not found.
- `409`: movie is still uploading, code already used, or pairing already resolved.
- `410`: pairing expired.
- `415`: unsupported movie extension.

Fire TV app messages:

- "Code expired. Generate a new code."
- "This TV was not approved yet."
- "Movie is still uploading."
- "This video format is not supported by this Fire TV."
- "Network problem. Try again."
- "Sign in on the Movie Room website and approve this TV."

## Testing Strategy

Backend tests in `test/server.test.js`:

- Creating a pairing returns a code and hides secrets.
- Pairing expires after 10 minutes.
- Browser approval requires an authenticated session and same-origin request.
- Wrong or expired code cannot be approved.
- TV poll requires the polling secret.
- Approved poll returns a device credential once.
- Device token can load `/api/tv/library`.
- Device token can request `/api/tv/playback`.
- Revoked or expired device token is rejected.
- TV playback does not require the browser session cookie.
- OneDrive TV playback returns a secure HTTPS redirect through the existing ticket path.

Fire TV app tests:

- Pairing state parser handles pending, approved, expired, and error states.
- Library parser renders folders, playable movies, and still-uploading items.
- Playback view uses the returned stream URL and title.
- Token storage reads, writes, and clears the device token.

Manual verification:

- Run the web app locally and confirm pairing approval flow.
- Build a debug APK.
- Install the APK on a Fire TV device over ADB.
- Pair the TV from the web UI.
- Play at least one MP4 H.264/AAC movie.
- Confirm unsupported or not-yet-uploaded files fail cleanly.

## Deployment and Private Install

The backend deploys to the existing Vercel project.

The APK is handed off as a local build artifact, for example:

- `firetv/app/build/outputs/apk/debug/app-debug.apk`

Private Fire TV installation will require the user to enable developer options on the Fire TV and allow ADB installation. That device-side setup is outside Git and cannot be fully automated without the TV being reachable and the user approving the connection on the TV.

## Risks and Constraints

- Fire TV codec support depends on the actual file encoding.
- Fire TV network performance depends on home Wi-Fi and OneDrive delivery speed.
- A native app requires Android build tooling; Android Studio/SDK exists on this Windows machine, but exact CLI paths should be verified during implementation.
- Vercel nested API routes must be explicit, based on the previous Cast route issue.
- Durable KV is required in Vercel for pairing and device tokens.

## Acceptance Criteria

- A production backend can issue and approve Fire TV pair codes.
- A paired Fire TV can list the same Movie Room library as the web app.
- A paired Fire TV can start playback without a browser cookie.
- Browser sessions and OneDrive secrets are never stored in the TV app.
- Tests cover the pairing, token, library, and playback contracts.
- A debug APK can be built for private Fire TV sideloading.
- The README explains how to build and install the private Fire TV APK.
