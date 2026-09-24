# Private Fire TV Movie Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private sideloadable Fire TV app that pairs with Movie Room, browses the existing movie library, and plays movies directly on the TV through short-lived playback links.

**Architecture:** Add a TV device layer to the existing Node server, reuse the existing provider and Cast-ticket streaming approach for cookie-free TV playback, then build a small native Java Fire TV app that pairs, lists movies, and plays video with AndroidX Media3 ExoPlayer. Keep the web app as the approval authority: a signed-in browser approves a TV pairing code, while the TV stores only its own device token.

**Tech Stack:** Node.js 22.9+, built-in `node:test`, existing Vercel Node functions, existing KV store abstraction, Java Android, Gradle/Android Gradle Plugin, AndroidX Media3 ExoPlayer.

**Spec:** `docs/superpowers/specs/2026-09-24-private-fire-tv-movie-room-design.md`

## Global Constraints

- Private sideload Fire TV APK only; no Amazon Appstore submission in this version.
- Java Android code only; do not add Kotlin to the first private build.
- Fire TV app default base URL: `https://movie-downloads-six.vercel.app`.
- Pairing codes expire after 10 minutes and are one-use.
- Device tokens expire after 30 days in version one.
- Store token hashes server-side; never store the long-lived raw TV device token in `tv-device:<deviceId>`.
- Browser approval requires the normal Movie Room signed-in session and same-origin checks.
- TV endpoints use `Authorization: Bearer <device token>`, not browser cookies.
- Reuse provider validation and short-lived playback tickets for TV playback.
- MP4 with H.264 video and AAC audio is the safe playback target; unsupported codecs should fail with a useful message.
- Vercel nested TV API routes must be explicit files, matching the earlier Cast route lesson.

## Review Focus

- Expired pairing code: user expects a clear expired response and the TV expects to generate a new code. Covered in Task 1.
- Polling secret mismatch: only the TV that started pairing should receive the device token. Covered in Task 1.
- Browser cookie accidentally accepted for TV endpoints: TV library/playback must require bearer auth. Covered in Task 2.
- Still-uploading movie selected on TV: user expects a non-playable error, not a broken player. Covered in Task 2 and Task 5.
- Fire TV process restart after pairing: token storage must reload the device token without another pairing. Covered in Task 4.

---

## File Structure

- Modify `server.js`
  - Add TV pairing/device manager helpers.
  - Add TV routes inside `createRequestHandler`.
  - Reuse the existing Cast playback manager for TV playback ticket creation.

- Modify `test/server.test.js`
  - Add backend integration tests for pairing, approval, TV auth, library, and playback.
  - Add frontend unit tests for the pairing UI.

- Create `api/tv/pairings.js`
  - Vercel function entrypoint for `POST /api/tv/pairings`.

- Create `api/tv/pairings/[...path].js`
  - Vercel function entrypoint for `GET /api/tv/pairings/:pairingId` and `POST /api/tv/pairings/approve`.

- Create `api/tv/library.js`
  - Vercel function entrypoint for `GET /api/tv/library`.

- Create `api/tv/playback.js`
  - Vercel function entrypoint for `POST /api/tv/playback`.

- Modify `public/index.html`
  - Add "Pair Fire TV" controls to the authenticated watch UI.

- Modify `public/app.js`
  - Add pairing form behavior and API call.
  - Keep syntax compatible with older Safari by avoiding optional chaining and nullish coalescing in browser code.

- Modify `README.md`
  - Document Fire TV pairing, private APK build, and private install prerequisites.

- Create `settings.gradle`
  - Include the Fire TV Android module.

- Create root `build.gradle`
  - Configure Android Gradle Plugin repositories and versions.

- Create `firetv/build.gradle`
  - Configure Android app module, Java compatibility, dependencies, and test runner.

- Create `firetv/src/main/AndroidManifest.xml`
  - Fire TV app metadata, leanback launcher, internet permission, and main activity.

- Create `firetv/src/main/java/com/movieroom/firetv/MainActivity.java`
  - Remote-friendly pairing/library/player UI and screen state.

- Create `firetv/src/main/java/com/movieroom/firetv/MovieRoomApi.java`
  - HTTP client for pairing, library, and playback endpoints.

- Create `firetv/src/main/java/com/movieroom/firetv/DeviceTokenStore.java`
  - SharedPreferences-backed token store for version one.

- Create `firetv/src/main/java/com/movieroom/firetv/MovieRoomModels.java`
  - Plain Java model classes and minimal JSON parsing helpers.

- Create `firetv/src/test/java/com/movieroom/firetv/MovieRoomModelsTest.java`
  - Unit tests for API payload parsing.

- Create `firetv/src/test/java/com/movieroom/firetv/DeviceTokenStoreTest.java`
  - Unit tests for token storage behavior using Robolectric and AndroidX test core.

## Task 1: Backend Fire TV Pairing and Device Tokens

**Files:**
- Modify: `server.js`
- Modify: `test/server.test.js`

**Interfaces:**
- Produces: `createTvDeviceManager(store, authConfig, now, options)` inside `server.js`.
- Produces: `context.tvDeviceManager` in `createAppContext`.
- Produces route contracts:
  - `POST /api/tv/pairings`
  - `GET /api/tv/pairings/:pairingId`
  - `POST /api/tv/pairings/approve`
- Consumes: `MemoryStore`, `readJsonBody`, `sendJson`, `ensureSameOrigin`, `context.sessionManager.get`.

- [ ] **Step 1: Write the failing pairing lifecycle test**

Add this test near the Cast ticket tests in `test/server.test.js`:

