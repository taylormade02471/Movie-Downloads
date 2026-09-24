const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createServer } = require("../server");
const { createApp } = require("../public/app");
const { MemoryStore } = require("../lib/store");
const { createOneDriveProvider } = require("../lib/providers/onedrive");

function createTempLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "movie-room-"));
  const moviesDir = path.join(root, "movies");
  const publicDir = path.join(root, "public");
  fs.mkdirSync(path.join(moviesDir, "Collections"), { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), "<h1>Movie Room</h1>");
  fs.writeFileSync(path.join(publicDir, "app.js"), "console.log('ok');");
  return { root, moviesDir, publicDir };
}

function createAuthOptions(overrides = {}) {
  const authOverrides = overrides.auth || {};
  const { auth: _ignored, ...rest } = overrides;
  return {
    auth: {
      password: "lowercase",
      sessionSecret: "0123456789abcdef0123456789abcdef",
      sessionTtlMs: 60_000,
      rateLimitMaxAttempts: 2,
      rateLimitWindowMs: 60_000,
      ...authOverrides,
    },
    ...rest,
  };
}

async function startServer(options) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function login(port, password = "lowercase", headers = {}) {
  return fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: `http://127.0.0.1:${port}`,
      ...headers,
    },
    body: JSON.stringify({ password }),
  });
}

test("serves the watch page and protects the movie catalog", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "Family-Night.mp4"), "abcdef");

  const server = await startServer(createAuthOptions({ moviesDir, publicDir }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Movie Room/);

  const moviesResponse = await fetch(`http://127.0.0.1:${port}/api/movies`);
  assert.equal(moviesResponse.status, 401);
});

