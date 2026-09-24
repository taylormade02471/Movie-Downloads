# Movie-Downloads

A lightweight browser app for browsing and streaming a shared movie library behind one shared password.

## What changed

- Password-protected catalog access with signed HttpOnly sessions
- Recursive movie discovery for local files and OneDrive-backed libraries
- Server-issued playback links so the browser can stream directly from the configured provider
- Vercel-compatible request handling with optional KV-backed sessions, throttling, and token persistence

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
4. KV REST credentials so sessions, login throttling, and rotated refresh tokens can persist across serverless instances

Copy `.env.example` to a local `.env` file or configure the same values in Vercel:

- `MOVIE_PROVIDER`
- `APP_ORIGIN`
- `TRUST_PROXY`
- `MOVIE_PASSWORD`
- `SESSION_SECRET`
- `SESSION_TTL_MS`
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

Set `ONEDRIVE_PUBLIC_CLIENT=true` only when your Microsoft app registration is configured as a public client and does not require a client secret for refresh-token exchange.

The app never exposes the shared password, session secret, or OneDrive credentials to the browser.

## Getting started

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
- Set `APP_ORIGIN` to the exact deployed site origin for CSRF checks
- Set `TRUST_PROXY=true` on Vercel so auth throttling keys can use the platform-provided forwarded client IP
- Protected API responses use `Cache-Control: private, no-store`
- For production, configure the environment variables in Vercel before testing

## Commands

- `npm start` — start the app locally
- `npm test` — run the test suite

## Remaining owner setup

This repository now includes the app-side OneDrive integration points, but the deployment still needs private setup values that are intentionally not stored in Git:

- The real shared password in `MOVIE_PASSWORD`
- A strong random `SESSION_SECRET`
- A Microsoft app registration and refresh token
- The correct `ONEDRIVE_DRIVE_ID` and `ONEDRIVE_ROOT_ITEM_ID`
- KV REST credentials for durable Vercel session/throttle/token storage

If those values are missing, protected routes fail closed instead of allowing anonymous access.