```js
test("pairs a Fire TV through a browser-approved one-time code", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  const clock = { now: 1_000_000 };
  const store = new MemoryStore(() => clock.now);
  const server = await startServer(createAuthOptions({
    moviesDir,
    publicDir,
    now: () => clock.now,
    store,
  }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const pollSecret = "poll-secret-from-tv";
  const createResponse = await fetch(`${origin}/api/tv/pairings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceLabel: "Living Room Fire TV",
      pollSecret,
    }),
  });

  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.match(created.pairingId, /^[A-Za-z0-9_-]{16,}$/);
  assert.match(created.code, /^[A-Z0-9]{6}$/);
  assert.equal(created.expiresAt, clock.now + 10 * 60 * 1000);
  assert.equal(Object.hasOwn(created, "deviceToken"), false);

  const pendingResponse = await fetch(`${origin}/api/tv/pairings/${created.pairingId}`, {
    headers: { Authorization: `Bearer ${pollSecret}` },
  });
  assert.equal(pendingResponse.status, 200);
  assert.deepEqual(await pendingResponse.json(), {
    status: "pending",
    expiresAt: created.expiresAt,
  });

  const authResponse = await login(port);
  const cookie = authResponse.headers.get("set-cookie");
  const approveResponse = await fetch(`${origin}/api/tv/pairings/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: origin,
    },
    body: JSON.stringify({ code: created.code }),
  });

  assert.equal(approveResponse.status, 200);
  const approved = await approveResponse.json();
  assert.equal(approved.status, "approved");
  assert.match(approved.deviceLabel, /Living Room Fire TV/);

  const tvApprovedResponse = await fetch(`${origin}/api/tv/pairings/${created.pairingId}`, {
    headers: { Authorization: `Bearer ${pollSecret}` },
  });
  assert.equal(tvApprovedResponse.status, 200);
  const tvApproved = await tvApprovedResponse.json();
  assert.equal(tvApproved.status, "approved");
  assert.match(tvApproved.deviceId, /^[A-Za-z0-9_-]{16,}$/);
  assert.match(tvApproved.deviceToken, /^[A-Za-z0-9_-]{32,}$/);

  const secondPollResponse = await fetch(`${origin}/api/tv/pairings/${created.pairingId}`, {
    headers: { Authorization: `Bearer ${pollSecret}` },
  });
  assert.equal(secondPollResponse.status, 200);
  assert.deepEqual(await secondPollResponse.json(), {
    status: "approved",
    deviceId: tvApproved.deviceId,
  });
});
```

- [ ] **Step 2: Run the failing pairing lifecycle test**

Run:

```powershell
npm.cmd test -- --test-name-pattern "pairs a Fire TV"
```

Expected: FAIL with `404` or assertion failure because `/api/tv/pairings` does not exist.

- [ ] **Step 3: Write failing security and expiry tests**

Add these tests after the lifecycle test:

```js
test("rejects expired Fire TV pairings and wrong polling secrets", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  const clock = { now: 2_000_000 };
  const server = await startServer(createAuthOptions({
    moviesDir,
    publicDir,
    now: () => clock.now,
    store: new MemoryStore(() => clock.now),
  }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const createResponse = await fetch(`${origin}/api/tv/pairings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceLabel: "Bedroom Fire TV",
      pollSecret: "correct-poll-secret",
    }),
  });
  const created = await createResponse.json();

  const wrongSecretResponse = await fetch(`${origin}/api/tv/pairings/${created.pairingId}`, {
    headers: { Authorization: "Bearer wrong-poll-secret" },
  });
  assert.equal(wrongSecretResponse.status, 401);

  clock.now += 10 * 60 * 1000 + 1;
  const expiredPollResponse = await fetch(`${origin}/api/tv/pairings/${created.pairingId}`, {
    headers: { Authorization: "Bearer correct-poll-secret" },
  });
  assert.equal(expiredPollResponse.status, 410);

  const authResponse = await login(port);
  const expiredApproveResponse = await fetch(`${origin}/api/tv/pairings/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: authResponse.headers.get("set-cookie"),
      Origin: origin,
    },
    body: JSON.stringify({ code: created.code }),
  });
  assert.equal(expiredApproveResponse.status, 410);
});

test("requires a signed-in same-origin browser to approve a Fire TV", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  const server = await startServer(createAuthOptions({ moviesDir, publicDir }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const createResponse = await fetch(`${origin}/api/tv/pairings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceLabel: "Family Room Fire TV",
      pollSecret: "poll-secret",
    }),
  });
  const created = await createResponse.json();

  const anonymousResponse = await fetch(`${origin}/api/tv/pairings/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ code: created.code }),
  });
  assert.equal(anonymousResponse.status, 401);

  const authResponse = await login(port);
  const crossSiteResponse = await fetch(`${origin}/api/tv/pairings/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: authResponse.headers.get("set-cookie"),
      Origin: "https://evil.example",
    },
    body: JSON.stringify({ code: created.code }),
  });
  assert.equal(crossSiteResponse.status, 403);
});
```

- [ ] **Step 4: Run the failing security tests**

Run:

```powershell
npm.cmd test -- --test-name-pattern "Fire TV"
```

Expected: FAIL because the TV routes and manager do not exist.

- [ ] **Step 5: Implement TV manager constants and helpers**

In `server.js`, add constants near the other top-level constants:

```js
const TV_PAIRING_PREFIX = "tv-pairing:";
const TV_CODE_PREFIX = "tv-code:";
const TV_DEVICE_PREFIX = "tv-device:";
const DEFAULT_TV_PAIRING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TV_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
```

Add helper functions near `safeCompare` / signing helpers:

```js
function normalizePairingCode(code) {
  return String(code || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function generatePairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return code;
}

function hashSecret(secret, sessionSecret) {
  return crypto
    .createHmac("sha256", sessionSecret)
    .update(String(secret || ""))
    .digest("base64url");
}

function readBearerToken(request) {
  const header = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}
```

- [ ] **Step 6: Implement `createTvDeviceManager`**

Add `createTvDeviceManager(store, authConfig, now, options)` after `createCastPlaybackManager`. It must expose:

```js
function createTvDeviceManager(
  store,
  authConfig,
  now = Date.now,
  options = {},
) {
  const pairingTtlMs = options.pairingTtlMs || DEFAULT_TV_PAIRING_TTL_MS;
  const deviceTtlMs = options.deviceTtlMs || DEFAULT_TV_DEVICE_TTL_MS;

  return {
    async createPairing({ deviceLabel, pollSecret }) {},
    async approvePairing({ code, sessionId }) {},
    async pollPairing({ pairingId, pollSecret }) {},
    async authenticateDevice(token) {},
  };
}
```

Implementation requirements:

- `createPairing`:
  - Reject missing `pollSecret` with `400`.
  - Generate `pairingId` using `crypto.randomBytes(18).toString("base64url")`.
  - Generate `code` using `generatePairingCode()`.
  - Store `tv-pairing:<pairingId>` with status `pending`, `pollSecretHash`, `codeHash`, `deviceLabel`, `createdAt`, `expiresAt`.
  - Store `tv-code:<code>` as `{ pairingId }`.
  - Return `{ pairingId, code, expiresAt }`.

- `approvePairing`:
  - Normalize code.
  - Load `tv-code:<code>`, then `tv-pairing:<pairingId>`.
  - Return `404` for unknown code, `410` for expired, `409` for already resolved.
  - Create `deviceId` and `deviceToken` using `crypto.randomBytes(32).toString("base64url")`.
  - Store `tv-device:<deviceId>` with `tokenHash`, `deviceLabel`, `createdAt`, `expiresAt`, `revokedAt: null`.
  - Update pairing status to `approved`, include `deviceId`, `oneTimeDeviceToken`, `approvedAt`, `approvedBy`.
  - Return `{ status: "approved", deviceId, deviceLabel, expiresAt }`.

- `pollPairing`:
  - Load the pairing record.
  - Return `404` for unknown pairing, `410` for expired.
  - Validate `pollSecret` by comparing HMAC hashes with `safeCompare`.
  - For `pending`, return `{ status: "pending", expiresAt }`.
  - For first approved poll, return `{ status: "approved", deviceId, deviceToken }`, then delete `oneTimeDeviceToken` from the pairing record.
  - For later approved polls, return `{ status: "approved", deviceId }`.

- `authenticateDevice`:
  - Decode tokens shaped as `<deviceId>.<rawSecret>`.
  - Load `tv-device:<deviceId>`.
  - Reject unknown, expired, revoked, or hash mismatch with `401`.
  - Return `{ deviceId, expiresAt, deviceLabel }`.

- [ ] **Step 7: Wire manager into app context**

In `createAppContext`, add:

```js
const tvDeviceManager = createTvDeviceManager(store, authConfig, now, {
  pairingTtlMs: options.tvPairingTtlMs,
  deviceTtlMs: options.tvDeviceTtlMs,
});
```

Return `tvDeviceManager` in the context object.

- [ ] **Step 8: Add pairing routes**

In `createRequestHandler`, before the existing `/api/movies` route, add:

```js
if (request.method === "POST" && url.pathname === "/api/tv/pairings") {
  const body = await readJsonBody(request, context.authConfig.bodyLimit);
  const pairing = await context.tvDeviceManager.createPairing({
    deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : "",
    pollSecret: typeof body.pollSecret === "string" ? body.pollSecret : "",
  });
  await sendJson(response, 201, pairing, noStoreHeaders());
  return;
}

if (request.method === "POST" && url.pathname === "/api/tv/pairings/approve") {
  ensureSameOrigin(request, context.appOrigin, context.trustProxy);
  const session = await context.sessionManager.get(request, true);
  const body = await readJsonBody(request, context.authConfig.bodyLimit);
  const approved = await context.tvDeviceManager.approvePairing({
    code: typeof body.code === "string" ? body.code : "",
    sessionId: session.sessionId,
  });
  await sendJson(response, 200, approved, noStoreHeaders());
  return;
}

if (request.method === "GET" && url.pathname.startsWith("/api/tv/pairings/")) {
  const pairingId = decodeURIComponent(url.pathname.slice("/api/tv/pairings/".length));
  const polled = await context.tvDeviceManager.pollPairing({
    pairingId,
    pollSecret: readBearerToken(request),
  });
  await sendJson(response, 200, polled, noStoreHeaders());
  return;
}
```

- [ ] **Step 9: Verify backend pairing tests pass**

Run:

```powershell
npm.cmd test -- --test-name-pattern "Fire TV"
```

Expected: all Fire TV pairing tests pass.

- [ ] **Step 10: Run full suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass except the existing Windows-only unreadable-stream skip.

- [ ] **Step 11: Commit Task 1**

```powershell
git add server.js test/server.test.js
git commit -m "feat: add Fire TV pairing tokens"
```

## Task 2: Fire TV Library and Playback Backend Routes

**Files:**
- Modify: `server.js`
- Modify: `test/server.test.js`
- Create: `api/tv/pairings.js`
- Create: `api/tv/pairings/[...path].js`
- Create: `api/tv/library.js`
- Create: `api/tv/playback.js`

**Interfaces:**
- Consumes: `context.tvDeviceManager.authenticateDevice(token)`.
- Consumes: `context.provider.listLibrary()`, `context.provider.listMovies()`.
- Consumes: `context.castPlaybackManager.create(movieId, expiresAt)`.
- Produces:
  - `GET /api/tv/library`
  - `POST /api/tv/playback`

- [ ] **Step 1: Add test helper to pair a TV**

Add this helper after `login()` in `test/server.test.js`:

```js
async function pairFireTv(port, label = "Test Fire TV") {
  const origin = `http://127.0.0.1:${port}`;
  const pollSecret = `poll-secret-${Math.random()}`;
  const createResponse = await fetch(`${origin}/api/tv/pairings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceLabel: label, pollSecret }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const authResponse = await login(port);
  const approveResponse = await fetch(`${origin}/api/tv/pairings/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: authResponse.headers.get("set-cookie"),
      Origin: origin,
    },
    body: JSON.stringify({ code: created.code }),
  });
  assert.equal(approveResponse.status, 200);

  const pollResponse = await fetch(`${origin}/api/tv/pairings/${created.pairingId}`, {
    headers: { Authorization: `Bearer ${pollSecret}` },
  });
  assert.equal(pollResponse.status, 200);
  const approved = await pollResponse.json();
  assert.ok(approved.deviceToken);
  return approved.deviceToken;
}
```

- [ ] **Step 2: Write failing TV library/playback test**

Add:

```js
test("paired Fire TV lists the library and receives a cookie-free playback ticket", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "Family-Night.mp4"), "abcdef");
  fs.writeFileSync(path.join(moviesDir, "Still-Uploading.mp4"), "");
  const server = await startServer(createAuthOptions({ moviesDir, publicDir }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const deviceToken = await pairFireTv(port);

  const anonymousLibraryResponse = await fetch(`${origin}/api/tv/library`);
  assert.equal(anonymousLibraryResponse.status, 401);

  const libraryResponse = await fetch(`${origin}/api/tv/library`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(libraryResponse.status, 200);
  const library = await libraryResponse.json();
  assert.equal(library.movies.length, 2);
  const playable = library.movies.find((movie) => movie.fileName === "Family-Night.mp4");
  const uploading = library.movies.find((movie) => movie.fileName === "Still-Uploading.mp4");
  assert.ok(playable.id);
  assert.equal(uploading.size, 0);

  const uploadingPlaybackResponse = await fetch(`${origin}/api/tv/playback`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ movieId: uploading.id }),
  });
  assert.equal(uploadingPlaybackResponse.status, 409);

  const playbackResponse = await fetch(`${origin}/api/tv/playback`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ movieId: playable.id }),
  });
  assert.equal(playbackResponse.status, 200);
  const playback = await playbackResponse.json();
  assert.match(playback.url, new RegExp(`^${origin.replaceAll(".", "\\.")}/api/cast/stream\\?ticket=`));
  assert.equal(playback.contentType, "video/mp4");
  assert.equal(playback.title, "Family Night");

  const ticketResponse = await fetch(playback.url, { headers: { Range: "bytes=0-2" } });
  assert.equal(ticketResponse.status, 206);
  assert.equal(await ticketResponse.text(), "abc");
});
```

- [ ] **Step 3: Write failing OneDrive redirect test**

Add:

```js
test("paired Fire TV playback redirects OneDrive movies through a secure ticket", async (t) => {
  const { root, publicDir } = createTempLibrary();
  const provider = {
    kind: "onedrive",
    async listMovies() {
      return [{
        id: "movie-1",
        fileName: "OneDrive-Movie.mp4",
        title: "OneDrive Movie",
        size: 1024,
      }];
    },
    async listLibrary() {
      return {
        movies: await this.listMovies(),
        folders: [],
      };
    },
    async resolvePlayback(movieId) {
      assert.equal(movieId, "movie-1");
      return {
        url: "https://onedrive.example/download/movie.mp4",
        contentType: "video/mp4",
      };
    },
  };
  const server = await startServer(createAuthOptions({ publicDir, provider }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const deviceToken = await pairFireTv(port);
  const playbackResponse = await fetch(`${origin}/api/tv/playback`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ movieId: "movie-1" }),
  });
  assert.equal(playbackResponse.status, 200);
  const playback = await playbackResponse.json();
  const streamResponse = await fetch(playback.url, { redirect: "manual" });
  assert.equal(streamResponse.status, 307);
  assert.equal(streamResponse.headers.get("location"), "https://onedrive.example/download/movie.mp4");
});
```

- [ ] **Step 4: Run failing TV library/playback tests**

Run:

```powershell
npm.cmd test -- --test-name-pattern "paired Fire TV"
```

Expected: FAIL because `/api/tv/library` and `/api/tv/playback` do not exist.

- [ ] **Step 5: Implement TV bearer authentication helper**

In `server.js`, add:

```js
async function authenticateTvRequest(context, request) {
  return context.tvDeviceManager.authenticateDevice(readBearerToken(request));
}
```

- [ ] **Step 6: Add `/api/tv/library` route**

In `createRequestHandler`, add:

```js
if (request.method === "GET" && url.pathname === "/api/tv/library") {
  await authenticateTvRequest(context, request);
  const library = typeof context.provider.listLibrary === "function"
    ? await context.provider.listLibrary()
    : { movies: await context.provider.listMovies(), folders: [] };
  await sendJson(response, 200, library, noStoreHeaders());
  return;
}
```

- [ ] **Step 7: Add `/api/tv/playback` route**

In `createRequestHandler`, add:

```js
if (request.method === "POST" && url.pathname === "/api/tv/playback") {
  const device = await authenticateTvRequest(context, request);
  const body = await readJsonBody(request, context.authConfig.bodyLimit);
  const movieId = typeof body.movieId === "string" ? body.movieId : "";

  if (!movieId) {
    throw new HttpError(400, "A movie id is required.");
  }

  const tvPlayback = await context.castPlaybackManager.create(movieId, device.expiresAt);
  const ticketUrl = new URL(
    "/api/cast/stream",
    context.appOrigin || getOrigin(request, context.trustProxy),
  );
  ticketUrl.searchParams.set("ticket", tvPlayback.ticket);
  await sendJson(response, 200, {
    url: ticketUrl.toString(),
    contentType: tvPlayback.contentType,
    title: tvPlayback.title,
    expiresAt: tvPlayback.expiresAt,
  }, noStoreHeaders());
  return;
}
```

- [ ] **Step 8: Add Vercel TV API entrypoint files**

Create `api/tv/pairings.js`:

```js
const { createRequestHandler } = require("../../server");