test("logs in, lists nested local movies, resolves playback, and logs out", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "Collections", "Family-Night.mp4"), "abcdef");

  const server = await startServer(createAuthOptions({ moviesDir, publicDir }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const authResponse = await login(port);
  assert.equal(authResponse.status, 204);
  const sessionCookie = authResponse.headers.get("set-cookie");
  assert.match(sessionCookie, /movie_room_session=/);

  const moviesResponse = await fetch(`http://127.0.0.1:${port}/api/movies`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(moviesResponse.status, 200);

  const movies = await moviesResponse.json();
  assert.equal(movies[0].title, "Family Night");
  assert.equal(movies[0].folder, "Collections");

  const playbackResponse = await fetch(`http://127.0.0.1:${port}/api/playback/${encodeURIComponent(movies[0].id)}`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(playbackResponse.status, 200);
  assert.deepEqual(await playbackResponse.json(), {
    url: "/api/stream/Collections/Family-Night.mp4",
    expiresAt: null,
  });

  const headResponse = await fetch(`http://127.0.0.1:${port}/api/stream/Collections/Family-Night.mp4`, {
    method: "HEAD",
    headers: { Cookie: sessionCookie },
  });
  assert.equal(headResponse.status, 200);

  const logoutResponse = await fetch(`http://127.0.0.1:${port}/api/logout`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      "Content-Type": "application/json",
      Origin: `http://127.0.0.1:${port}`,
    },
    body: "{}",
  });
  assert.equal(logoutResponse.status, 204);

  const afterLogoutResponse = await fetch(`http://127.0.0.1:${port}/api/movies`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(afterLogoutResponse.status, 401);
});

test("expires and rejects tampered sessions", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "clip.mp4"), "0123456789");

  const clock = { now: 1000 };
  const server = await startServer(createAuthOptions({
    moviesDir,
    publicDir,
    now: () => clock.now,
    store: new MemoryStore(() => clock.now),
    auth: { sessionTtlMs: 500 },
  }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const authResponse = await login(port);
  const sessionCookie = authResponse.headers.get("set-cookie");
  const cookieParts = sessionCookie.split(";");
  const [cookieName, cookieValue] = cookieParts[0].split("=");
  const tamperedCookie = `${cookieName}=${cookieValue.slice(0, -1)}x;${cookieParts.slice(1).join(";")}`;

  const tamperedResponse = await fetch(`http://127.0.0.1:${port}/api/session`, {
    headers: {
      Cookie: tamperedCookie,
    },
  });
  assert.equal(tamperedResponse.status, 200);
  assert.deepEqual(await tamperedResponse.json(), {
    authenticated: false,
    authConfigured: true,
    expiresAt: null,
    provider: "local",
  });

  clock.now += 600;
  const expiredSessionResponse = await fetch(`http://127.0.0.1:${port}/api/session`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(expiredSessionResponse.status, 200);
  assert.deepEqual(await expiredSessionResponse.json(), {
    authenticated: false,
    authConfigured: true,
    expiresAt: null,
    provider: "local",
  });

  const expiredResponse = await fetch(`http://127.0.0.1:${port}/api/movies`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(expiredResponse.status, 401);
});

test("throttles repeated failed logins", async () => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  const server = await startServer(createAuthOptions({ moviesDir, publicDir }));

  try {
    const { port } = server.address();
    assert.equal((await login(port, "wrong")).status, 401);
    assert.equal((await login(port, "wrong-again")).status, 401);
    assert.equal((await login(port, "wrong-third")).status, 429);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("supports partial content requests for background buffering and seeking", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "clip.mp4"), "0123456789");

  const server = await startServer(createAuthOptions({ moviesDir, publicDir }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const authResponse = await login(port);
  const sessionCookie = authResponse.headers.get("set-cookie");

  const response = await fetch(`http://127.0.0.1:${port}/api/stream/clip.mp4`, {
    headers: {
      Cookie: sessionCookie,
      Range: "bytes=2-5",
    },
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await response.text(), "2345");
});

test("supports suffix byte ranges and HEAD range probes", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "clip.mp4"), "0123456789");

  const server = await startServer(createAuthOptions({ moviesDir, publicDir }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const authResponse = await login(port);
  const sessionCookie = authResponse.headers.get("set-cookie");

  const suffixResponse = await fetch(`http://127.0.0.1:${port}/api/stream/clip.mp4`, {
    headers: {
      Cookie: sessionCookie,
      Range: "bytes=-4",
    },
  });

  assert.equal(suffixResponse.status, 206);
  assert.equal(suffixResponse.headers.get("content-range"), "bytes 6-9/10");
  assert.equal(await suffixResponse.text(), "6789");

  const headResponse = await fetch(`http://127.0.0.1:${port}/api/stream/clip.mp4`, {
    method: "HEAD",
    headers: {
      Cookie: sessionCookie,
      Range: "bytes=2-5",
    },
  });

  assert.equal(headResponse.status, 206);
  assert.equal(headResponse.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(headResponse.headers.get("content-length"), "4");
  assert.equal(await headResponse.text(), "");
});

test("clamps oversized ranges and rejects traversal attempts", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "clip.mp4"), "0123456789");

  const server = await startServer(createAuthOptions({ moviesDir, publicDir }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const authResponse = await login(port);
  const sessionCookie = authResponse.headers.get("set-cookie");

  const oversizedRangeResponse = await fetch(`http://127.0.0.1:${port}/api/stream/clip.mp4`, {
    headers: {
      Cookie: sessionCookie,
      Range: "bytes=0-999999",
    },
  });

  assert.equal(oversizedRangeResponse.status, 206);
  assert.equal(oversizedRangeResponse.headers.get("content-range"), "bytes 0-9/10");
  assert.equal(await oversizedRangeResponse.text(), "0123456789");

  const traversalResponse = await fetch(`http://127.0.0.1:${port}/api/stream/..%2Fclip.mp4`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(traversalResponse.status, 400);

  const invalidRangeResponse = await fetch(`http://127.0.0.1:${port}/api/stream/clip.mp4`, {
    headers: {
      Cookie: sessionCookie,
      Range: "bytes=100-200",
    },
  });
  assert.equal(invalidRangeResponse.status, 416);
  assert.equal(invalidRangeResponse.headers.get("content-range"), "bytes */10");
});

test("surfaces movie library load failures in the status message", async () => {
  const movieSelect = {
    value: "",
    innerHTML: "",
    addEventListener() {},
    appendChild() {},
  };
  const reloadButton = { addEventListener() {} };
  const logoutButton = { addEventListener() {} };
  const passwordForm = { addEventListener() {} };
  const passwordInput = {
    value: "",
    addEventListener() {},
    removeAttribute() {},
    select() {},
    setAttribute() {},
  };
  const submitButton = { disabled: false };
  const player = {
    currentSrc: "",
    load() {},
    addEventListener() {},
    removeAttribute() {},
  };
  const status = { textContent: "" };
  const loginStatus = { focus() {}, textContent: "" };
  const authPanel = { hidden: false };
  const libraryPanel = { hidden: true };

  const app = createApp({
    movieSelect,
    reloadButton,
    logoutButton,
    passwordForm,
    passwordInput,
    submitButton,
    player,
    status,
    loginStatus,
    authPanel,
    libraryPanel,
    fetchImpl: async (url) => {
      if (url === "/api/session") {
        return { ok: true, status: 200, json: async () => ({ authenticated: true }) };
      }
      return { ok: false, status: 500, json: async () => ({ error: "Unable to load movie library." }) };
    },
    locationOrigin: "http://127.0.0.1:3000",
    createOption: () => ({}),
  });

  app.initialize();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(status.textContent, "Unable to load movie library.");
});

test("returns 403 for unreadable movie streams on HEAD requests", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX-style permission checks are not reliable on Windows.");
  }

  const { root, moviesDir, publicDir } = createTempLibrary();
  const moviePath = path.join(moviesDir, "locked.mp4");
  fs.writeFileSync(moviePath, "0123456789");
  fs.chmodSync(moviePath, 0o000);

  const server = await startServer(createAuthOptions({ moviesDir, publicDir }));

  t.after(() => {
    server.close();
    fs.chmodSync(moviePath, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const authResponse = await login(port);
  const sessionCookie = authResponse.headers.get("set-cookie");
  const response = await fetch(`http://127.0.0.1:${port}/api/stream/locked.mp4`, {
    method: "HEAD",
    headers: { Cookie: sessionCookie },
  });

  assert.equal(response.status, 403);
});

test("recursively lists OneDrive items and resolves fresh playback links", async () => {
  const store = new MemoryStore();
  const requests = [];

  const provider = createOneDriveProvider({
    env: {
      ONEDRIVE_CLIENT_ID: "client-id",
      ONEDRIVE_CLIENT_SECRET: "client-secret",
      ONEDRIVE_REDIRECT_URI: "http://localhost/callback",
      ONEDRIVE_REFRESH_TOKEN: "refresh-token",
      ONEDRIVE_DRIVE_ID: "drive-id",
      ONEDRIVE_ROOT_ITEM_ID: "root-item",
    },
    store,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });

      if (String(url).includes("/oauth2/v2.0/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "access-token",
            expires_in: 3600,
            refresh_token: "rotated-token",
          }),
        };
      }

      if (String(url).includes("/children")) {
        if (String(url).includes("/root-item/children")) {
          return {
            ok: true,
            json: async () => ({
              value: [
                { id: "folder-1", name: "Collections", folder: {} },
                { id: "movie-1", name: "Movie-One.mp4", file: {}, size: 1024 },
              ],
            }),
          };
        }

        return {
          ok: true,
          json: async () => ({
            value: [
              { id: "movie-2", name: "Movie-Two.mkv", file: {}, size: 2048 },
            ],
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          id: "movie-1",
          name: "Movie-One.mp4",
          file: {},
          "@microsoft.graph.downloadUrl": "https://download.example/movie-one",
        }),
      };
    },
  });

  const movies = await provider.listMovies();
  assert.deepEqual(
    movies.map((movie) => ({ title: movie.title, folder: movie.folder })),
    [
      { title: "Movie One", folder: "" },
      { title: "Movie Two", folder: "Collections" },
    ],
  );

  const playback = await provider.resolvePlayback("movie-1");
  assert.deepEqual(playback, {
    url: "https://download.example/movie-one",
    expiresAt: null,
  });
  assert.equal(await store.get("onedrive:refresh-token"), "rotated-token");
  assert.match(requests[0].url, /oauth2\/v2\.0\/token/);
});

test("surfaces a OneDrive token refresh failure", async () => {
  const provider = createOneDriveProvider({
    env: {
      ONEDRIVE_CLIENT_ID: "client-id",
      ONEDRIVE_CLIENT_SECRET: "client-secret",
      ONEDRIVE_REDIRECT_URI: "http://localhost/callback",
      ONEDRIVE_REFRESH_TOKEN: "refresh-token",
      ONEDRIVE_DRIVE_ID: "drive-id",
      ONEDRIVE_ROOT_ITEM_ID: "root-item",
    },
    store: new MemoryStore(),
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "bad_request" }),
    }),
  });

  await assert.rejects(
    provider.listMovies(),
    /refresh token exchange failed/i,
  );
});

test("rejects a OneDrive playback response without a usable file url", async () => {
  const provider = createOneDriveProvider({
    env: {
      ONEDRIVE_CLIENT_ID: "client-id",
      ONEDRIVE_CLIENT_SECRET: "client-secret",
      ONEDRIVE_REDIRECT_URI: "http://localhost/callback",
      ONEDRIVE_REFRESH_TOKEN: "refresh-token",
      ONEDRIVE_DRIVE_ID: "drive-id",
      ONEDRIVE_ROOT_ITEM_ID: "root-item",
    },
    store: new MemoryStore(),
    fetchImpl: async (url) => {
      if (String(url).includes("/oauth2/v2.0/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "access-token",
            expires_in: 3600,
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          id: "movie-1",
          name: "Movie-One.mp4",
          file: {},
        }),
      };
    },
  });

  await assert.rejects(
    provider.resolvePlayback("movie-1"),
    /did not return a playback url/i,
  );
});
