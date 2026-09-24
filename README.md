# Movie-Downloads

A lightweight browser app for browsing and streaming a shared movie library behind one shared password.

## What changed

- Password-protected catalog access with signed HttpOnly sessions
- Recursive movie discovery for local files and OneDrive-backed libraries
- Server-issued playback links so the browser can stream directly from the configured provider
- Google Cast device selection on Android and desktop Chrome using Google Home device names
- Opaque, time-limited Cast playback tickets so TVs never receive the browser session cookie
- Safari AirPlay support remains available for iPhone and iPad
- YouTube-style responsive thumbnails, compact cleaned titles, and local Home, Family, and Guest viewer profiles
- OneDrive video thumbnails use Microsoft Graph's generated frame when a downloaded title poster is unavailable, so every uploaded movie can still be recognized
- A prominent Full Screen action that disappears after the video enters full-screen mode
- Fire TV playback sets the Android keep-screen-on flag until you return to the library, preventing the TV screensaver during a movie
- Vercel-compatible request handling with durable KV-backed sessions, throttling, and token persistence

## Supported providers

### Local provider

Use this for local development with sample files in `movies/`.

```bash
MOVIE_PROVIDER=local
MOVIE_PASSWORD=yourpassword
SESSION_SECRET=replace-with-a-long-random-secret
npm start
```

Supported movie files are discovered recursively inside `movies/`.

### OneDrive provider

Use this for Vercel hosting after you have:

1. A Microsoft app registration with delegated read access for the target OneDrive account
2. A refresh token for that app/account
3. The target `driveId` and root folder `itemId`
4. Vercel Marketplace Upstash Redis credentials so sessions, login throttling, and rotated refresh tokens persist across Vercel function instances

Copy `.env.example` to a local `.env` file or configure the same values in Vercel:

- `MOVIE_PROVIDER`
- `APP_ORIGIN`
- `TRUST_PROXY`
- `MOVIE_PASSWORD`
- `SESSION_SECRET`
- `SESSION_TTL_MS`
- `CAST_PLAYBACK_TTL_MS` (optional; defaults to six hours and is capped by the signed-in session)
- `AUTH_RATE_LIMIT_WINDOW_MS`
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS`
- `ONEDRIVE_CLIENT_ID`
- `ONEDRIVE_CLIENT_SECRET`
- `ONEDRIVE_PUBLIC_CLIENT`
- `ONEDRIVE_REDIRECT_URI`
- `ONEDRIVE_REFRESH_TOKEN`
- `ONEDRIVE_DRIVE_ID`
- `ONEDRIVE_ROOT_ITEM_ID`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

Set `ONEDRIVE_PUBLIC_CLIENT=true` only when your Microsoft app registration is configured as a public client and does not require a client secret for refresh-token exchange. `ONEDRIVE_REDIRECT_URI` is used to match the Microsoft app registration during refresh-token exchange; this app does not implement an in-repo OAuth callback flow yet.

The app never exposes the shared password, session secret, or OneDrive credentials to the browser.
The first-run permissions button does not open a broad Bluetooth chooser. Google Cast and AirPlay discover TVs over the local Wi-Fi network. Cast playback tickets are stored in the configured durable KV store and contain no movie name or login cookie.

## Private Fire TV app

The private Fire TV app lives in `firetv/`. It is for sideloading onto the owner's Fire TV devices and is not an Amazon Appstore submission. Its launcher banner is the black-and-gold `TaylorMade Movies` cover artwork.

Build a debug APK:

```powershell
.\gradlew.bat :firetv:assembleDebug
```

The APK is created under `firetv/build/outputs/apk/debug/`.

The TV stores its approved device token in encrypted private app storage, so normal app restarts and Fire TV reboots do not require another password or pairing code. The server accepts that device registration for up to one year. Choosing Unpair, clearing app data, uninstalling the app, or letting the registration expire requires pairing again.

Pairing flow:

1. Open the Fire TV app.
2. Keep the pairing code visible on the TV.
3. Open Movie Room in the browser and sign in.
4. Choose Pair Fire TV.
5. Enter the code shown on the TV.
6. Return to the Fire TV app and choose a movie.

Private install requires Fire TV developer options and ADB approval on the TV. Do not put Movie Room passwords, OneDrive secrets, or Vercel secrets into the APK.

To install or update the APK over the same Wi-Fi network, enable ADB debugging on the Fire TV, find its IP address under Network settings, approve the TV's ADB prompt, and run:

```powershell
.\scripts\install-firetv.ps1 -DeviceIp 192.168.1.50
```

This sideloads the private app; it does not replace or "flash" Fire OS firmware. The same APK can be installed on another Fire Stick by running the command with that device's IP address and pairing that installation once.

## Getting started

Use Node.js 22.9 or newer. `npm start` loads a local `.env` file when one exists and otherwise uses the current process environment.

1. Put movie files such as `.mp4`, `.m4v`, `.mov`, `.webm`, `.ogg`, or `.mkv` into the project’s `movies/` folder for local development.
2. Configure the required environment variables.
3. Start the app:

   ```bash
   npm start
   ```

4. Open `http://localhost:3000`

## Vercel deployment

- Vercel serves the static UI from `public/`
- The catch-all Node handler lives at `api/[...path].js`
- No custom `vercel.json` routing is required for this layout: static assets stay at the site root and API requests go through `/api/*`
- Set `APP_ORIGIN` to the exact deployed site origin for CSRF checks
- `TRUST_PROXY=true` is an optional override for non-Vercel trusted-proxy deployments; Vercel is auto-detected
- Configure both `KV_REST_API_URL` and `KV_REST_API_TOKEN`; Vercel Marketplace Upstash supplies them automatically. Standalone Upstash `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` aliases also remain supported. Vercel authentication fails closed without durable shared storage
- Protected API responses use `Cache-Control: private, no-store`
- For production, configure the environment variables in Vercel before testing

## Commands

- `npm start` — start the app locally
- `npm test` — run the test suite

The `npm run posters -- --site` command downloads artwork for titles currently listed by the live site when `APP_ORIGIN` and `MOVIE_PASSWORD` are available in the environment.

## Remaining owner setup

This repository now includes the app-side OneDrive integration points, but the deployment still needs private setup values that are intentionally not stored in Git:

- The real shared password in `MOVIE_PASSWORD`
- A randomly generated `SESSION_SECRET` of at least 32 UTF-8 bytes
- A Microsoft app registration and refresh token
- The correct `ONEDRIVE_DRIVE_ID` and `ONEDRIVE_ROOT_ITEM_ID`
- Vercel Marketplace Upstash Redis REST credentials for required Vercel session/throttle/token storage

If those values are missing, protected routes fail closed instead of allowing anonymous access.