module.exports = createRequestHandler();
```

Create `api/tv/pairings/[...path].js`:

```js
const { createRequestHandler } = require("../../../server");

module.exports = createRequestHandler();
```

Create `api/tv/library.js`:

```js
const { createRequestHandler } = require("../../server");

module.exports = createRequestHandler();
```

Create `api/tv/playback.js`:

```js
const { createRequestHandler } = require("../../server");

module.exports = createRequestHandler();
```

- [ ] **Step 9: Verify TV backend tests pass**

Run:

```powershell
npm.cmd test -- --test-name-pattern "Fire TV|paired Fire TV"
```

Expected: Fire TV backend tests pass.

- [ ] **Step 10: Run full suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass except the existing Windows-only unreadable-stream skip.

- [ ] **Step 11: Commit Task 2**

```powershell
git add server.js test/server.test.js api/tv
git commit -m "feat: add Fire TV library playback routes"
```

## Task 3: Web Pairing UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `test/server.test.js`

**Interfaces:**
- Consumes: `POST /api/tv/pairings/approve`.
- Produces UI controls:
  - `#pair-fire-tv`
  - `#fire-tv-pairing-form`
  - `#fire-tv-code`
  - `#fire-tv-pairing-status`

- [ ] **Step 1: Write failing static HTML test**

Add to the existing `"exposes phone and TV playback controls"` test:

```js
assert.match(html, /id="pair-fire-tv"/);
assert.match(html, /id="fire-tv-pairing-form"/);
assert.match(html, /id="fire-tv-code"/);
assert.match(html, /id="fire-tv-pairing-status"/);
assert.match(html, /Pair Fire TV/);
```

- [ ] **Step 2: Run failing HTML test**

Run:

```powershell
npm.cmd test -- --test-name-pattern "exposes phone and TV playback controls"
```

Expected: FAIL because the Fire TV pairing controls are missing.

- [ ] **Step 3: Write failing app interaction test**

Add:

```js
test("approves a Fire TV pairing code from the signed-in web UI", async () => {
  const listeners = {};
  const status = { textContent: "" };
  const fireTvCode = { value: "AB12CD" };
  const fireTvForm = {
    hidden: true,
    addEventListener(name, listener) {
      listeners[`form:${name}`] = listener;
    },
  };
  const pairFireTvButton = {
    disabled: true,
    addEventListener(name, listener) {
      listeners[`button:${name}`] = listener;
    },
  };
  const requests = [];
  const app = createApp({
    movieSelect: { value: "", disabled: false, addEventListener() {}, appendChild() {}, innerHTML: "" },
    reloadButton: { disabled: false, addEventListener() {} },
    logoutButton: { disabled: false, addEventListener() {} },
    searchInput: { disabled: false, addEventListener() {}, value: "" },
    passwordForm: { addEventListener() {} },
    passwordInput: { disabled: false, value: "", setAttribute() {}, removeAttribute() {}, select() {} },
    submitButton: { disabled: false },
    player: { removeAttribute() {}, load() {}, addEventListener() {}, setAttribute() {}, buffered: { length: 0 } },
    status: { textContent: "" },
    bufferStatus: { textContent: "", style: { setProperty() {} } },
    loginStatus: { textContent: "", focus() {} },
    librarySummary: { textContent: "" },
    folderShelf: { replaceChildren() {}, ownerDocument: { createElement: () => ({ addEventListener() {}, dataset: {} }) } },
    movieGrid: { replaceChildren() {}, ownerDocument: { createElement: () => ({ append() {}, addEventListener() {}, dataset: {} }) } },
    permissionPanel: { hidden: true },
    enablePermissionsButton: { addEventListener() {}, disabled: false },
    skipPermissionsButton: { addEventListener() {} },
    permissionStatus: { textContent: "" },
    castButton: { disabled: false, addEventListener() {} },
    tvGuideTitle: { textContent: "" },
    tvGuideSteps: { ownerDocument: { createElement: () => ({ textContent: "" }) }, replaceChildren() {}, append() {} },
    tvGuideStatus: { textContent: "" },
    keepAwakeButton: { disabled: false, textContent: "" },
    fullscreenButton: { disabled: false, addEventListener() {} },
    authPanel: { hidden: false },
    libraryPanel: { hidden: true },
    pairFireTvButton,
    fireTvPairingForm: fireTvForm,
    fireTvCodeInput: fireTvCode,
    fireTvPairingStatus: status,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "/api/session") {
        return { ok: true, status: 200, json: async () => ({ authenticated: true, authConfigured: true }) };
      }
      if (url === "/api/library") {
        return { ok: true, status: 200, json: async () => ({ movies: [], folders: [] }) };
      }
      if (url === "/api/tv/pairings/approve") {
        return { ok: true, status: 200, json: async () => ({ status: "approved", deviceLabel: "Living Room Fire TV" }) };
      }
      throw new Error(url);
    },
    locationOrigin: "https://movie-downloads.example",
    createOption: () => ({}),
    navigatorRef: { userAgent: "Mozilla/5.0 Safari/605.1.15", vendor: "Apple Computer, Inc." },
    localStorageRef: { getItem: () => "done", setItem() {} },
    windowRef: {},
  });

  app.initialize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pairFireTvButton.disabled, false);

  listeners["button:click"]();
  assert.equal(fireTvForm.hidden, false);

  await listeners["form:submit"]({ preventDefault() {} });
  assert.equal(status.textContent, "Living Room Fire TV is approved. Open the Fire TV app to continue.");
  const approval = requests.find((request) => request.url === "/api/tv/pairings/approve");
  assert.equal(approval.options.method, "POST");
  assert.deepEqual(JSON.parse(approval.options.body), { code: "AB12CD" });
});
```

- [ ] **Step 4: Run failing UI interaction test**

Run:

```powershell
npm.cmd test -- --test-name-pattern "approves a Fire TV"
```

Expected: FAIL because `createApp` does not accept or wire Fire TV pairing elements.

- [ ] **Step 5: Add HTML controls**

In `public/index.html`, add inside `.player-actions` after the Cast button:

```html
<button id="pair-fire-tv" class="secondary" type="button">Pair Fire TV</button>
```

Add under the TV guide section:

```html
<form id="fire-tv-pairing-form" class="tv-guide" hidden>
  <h2>Pair Fire TV</h2>
  <p class="detail">Enter the code shown on your Fire TV. The TV gets its own device access, not your password or OneDrive secrets.</p>
  <label for="fire-tv-code">Fire TV code</label>
  <input
    id="fire-tv-code"
    type="text"
    inputmode="text"
    autocomplete="one-time-code"
    autocapitalize="characters"
    maxlength="8"
    aria-describedby="fire-tv-pairing-status"
  />
  <button type="submit">Approve Fire TV</button>
  <p id="fire-tv-pairing-status" class="status" role="status" aria-live="polite"></p>
</form>
```

- [ ] **Step 6: Add app wiring**

In `createApp` parameters, add:

```js
pairFireTvButton,
fireTvPairingForm,
fireTvCodeInput,
fireTvPairingStatus,
```

Add functions before `initialize()`:

```js
function updateFireTvPairingStatus(message) {
  if (fireTvPairingStatus) {
    fireTvPairingStatus.textContent = message;
  }
}

function normalizeFireTvCode(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

async function approveFireTvPairing(event) {
  event.preventDefault();
  const code = normalizeFireTvCode(fireTvCodeInput ? fireTvCodeInput.value : "");
  if (!code) {
    updateFireTvPairingStatus("Enter the code shown on your Fire TV.");
    return false;
  }
  updateFireTvPairingStatus("Approving Fire TV...");
  const response = await handleApiResponse(
    await fetchImpl("/api/tv/pairings/approve", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    }),
    "Unable to approve this Fire TV.",
  );
  const approved = await response.json();
  const label = approved.deviceLabel || "Fire TV";
  updateFireTvPairingStatus(`${label} is approved. Open the Fire TV app to continue.`);
  if (fireTvCodeInput) {
    fireTvCodeInput.value = "";
  }
  return true;
}
```

Update `setAuthenticated`:

```js
if (pairFireTvButton) {
  pairFireTvButton.disabled = !authenticated;
}
```

Update `initialize()`:

```js
if (pairFireTvButton && fireTvPairingForm) {
  pairFireTvButton.addEventListener("click", () => {
    fireTvPairingForm.hidden = !fireTvPairingForm.hidden;
    if (!fireTvPairingForm.hidden) {
      updateFireTvPairingStatus("Enter the code shown on your Fire TV.");
    }
  });
}

if (fireTvPairingForm) {
  fireTvPairingForm.addEventListener("submit", (event) => {
    approveFireTvPairing(event).catch((error) => {
      updateFireTvPairingStatus(error.message);
    });
  });
}
```

Add DOM bindings in the browser initializer:

```js
pairFireTvButton: document.getElementById("pair-fire-tv"),
fireTvPairingForm: document.getElementById("fire-tv-pairing-form"),
fireTvCodeInput: document.getElementById("fire-tv-code"),
fireTvPairingStatus: document.getElementById("fire-tv-pairing-status"),
```

- [ ] **Step 7: Verify UI tests pass**

Run:

```powershell
npm.cmd test -- --test-name-pattern "phone and TV playback controls|approves a Fire TV"
```

Expected: both UI tests pass.

- [ ] **Step 8: Run full suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass except the existing Windows-only unreadable-stream skip.

- [ ] **Step 9: Commit Task 3**

```powershell
git add public/index.html public/app.js test/server.test.js
git commit -m "feat: add Fire TV pairing UI"
```

## Task 4: Fire TV Android Project Scaffold, API Client, and Storage

**Files:**
- Create: `settings.gradle`
- Create: `build.gradle`
- Create: `firetv/build.gradle`
- Create: `firetv/src/main/AndroidManifest.xml`
- Create: `firetv/src/main/java/com/movieroom/firetv/MovieRoomApi.java`
- Create: `firetv/src/main/java/com/movieroom/firetv/MovieRoomModels.java`
- Create: `firetv/src/main/java/com/movieroom/firetv/DeviceTokenStore.java`
- Create: `firetv/src/test/java/com/movieroom/firetv/MovieRoomModelsTest.java`
- Create: `firetv/src/test/java/com/movieroom/firetv/DeviceTokenStoreTest.java`

**Interfaces:**
- Produces: `MovieRoomApi` with methods:
  - `Pairing createPairing(String deviceLabel, String pollSecret)`
  - `PairingStatus pollPairing(String pairingId, String pollSecret)`
  - `Library loadLibrary(String deviceToken)`
  - `Playback startPlayback(String deviceToken, String movieId)`
- Produces: `DeviceTokenStore` with methods:
  - `String getDeviceToken()`
  - `void saveDeviceToken(String token)`
  - `void clearDeviceToken()`

- [ ] **Step 1: Create Gradle project files**

Create `settings.gradle`:

```groovy
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "MovieRoomFireTv"
include ":firetv"
```

Create root `build.gradle`:

```groovy
plugins {
    id "com.android.application" version "8.7.3" apply false
}
```

Create `firetv/build.gradle`:

```groovy
plugins {
    id "com.android.application"
}

android {
    namespace "com.movieroom.firetv"
    compileSdk 35

    defaultConfig {
        applicationId "com.movieroom.firetv"
        minSdk 23
        targetSdk 35
        versionCode 1
        versionName "0.1.0"
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField "String", "MOVIE_ROOM_BASE_URL", "\"https://movie-downloads-six.vercel.app\""
    }

    buildFeatures {
        buildConfig true
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
}

dependencies {
    implementation "androidx.appcompat:appcompat:1.7.0"
    implementation "androidx.leanback:leanback:1.2.0-alpha04"
    implementation "androidx.media3:media3-exoplayer:1.5.1"
    implementation "androidx.media3:media3-ui:1.5.1"
    testImplementation "junit:junit:4.13.2"
    testImplementation "androidx.test:core:1.6.1"
    testImplementation "org.robolectric:robolectric:4.14.1"
}
```

- [ ] **Step 2: Create manifest**

Create `firetv/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-feature
        android:name="android.software.leanback"
        android:required="true" />
    <uses-feature
        android:name="android.hardware.touchscreen"
        android:required="false" />

    <application
        android:allowBackup="false"
        android:banner="@mipmap/ic_launcher"
        android:icon="@mipmap/ic_launcher"
        android:label="Movie Room"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

Also create `firetv/src/main/res/values/styles.xml`:

```xml
<resources>
    <style name="AppTheme" parent="android:style/Theme.Material.NoActionBar">
        <item name="android:fontFamily">sans</item>
        <item name="android:windowBackground">#0f0f0f</item>
        <item name="android:colorAccent">#ff0033</item>
    </style>
</resources>
```

- [ ] **Step 3: Write failing model parser tests**

Create `MovieRoomModelsTest.java`:

```java
package com.movieroom.firetv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MovieRoomModelsTest {
    @Test
    public void parsesPairingStatusApprovedWithDeviceToken() throws Exception {
        MovieRoomModels.PairingStatus status = MovieRoomModels.PairingStatus.fromJson(
                "{\"status\":\"approved\",\"deviceId\":\"device-1\",\"deviceToken\":\"device-1.secret\"}");

        assertEquals("approved", status.status);
        assertEquals("device-1", status.deviceId);
        assertEquals("device-1.secret", status.deviceToken);
    }

    @Test
    public void parsesLibraryAndMarksStillUploadingMovieNotPlayable() throws Exception {
        MovieRoomModels.Library library = MovieRoomModels.Library.fromJson(
                "{\"movies\":[{\"id\":\"movie-1\",\"title\":\"Ready\",\"fileName\":\"Ready.mp4\",\"size\":10}," +
                        "{\"id\":\"movie-2\",\"title\":\"Uploading\",\"fileName\":\"Uploading.mp4\",\"size\":0}],\"folders\":[]}");

        assertEquals(2, library.movies.size());
        assertTrue(library.movies.get(0).isPlayable());
        assertFalse(library.movies.get(1).isPlayable());
    }

    @Test
    public void parsesPlaybackUrlAndTitle() throws Exception {
        MovieRoomModels.Playback playback = MovieRoomModels.Playback.fromJson(
                "{\"url\":\"https://movie.example/stream\",\"title\":\"Family Night\",\"contentType\":\"video/mp4\",\"expiresAt\":1000}");

        assertEquals("https://movie.example/stream", playback.url);
        assertEquals("Family Night", playback.title);
        assertEquals("video/mp4", playback.contentType);
        assertEquals(1000L, playback.expiresAt);
    }
}
```

- [ ] **Step 4: Run failing Fire TV unit tests**

Run:

```powershell
.\gradlew.bat :firetv:testDebugUnitTest
```

Expected: FAIL because model classes do not exist. If `gradlew.bat` is missing, create it before rerunning this command with `gradle wrapper --gradle-version 8.10.2` from a Gradle installation, then commit `gradlew`, `gradlew.bat`, and `gradle/wrapper/`.

- [ ] **Step 5: Implement model classes**

Create `MovieRoomModels.java` with:

```java
package com.movieroom.firetv;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public final class MovieRoomModels {
    private MovieRoomModels() {
    }

    public static final class Pairing {
        public final String pairingId;
        public final String code;
        public final long expiresAt;

        public Pairing(String pairingId, String code, long expiresAt) {
            this.pairingId = pairingId;
            this.code = code;
            this.expiresAt = expiresAt;
        }

        public static Pairing fromJson(String json) throws Exception {
            JSONObject object = new JSONObject(json);
            return new Pairing(object.getString("pairingId"), object.getString("code"), object.getLong("expiresAt"));
        }
    }

    public static final class PairingStatus {
        public final String status;
        public final String deviceId;
        public final String deviceToken;
        public final long expiresAt;

        public PairingStatus(String status, String deviceId, String deviceToken, long expiresAt) {
            this.status = status;
            this.deviceId = deviceId;
            this.deviceToken = deviceToken;
            this.expiresAt = expiresAt;
        }

        public static PairingStatus fromJson(String json) throws Exception {
            JSONObject object = new JSONObject(json);
            return new PairingStatus(
                    object.getString("status"),
                    object.optString("deviceId", ""),
                    object.optString("deviceToken", ""),
                    object.optLong("expiresAt", 0L));
        }
    }

    public static final class Movie {
        public final String id;
        public final String title;
        public final String fileName;
        public final String folder;
        public final long size;

        public Movie(String id, String title, String fileName, String folder, long size) {
            this.id = id;
            this.title = title;
            this.fileName = fileName;
            this.folder = folder;
            this.size = size;
        }

        public boolean isPlayable() {
            return size > 0L;
        }
    }

    public static final class Library {
        public final List<Movie> movies;

        public Library(List<Movie> movies) {
            this.movies = movies;
        }

        public static Library fromJson(String json) throws Exception {
            JSONObject object = new JSONObject(json);
            JSONArray moviesArray = object.optJSONArray("movies");
            List<Movie> movies = new ArrayList<>();
            if (moviesArray != null) {
                for (int index = 0; index < moviesArray.length(); index++) {
                    JSONObject movie = moviesArray.getJSONObject(index);
                    movies.add(new Movie(
                            movie.getString("id"),
                            movie.optString("title", movie.optString("fileName", "Untitled")),
                            movie.optString("fileName", ""),
                            movie.optString("folder", ""),
                            movie.optLong("size", 0L)));
                }
            }
            return new Library(movies);
        }
    }

    public static final class Playback {
        public final String url;
        public final String title;
        public final String contentType;
        public final long expiresAt;

        public Playback(String url, String title, String contentType, long expiresAt) {
            this.url = url;
            this.title = title;
            this.contentType = contentType;
            this.expiresAt = expiresAt;
        }

        public static Playback fromJson(String json) throws Exception {
            JSONObject object = new JSONObject(json);
            return new Playback(
                    object.getString("url"),
                    object.optString("title", "Movie Room"),
                    object.optString("contentType", "video/mp4"),
                    object.optLong("expiresAt", 0L));
        }
    }
}
```

- [ ] **Step 6: Implement token store and test**

Create `DeviceTokenStore.java`:

```java
package com.movieroom.firetv;

import android.content.Context;
import android.content.SharedPreferences;

public final class DeviceTokenStore {
    private static final String PREFS = "movie_room_fire_tv";
    private static final String KEY_DEVICE_TOKEN = "device_token";

    private final SharedPreferences preferences;

    public DeviceTokenStore(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public String getDeviceToken() {
        return preferences.getString(KEY_DEVICE_TOKEN, "");
    }

    public void saveDeviceToken(String token) {
        preferences.edit().putString(KEY_DEVICE_TOKEN, token).apply();
    }

    public void clearDeviceToken() {
        preferences.edit().remove(KEY_DEVICE_TOKEN).apply();
    }
}
```

Create `DeviceTokenStoreTest.java`:

```java
package com.movieroom.firetv;

import static org.junit.Assert.assertEquals;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class DeviceTokenStoreTest {
    @Test
    public void storesReloadsAndClearsDeviceToken() {
        Context context = ApplicationProvider.getApplicationContext();
        DeviceTokenStore store = new DeviceTokenStore(context);

        store.clearDeviceToken();
        assertEquals("", store.getDeviceToken());

        store.saveDeviceToken("device-1.secret");
        DeviceTokenStore reloaded = new DeviceTokenStore(context);
        assertEquals("device-1.secret", reloaded.getDeviceToken());

        reloaded.clearDeviceToken();
        assertEquals("", store.getDeviceToken());
    }
}
```

- [ ] **Step 7: Implement API client**

Create `MovieRoomApi.java`:

```java
package com.movieroom.firetv;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class MovieRoomApi {
    private final String baseUrl;

    public MovieRoomApi(String baseUrl) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }

    public MovieRoomModels.Pairing createPairing(String deviceLabel, String pollSecret) throws Exception {
        JSONObject body = new JSONObject();
        body.put("deviceLabel", deviceLabel);
        body.put("pollSecret", pollSecret);
        return MovieRoomModels.Pairing.fromJson(request("POST", "/api/tv/pairings", "", body.toString()));
    }

    public MovieRoomModels.PairingStatus pollPairing(String pairingId, String pollSecret) throws Exception {
        return MovieRoomModels.PairingStatus.fromJson(request("GET", "/api/tv/pairings/" + pairingId, pollSecret, ""));
    }

    public MovieRoomModels.Library loadLibrary(String deviceToken) throws Exception {
        return MovieRoomModels.Library.fromJson(request("GET", "/api/tv/library", deviceToken, ""));
    }

    public MovieRoomModels.Playback startPlayback(String deviceToken, String movieId) throws Exception {
        JSONObject body = new JSONObject();
        body.put("movieId", movieId);
        return MovieRoomModels.Playback.fromJson(request("POST", "/api/tv/playback", deviceToken, body.toString()));
    }

    private String request(String method, String path, String bearerToken, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        if (!bearerToken.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
        }
        if (!body.isEmpty()) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }

        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String payload = readAll(stream);
        if (status < 200 || status >= 300) {
            throw new MovieRoomApiException(status, payload);
        }
        return payload;
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
        }
        return builder.toString();
    }

    public static final class MovieRoomApiException extends Exception {
        public final int statusCode;

        public MovieRoomApiException(int statusCode, String body) {
            super(body.isEmpty() ? "Movie Room request failed with status " + statusCode : body);
            this.statusCode = statusCode;
        }
    }
}
```

- [ ] **Step 8: Verify Fire TV unit tests**

Run:

```powershell
.\gradlew.bat :firetv:testDebugUnitTest
```

Expected: Fire TV unit tests pass.

- [ ] **Step 9: Commit Task 4**

```powershell
git add settings.gradle build.gradle firetv
git commit -m "feat: scaffold Fire TV app client"
```

## Task 5: Fire TV Pairing, Library, and Playback UI

**Files:**
- Create: `firetv/src/main/java/com/movieroom/firetv/MainActivity.java`
- Create: `firetv/src/main/res/drawable/ic_launcher.xml`
- Create: `firetv/src/main/res/drawable/banner.xml`
- Modify: `firetv/build.gradle`
- Modify: `README.md`

**Interfaces:**
- Consumes: `MovieRoomApi`.
- Consumes: `DeviceTokenStore`.
- Consumes: AndroidX Media3 ExoPlayer.
- Produces: a debug APK at `firetv/build/outputs/apk/debug/firetv-debug.apk` or the module default equivalent.

- [ ] **Step 1: Add drawable app assets**

Create `firetv/src/main/res/drawable/ic_launcher.xml`:

```xml
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#ff0033"
        android:pathData="M10,20h88a10,10 0,0 1,10 10v48a10,10 0,0 1,-10 10H10A10,10 0,0 1,0 78V30A10,10 0,0 1,10 20z" />
    <path
        android:fillColor="#ffffff"
        android:pathData="M43,36l32,18l-32,18z" />
</vector>
```

Create `firetv/src/main/res/drawable/banner.xml`:

```xml
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="320dp"
    android:height="180dp"
    android:viewportWidth="320"
    android:viewportHeight="180">
    <path
        android:fillColor="#0f0f0f"
        android:pathData="M0,0h320v180h-320z" />
    <path
        android:fillColor="#ff0033"
        android:pathData="M32,62h96a12,12 0,0 1,12 12v32a12,12 0,0 1,-12 12H32A12,12 0,0 1,20 106V74A12,12 0,0 1,32 62z" />
    <path
        android:fillColor="#ffffff"
        android:pathData="M70,76l36,18l-36,18z" />
</vector>
```

Update the manifest application attributes from Task 4:

```xml
android:banner="@drawable/banner"
android:icon="@drawable/ic_launcher"
```

- [ ] **Step 2: Create `MainActivity` skeleton**

Create `MainActivity.java` with programmatic UI so there is no XML layout dependency:

```java
package com.movieroom.firetv;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.media3.common.MediaItem;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;

import java.security.SecureRandom;
import java.util.Locale;

public class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final SecureRandom random = new SecureRandom();
    private DeviceTokenStore tokenStore;
    private MovieRoomApi api;
    private LinearLayout root;
    private ExoPlayer player;
    private String pendingPairingId = "";
    private String pendingPollSecret = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        tokenStore = new DeviceTokenStore(this);
        api = new MovieRoomApi(BuildConfig.MOVIE_ROOM_BASE_URL);
        if (tokenStore.getDeviceToken().isEmpty()) {
            showPairingScreen();
        } else {
            showLibraryScreen();
        }
    }

    @Override
    protected void onDestroy() {
        if (player != null) {
            player.release();
        }
        super.onDestroy();
    }

    private void setScreen() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 40, 48, 40);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(0xff0f0f0f);
        setContentView(root);
    }

    private TextView text(String value, int sizeSp) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(0xfff5f5f5);
        view.setTextSize(sizeSp);
        view.setPadding(0, 12, 0, 12);
        return view;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(22);
        button.setAllCaps(false);
        button.setPadding(28, 18, 28, 18);
        return button;
    }

    private String randomSecret() {
        byte[] bytes = new byte[24];
        random.nextBytes(bytes);
        StringBuilder builder = new StringBuilder();
        for (byte value : bytes) {
            builder.append(String.format(Locale.US, "%02x", value));
        }
        return builder.toString();
    }
}
```

- [ ] **Step 3: Add pairing screen**

Add methods:

```java
private void showPairingScreen() {
    setScreen();
    root.addView(text("Movie Room Fire TV", 34));
    TextView status = text("Creating a pairing code...", 24);
    root.addView(status);
    ProgressBar progress = new ProgressBar(this);
    root.addView(progress);
    Button retry = button("New Code");
    retry.setOnClickListener(view -> showPairingScreen());
    root.addView(retry);

    new Thread(() -> {
        try {
            pendingPollSecret = randomSecret();
            MovieRoomModels.Pairing pairing = api.createPairing("Fire TV", pendingPollSecret);
            pendingPairingId = pairing.pairingId;
            handler.post(() -> status.setText("On your Mac, open Movie Room, choose Pair Fire TV, and enter: " + pairing.code));
            pollPairing(status);
        } catch (Exception error) {
            handler.post(() -> status.setText("Could not create a code. Check Wi-Fi and try New Code."));
        }
    }).start();
}

private void pollPairing(TextView status) {
    handler.postDelayed(() -> new Thread(() -> {
        try {
            MovieRoomModels.PairingStatus pairingStatus = api.pollPairing(pendingPairingId, pendingPollSecret);
            if ("approved".equals(pairingStatus.status) && !pairingStatus.deviceToken.isEmpty()) {
                tokenStore.saveDeviceToken(pairingStatus.deviceToken);
                handler.post(this::showLibraryScreen);
                return;
            }
            handler.post(() -> pollPairing(status));
        } catch (MovieRoomApi.MovieRoomApiException error) {
            handler.post(() -> status.setText(error.statusCode == 410
                    ? "Code expired. Choose New Code."
                    : "Waiting for approval. Keep this screen open."));
        } catch (Exception error) {
            handler.post(() -> status.setText("Network problem. Check Wi-Fi and keep this screen open."));
        }
    }).start(), 2500);
}
```

- [ ] **Step 4: Add library screen**

Add:

```java
private void showLibraryScreen() {
    setScreen();
    root.addView(text("Movie Room", 34));
    TextView status = text("Loading library...", 22);
    root.addView(status);
    Button unpair = button("Unpair this Fire TV");
    unpair.setOnClickListener(view -> {
        tokenStore.clearDeviceToken();
        showPairingScreen();
    });
    root.addView(unpair);

    ScrollView scrollView = new ScrollView(this);
    LinearLayout list = new LinearLayout(this);
    list.setOrientation(LinearLayout.VERTICAL);
    scrollView.addView(list);
    root.addView(scrollView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f));

    new Thread(() -> {
        try {
            MovieRoomModels.Library library = api.loadLibrary(tokenStore.getDeviceToken());
            handler.post(() -> {
                status.setText(library.movies.size() + " movies found");
                list.removeAllViews();
                for (MovieRoomModels.Movie movie : library.movies) {
                    Button row = button(movie.title + (movie.isPlayable() ? "" : " (still uploading)"));
                    row.setEnabled(movie.isPlayable());
                    row.setOnClickListener(view -> startMovie(movie, status));
                    list.addView(row);
                }
            });
        } catch (MovieRoomApi.MovieRoomApiException error) {
            handler.post(() -> {
                if (error.statusCode == 401) {
                    tokenStore.clearDeviceToken();
                    showPairingScreen();
                } else {
                    status.setText("Could not load library. Try again.");
                }
            });
        } catch (Exception error) {
            handler.post(() -> status.setText("Network problem. Check Wi-Fi and try again."));
        }
    }).start();
}
```

- [ ] **Step 5: Add playback screen**

Add:

```java
private void startMovie(MovieRoomModels.Movie movie, TextView status) {
    status.setText("Starting " + movie.title + "...");
    new Thread(() -> {
        try {
            MovieRoomModels.Playback playback = api.startPlayback(tokenStore.getDeviceToken(), movie.id);
            handler.post(() -> showPlayer(playback));
        } catch (MovieRoomApi.MovieRoomApiException error) {
            handler.post(() -> status.setText(error.statusCode == 409
                    ? "Movie is still uploading."
                    : "This movie could not be played."));
        } catch (Exception error) {
            handler.post(() -> status.setText("Network problem. Try again."));
        }
    }).start();
}

private void showPlayer(MovieRoomModels.Playback playback) {
    if (player != null) {
        player.release();
    }
    setScreen();
    root.addView(text(playback.title, 28));
    PlayerView playerView = new PlayerView(this);
    player = new ExoPlayer.Builder(this).build();
    playerView.setPlayer(player);
    root.addView(playerView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f));
    Button back = button("Back to Library");
    back.setOnClickListener(view -> {
        if (player != null) {
            player.release();
            player = null;
        }
        showLibraryScreen();
    });
    root.addView(back);
    player.setMediaItem(MediaItem.fromUri(Uri.parse(playback.url)));
    player.prepare();
    player.play();
}

@Override
public boolean onKeyDown(int keyCode, KeyEvent event) {
    if (keyCode == KeyEvent.KEYCODE_BACK && player != null) {
        player.release();
        player = null;
        showLibraryScreen();
        return true;
    }
    return super.onKeyDown(keyCode, event);
}
```

- [ ] **Step 6: Build debug APK**

Run:

```powershell
.\gradlew.bat :firetv:assembleDebug
```

Expected: APK builds under `firetv/build/outputs/apk/debug/`.

- [ ] **Step 7: Update README**

Add a `## Private Fire TV app` section:

````markdown
## Private Fire TV app

The private Fire TV app lives in `firetv/`. It is for sideloading onto the owner's Fire TV devices and is not an Amazon Appstore submission.

Build a debug APK:

```powershell
.\gradlew.bat :firetv:assembleDebug
```

The APK is created under `firetv/build/outputs/apk/debug/`.

Pairing flow:

1. Open the Fire TV app.
2. Keep the pairing code visible on the TV.
3. Open Movie Room in the browser and sign in.
4. Choose Pair Fire TV.
5. Enter the code shown on the TV.
6. Return to the Fire TV app and choose a movie.

Private install requires Fire TV developer options and ADB approval on the TV. Do not put Movie Room passwords, OneDrive secrets, or Vercel secrets into the APK.
```
````

- [ ] **Step 8: Run all verification**

Run:

```powershell
npm.cmd test
.\gradlew.bat :firetv:testDebugUnitTest
.\gradlew.bat :firetv:assembleDebug
```

Expected:

- Node tests pass except the existing Windows-only unreadable-stream skip.
- Fire TV unit tests pass.
- Debug APK builds.

- [ ] **Step 9: Commit Task 5**

```powershell
git add firetv README.md
git commit -m "feat: build private Fire TV app"
```

## Task 6: Production Deploy and Real Device Handoff

**Files:**
- Modify only if verification finds a documented command correction:
  - `README.md`

**Interfaces:**
- Consumes: Vercel project linked in `.vercel/project.json`.
- Consumes: APK from `firetv/build/outputs/apk/debug/`.
- Produces: deployed production backend and local APK handoff path.

- [ ] **Step 1: Run full local verification**

Run:

```powershell
npm.cmd test
.\gradlew.bat :firetv:testDebugUnitTest
.\gradlew.bat :firetv:assembleDebug
```

Expected:

- Node tests pass except the existing Windows-only unreadable-stream skip.
- Fire TV unit tests pass.
- APK exists under `firetv/build/outputs/apk/debug/`.

- [ ] **Step 2: Deploy backend to Vercel production**

Use a clean committed source export or a clean working tree. Then run:

```powershell
vercel.cmd deploy --prod --yes --scope taylormade02471-1195s-projects
```

Expected:

- Deployment status is `READY`.
- `https://movie-downloads-six.vercel.app` is aliased to the new deployment.

- [ ] **Step 3: Verify live TV routes without secrets**

Run:

```powershell
$pairing = Invoke-RestMethod -Method Post -Uri 'https://movie-downloads-six.vercel.app/api/tv/pairings' -ContentType 'application/json' -Body '{"deviceLabel":"Smoke Test Fire TV","pollSecret":"smoke-poll-secret"}'
$pairing.code
```

Expected: command prints a six-character code. Do not approve the smoke pairing unless doing a full manual test. It will expire by itself.

- [ ] **Step 4: Inspect deployment**

Run:

```powershell
vercel.cmd inspect <deployment-url> --scope taylormade02471-1195s-projects
vercel.cmd logs <deployment-url> --scope taylormade02471-1195s-projects --since 1h
```

Expected:

- Inspect shows `Ready`.
- Logs show no unexpected errors from the TV routes.

- [ ] **Step 5: Prepare APK handoff**

Record the exact APK path in the final response:

```powershell
Get-ChildItem firetv\build\outputs\apk\debug\*.apk | Select-Object FullName,Length,LastWriteTime
```

Expected: one debug APK exists and has nonzero length.

- [ ] **Step 6: Commit deployment docs correction when README changed**

Only if README commands were corrected during verification:

```powershell
git add README.md
git commit -m "docs: clarify Fire TV install steps"
```

- [ ] **Step 7: Final handoff**

Report:

- Production URL.
- Vercel deployment id and status.
- APK path.
- Verification commands and results.
- Clear device install note: Fire TV developer options and ADB approval still require user action on the TV.
