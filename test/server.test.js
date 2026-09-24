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
  assert.match(
    pageResponse.headers.get("permissions-policy") || "",
    /screen-wake-lock=\(self\)/,
  );

  const moviesResponse = await fetch(`http://127.0.0.1:${port}/api/movies`);
  assert.equal(moviesResponse.status, 401);
});

test("preloads the selected movie for smoother in-page playback", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /<video[\s\S]*preload="auto"[\s\S]*><\/video>/);
  assert.doesNotMatch(html, /preload="metadata"/);
});

test("exposes phone and TV playback controls", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /id="cast-tv"/);
  assert.match(html, /id="keep-awake"/);
  assert.match(html, /id="fullscreen-player"/);
  assert.match(html, /x-webkit-airplay="allow"/);
  assert.match(html, /webkit-playsinline/);
  assert.match(html, /id="buffer-status"/);
  assert.match(html, /id="permission-panel"/);
  assert.match(html, /id="enable-permissions"/);
  assert.match(html, /id="skip-permissions"/);
  assert.doesNotMatch(html, /disableremoteplayback/i);
});

test("configures Vercel media permissions for static pages", () => {
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  const permissionsHeader = vercelConfig.headers
    .flatMap((entry) => entry.headers)
    .find((header) => header.key.toLowerCase() === "permissions-policy");

  assert.match(permissionsHeader.value, /screen-wake-lock=\(self\)/);
  assert.match(permissionsHeader.value, /bluetooth=\(self\)/);
  assert.match(permissionsHeader.value, /fullscreen=\(self\)/);
  assert.match(permissionsHeader.value, /local-network=\(self\)/);
  assert.match(permissionsHeader.value, /local-network-access=\(self\)/);
  assert.match(permissionsHeader.value, /loopback-network=\(self\)/);
  assert.match(permissionsHeader.value, /picture-in-picture=\(self\)/);
  assert.match(permissionsHeader.value, /presentation=\(self\)/);
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

  const vercelPlaybackResponse = await fetch(`http://127.0.0.1:${port}/api/playback`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      "Content-Type": "application/json",
      Origin: `http://127.0.0.1:${port}`,
    },
    body: JSON.stringify({ movieId: movies[0].id }),
  });
  assert.equal(vercelPlaybackResponse.status, 200);
  assert.deepEqual(await vercelPlaybackResponse.json(), {
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

test("returns folder previews including empty hidden local folders", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.mkdirSync(path.join(moviesDir, ".Hidden Uploads"), { recursive: true });
  fs.mkdirSync(path.join(moviesDir, "Coming Soon"), { recursive: true });
  fs.writeFileSync(path.join(moviesDir, "Coming Soon", "Ready.mp4"), "abcdef");

  const server = await startServer(createAuthOptions({ moviesDir, publicDir }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const authResponse = await login(port);
  const sessionCookie = authResponse.headers.get("set-cookie");

  const libraryResponse = await fetch(`http://127.0.0.1:${port}/api/library`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(libraryResponse.status, 200);

  const library = await libraryResponse.json();
  assert.deepEqual(
    library.movies.map((movie) => ({ title: movie.title, folder: movie.folder, extension: movie.extension })),
    [{ title: "Ready", folder: "Coming Soon", extension: ".mp4" }],
  );
  assert.deepEqual(
    library.folders.map((folder) => ({
      path: folder.path,
      hidden: folder.hidden,
      movieCount: folder.movieCount,
      playableCount: folder.playableCount,
    })),
    [
      { path: ".Hidden Uploads", hidden: true, movieCount: 0, playableCount: 0 },
      { path: "Collections", hidden: false, movieCount: 0, playableCount: 0 },
      { path: "Coming Soon", hidden: false, movieCount: 1, playableCount: 1 },
    ],
  );
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

test("fails closed on Vercel when durable session storage is not configured", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  const server = await startServer(createAuthOptions({
    moviesDir,
    publicDir,
    env: {
      MOVIE_PROVIDER: "local",
      VERCEL: "1",
    },
  }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/session`);
  assert.equal(sessionResponse.status, 200);
  assert.deepEqual(await sessionResponse.json(), {
    authenticated: false,
    authConfigured: false,
    expiresAt: null,
    provider: "local",
  });

  const loginResponse = await login(port);
  assert.equal(loginResponse.status, 503);
});

test("accepts Vercel Marketplace Upstash credentials as durable session storage", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  const server = await startServer(createAuthOptions({
    moviesDir,
    publicDir,
    env: {
      MOVIE_PROVIDER: "local",
      VERCEL: "1",
      UPSTASH_REDIS_REST_URL: "https://redis.example",
      UPSTASH_REDIS_REST_TOKEN: "upstash-token",
    },
  }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/session`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authConfigured, true);
});

test("fails closed when the session signing secret is too short", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  const server = await startServer(createAuthOptions({
    moviesDir,
    publicDir,
    auth: { sessionSecret: "too-short" },
  }));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/session`);
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).authConfigured, false);
  assert.equal((await login(port)).status, 503);
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

test("starts the selected movie after a successful login", async () => {
  const movieSelect = {
    value: "",
    innerHTML: "",
    disabled: true,
    addEventListener() {},
    appendChild(option) {
      if (!this.value) {
        this.value = option.value;
      }
    },
  };
  const reloadButton = { addEventListener() {} };
  const logoutButton = { addEventListener() {} };
  const passwordForm = { addEventListener() {} };
  const passwordInput = {
    value: "lowercase",
    disabled: false,
    removeAttribute() {},
    select() {},
    setAttribute() {},
  };
  const submitButton = { disabled: false };
  const player = {
    src: "",
    load() {},
    addEventListener() {},
    removeAttribute() {},
  };
  const status = { textContent: "" };
  const loginStatus = { focus() {}, textContent: "" };
  const authPanel = { hidden: false };
  const libraryPanel = { hidden: true };
  const requests = [];

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
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "/api/login") {
        return { ok: true, status: 204 };
      }
      if (url === "/api/library") {
        return {
          ok: true,
          status: 200,
          json: async () => ([
            { id: "movie-1", title: "Movie One", folder: "", size: 1024 },
          ]),
        };
      }
      if (url === "/api/playback") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: "https://download.example/movie-1" }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    locationOrigin: "http://127.0.0.1:3000",
    createOption: () => ({}),
  });

  await app.handleLogin({ preventDefault() {} });

  assert.equal(player.src, "https://download.example/movie-1");
  assert.equal(status.textContent, "Loading video ahead for smooth playback…");
  assert.deepEqual(
    requests.map((request) => request.url),
    ["/api/login", "/api/library", "/api/playback"],
  );
  assert.equal(requests[2].options.method, "POST");
  assert.equal(requests[2].options.body, JSON.stringify({ movieId: "movie-1" }));
});

test("refreshes a temporary playback link once after a player error", async () => {
  const listeners = {};
  let resumedPlayCalls = 0;
  const movieSelect = {
    value: "",
    innerHTML: "",
    disabled: true,
    addEventListener(name, listener) {
      listeners[`select:${name}`] = listener;
    },
    appendChild(option) {
      if (!this.value) {
        this.value = option.value;
      }
    },
  };
  const reloadButton = { addEventListener() {} };
  const logoutButton = { addEventListener() {} };
  const passwordForm = { addEventListener() {} };
  const passwordInput = {
    value: "",
    disabled: false,
    removeAttribute() {},
    select() {},
    setAttribute() {},
  };
  const submitButton = { disabled: false };
  const player = {
    src: "",
    error: { code: 2 },
    currentTime: 42,
    duration: 120,
    paused: false,
    ended: false,
    load() {},
    play: async () => {
      resumedPlayCalls += 1;
    },
    addEventListener(name, listener) {
      listeners[`player:${name}`] = listener;
    },
    removeAttribute() {},
  };
  const status = { textContent: "" };
  const loginStatus = { focus() {}, textContent: "" };
  const authPanel = { hidden: false };
  const libraryPanel = { hidden: true };
  let playbackRequests = 0;

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
    fetchImpl: async (url, options = {}) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ authenticated: true, authConfigured: true }),
        };
      }
      if (url === "/api/library") {
        return {
          ok: true,
          status: 200,
          json: async () => ([
            { id: "movie-1", title: "Movie One", folder: "", size: 1024 },
          ]),
        };
      }
      if (url === "/api/playback") {
        assert.equal(options.method, "POST");
        assert.equal(options.body, JSON.stringify({ movieId: "movie-1" }));
        playbackRequests += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: `https://download.example/movie-1-${playbackRequests}` }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    locationOrigin: "http://127.0.0.1:3000",
    createOption: () => ({}),
    maxPlaybackRefreshes: 1,
  });

  app.initialize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(player.src, "https://download.example/movie-1-1");

  listeners["player:error"]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(player.src, "https://download.example/movie-1-2");
  assert.equal(playbackRequests, 2);

  player.currentTime = 0;
  listeners["player:loadedmetadata"]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(player.currentTime, 42);
  assert.equal(resumedPlayCalls, 1);

  listeners["player:error"]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(playbackRequests, 2);
  assert.equal(status.textContent, "This movie could not keep a stable streaming connection.");
});

test("selects an uploaded movie and labels unfinished OneDrive entries", async () => {
  const options = [];
  const movieSelect = {
    value: "",
    innerHTML: "",
    disabled: true,
    appendChild(option) {
      options.push(option);
      if (!this.value) {
        this.value = option.value;
      }
    },
  };
  const player = {
    load() {},
    removeAttribute() {},
  };
  const status = { textContent: "" };

  const app = createApp({
    movieSelect,
    reloadButton: {},
    logoutButton: {},
    passwordForm: {},
    passwordInput: {},
    player,
    status,
    loginStatus: {},
    authPanel: {},
    libraryPanel: {},
    fetchImpl: async (url) => {
      assert.equal(url, "/api/library");
      return {
        ok: true,
        status: 200,
        json: async () => ([
          { id: "uploading", title: "Movie Uploading", folder: "", size: 0 },
          { id: "ready", title: "Movie Ready", folder: "", size: 1639238719 },
        ]),
      };
    },
    locationOrigin: "http://127.0.0.1:3000",
    createOption: () => ({}),
  });

  const playableMovies = await app.loadLibrary();

  assert.equal(playableMovies.length, 1);
  assert.equal(movieSelect.value, "ready");
  assert.equal(movieSelect.disabled, false);
  assert.equal(options[0].disabled, true);
  assert.match(options[0].textContent, /still uploading/i);
  assert.equal(options[1].disabled, false);
});

test("shows Chrome cast guidance when browser cast APIs are unavailable", async () => {
  const listeners = {};
  const player = {
    disableRemotePlayback: true,
    addEventListener() {},
    load() {},
    removeAttribute() {},
    setAttribute() {},
  };
  const status = { textContent: "" };
  const castButton = {
    disabled: true,
    textContent: "",
    addEventListener(name, listener) {
      listeners[name] = listener;
    },
  };

  const app = createApp({
    movieSelect: { value: "", addEventListener() {} },
    reloadButton: { addEventListener() {} },
    logoutButton: { addEventListener() {} },
    searchInput: { disabled: false, addEventListener() {} },
    passwordForm: { addEventListener() {} },
    passwordInput: { disabled: false, removeAttribute() {}, setAttribute() {} },
    submitButton: { disabled: false },
    player,
    status,
    bufferStatus: { textContent: "", style: { setProperty() {} } },
    loginStatus: { textContent: "" },
    librarySummary: { textContent: "" },
    folderShelf: { replaceChildren() {}, ownerDocument: { createElement: () => ({ addEventListener() {} }) } },
    movieGrid: { replaceChildren() {}, ownerDocument: { createElement: () => ({ append() {}, addEventListener() {}, dataset: {} }) } },
    castButton,
    keepAwakeButton: { addEventListener() {} },
    fullscreenButton: { addEventListener() {} },
    authPanel: { hidden: false },
    libraryPanel: { hidden: true },
    fetchImpl: async (url) => {
      if (url === "/api/session") {
        return { ok: true, status: 200, json: async () => ({ authenticated: false, authConfigured: true }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    locationOrigin: "http://127.0.0.1:3000",
    createOption: () => ({}),
    documentRef: { addEventListener() {}, visibilityState: "visible" },
    navigatorRef: {
      userAgent: "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
      vendor: "Google Inc.",
    },
  });

  app.initialize();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(player.disableRemotePlayback, false);
  assert.equal(castButton.textContent, "Chrome Cast Help");
  listeners.click();
  assert.match(status.textContent, /local network or Bluetooth access/i);
});

test("shows a first-run permission setup panel and saves the choice", async () => {
  const listeners = {};
  const localStorageValues = new Map();
  let locationRequests = 0;
  let bluetoothRequests = 0;
  const permissionPanel = { hidden: true };
  const enablePermissionsButton = {
    disabled: false,
    addEventListener(name, listener) {
      listeners[`allow:${name}`] = listener;
    },
  };
  const player = {
    disableRemotePlayback: true,
    addEventListener() {},
    load() {},
    removeAttribute() {},
    setAttribute() {},
  };

  const app = createApp({
    movieSelect: { value: "", addEventListener() {} },
    reloadButton: { addEventListener() {} },
    logoutButton: { addEventListener() {} },
    searchInput: { disabled: false, addEventListener() {} },
    passwordForm: { addEventListener() {} },
    passwordInput: { disabled: false, removeAttribute() {}, setAttribute() {} },
    submitButton: { disabled: false },
    player,
    status: { textContent: "" },
    bufferStatus: { textContent: "", style: { setProperty() {} } },
    loginStatus: { textContent: "" },
    librarySummary: { textContent: "" },
    folderShelf: { replaceChildren() {}, ownerDocument: { createElement: () => ({ addEventListener() {} }) } },
    movieGrid: { replaceChildren() {}, ownerDocument: { createElement: () => ({ append() {}, addEventListener() {}, dataset: {} }) } },
    permissionPanel,
    enablePermissionsButton,
    skipPermissionsButton: { addEventListener() {} },
    permissionStatus: { textContent: "" },
    castButton: { addEventListener() {} },
    keepAwakeButton: { addEventListener() {} },
    fullscreenButton: { addEventListener() {} },
    authPanel: { hidden: false },
    libraryPanel: { hidden: true },
    fetchImpl: async (url) => {
      if (url === "/api/session") {
        return { ok: true, status: 200, json: async () => ({ authenticated: false, authConfigured: true }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    locationOrigin: "http://127.0.0.1:3000",
    createOption: () => ({}),
    documentRef: { addEventListener() {}, visibilityState: "visible" },
    navigatorRef: {
      bluetooth: {
        async requestDevice() {
          bluetoothRequests += 1;
          return {};
        },
      },
      geolocation: {
        getCurrentPosition(success) {
          locationRequests += 1;
          success({});
        },
      },
      userAgent: "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
      vendor: "Google Inc.",
    },
    localStorageRef: {
      getItem(key) {
        return localStorageValues.get(key) || null;
      },
      setItem(key, value) {
        localStorageValues.set(key, value);
      },
    },
  });

  app.initialize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(permissionPanel.hidden, false);

  listeners["allow:click"]();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(permissionPanel.hidden, true);
  assert.equal(locationRequests, 1);
  assert.equal(bluetoothRequests, 1);
  assert.equal(localStorageValues.get("movie_room_permissions_v1"), "done");
});

test("refreshes and resumes a stream after a sustained stall", async () => {
  const listeners = {};
  const timers = [];
  let resumedPlayCalls = 0;
  let playbackRequests = 0;
  let resolveRefreshResponse;
  const movieSelect = {
    value: "",
    innerHTML: "",
    disabled: true,
    addEventListener(name, listener) {
      listeners[`select:${name}`] = listener;
    },
    appendChild(option) {
      if (!this.value) {
        this.value = option.value;
      }
    },
  };
  const player = {
    src: "",
    currentTime: 42,
    duration: 120,
    paused: false,
    ended: false,
    buffered: { length: 0 },
    load() {},
    play: async () => {
      resumedPlayCalls += 1;
    },
    addEventListener(name, listener) {
      listeners[`player:${name}`] = listener;
    },
    removeAttribute() {},
  };

  const app = createApp({
    movieSelect,
    reloadButton: { addEventListener() {} },
    logoutButton: { addEventListener() {} },
    passwordForm: { addEventListener() {} },
    passwordInput: {
      disabled: false,
      removeAttribute() {},
      setAttribute() {},
    },
    submitButton: { disabled: false },
    player,
    status: { textContent: "" },
    loginStatus: { textContent: "" },
    authPanel: { hidden: false },
    libraryPanel: { hidden: true },
    fetchImpl: async (url, options = {}) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ authenticated: true, authConfigured: true }),
        };
      }
      if (url === "/api/library") {
        return {
          ok: true,
          status: 200,
          json: async () => ([
            { id: "movie-1", title: "Movie One", folder: "", size: 1024 },
          ]),
        };
      }
      if (url === "/api/playback") {
        assert.equal(options.body, JSON.stringify({ movieId: "movie-1" }));
        playbackRequests += 1;
        if (playbackRequests === 2) {
          return new Promise((resolve) => {
            resolveRefreshResponse = () => resolve({
              ok: true,
              status: 200,
              json: async () => ({ url: "https://download.example/movie-1-2" }),
            });
          });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ url: `https://download.example/movie-1-${playbackRequests}` }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    locationOrigin: "http://127.0.0.1:3000",
    createOption: () => ({}),
    setTimeoutImpl: (callback, delay) => {
      assert.equal(delay, 12000);
      timers.push(callback);
      return timers.length;
    },
    clearTimeoutImpl() {},
  });

  app.initialize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(playbackRequests, 1);

  listeners["player:waiting"]();
  listeners["player:stalled"]();
  assert.equal(timers.length, 1);

  timers[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(playbackRequests, 2);
  assert.equal(typeof resolveRefreshResponse, "function");

  player.currentTime = 5;
  listeners["player:loadedmetadata"]();
  assert.equal(player.currentTime, 5);
  assert.equal(resumedPlayCalls, 0);

  resolveRefreshResponse();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(player.src, "https://download.example/movie-1-2");

  player.currentTime = 0;
  listeners["player:loadedmetadata"]();
  assert.equal(player.currentTime, 42);
  assert.equal(resumedPlayCalls, 1);
});

test("ignores a superseded playback failure after a newer movie loads", async () => {
  let rejectOldPlayback;
  const movieSelect = { value: "movie-old" };
  const player = {
    src: "",
    load() {},
  };
  const status = { textContent: "" };

  const app = createApp({
    movieSelect,
    reloadButton: {},
    logoutButton: {},
    passwordForm: {},
    passwordInput: {},
    player,
    status,
    loginStatus: {},
    authPanel: {},
    libraryPanel: {},
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/playback");
      const { movieId } = JSON.parse(options.body);
      if (movieId === "movie-old") {
        return new Promise((resolve, reject) => {
          rejectOldPlayback = reject;
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ url: "https://download.example/movie-new" }),
      };
    },
    locationOrigin: "http://127.0.0.1:3000",
    createOption: () => ({}),
  });

  const oldRequest = app.playSelectedMovie();
  movieSelect.value = "movie-new";
  assert.equal(await app.playSelectedMovie(), true);
  assert.equal(player.src, "https://download.example/movie-new");

  rejectOldPlayback(new Error("Old stream failed"));
  assert.equal(await oldRequest, false);
  assert.equal(player.src, "https://download.example/movie-new");
  assert.equal(status.textContent, "Loading video ahead for smooth playback…");
});

test("returns 403 for unreadable movie streams on HEAD requests", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX-style permission checks are not reliable on Windows.");
    return;
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
  assert.equal(requests[0].options.body.get("scope"), "offline_access Files.Read");
});

test("uses the OneDrive content redirect when a file response omits its download URL", async () => {
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
      const requestUrl = String(url);

      if (requestUrl.includes("/oauth2/v2.0/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "access-token", expires_in: 3600 }),
        };
      }

      if (requestUrl.includes("/root-item/children")) {
        return {
          ok: true,
          json: async () => ({
            value: [{ id: "movie-1", name: "Movie-One.mp4", file: {} }],
          }),
        };
      }

      if (requestUrl.includes("/items/movie-1/content")) {
        return {
          status: 302,
          headers: new Headers({ Location: "https://download.example/movie-one" }),
        };
      }

      return {
        ok: true,
        json: async () => ({ id: "movie-1", name: "Movie-One.mp4", file: {} }),
      };
    },
  });

  const playback = await provider.resolvePlayback("movie-1");
  assert.deepEqual(playback, {
    url: "https://download.example/movie-one",
    expiresAt: null,
  });
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

test("refreshes and retries once when Microsoft Graph rejects a cached access token", async () => {
  let tokenRequests = 0;
  let childrenRequests = 0;

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
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("/oauth2/v2.0/token")) {
        tokenRequests += 1;
        return {
          ok: true,
          json: async () => ({
            access_token: `access-token-${tokenRequests}`,
            expires_in: 3600,
          }),
        };
      }

      childrenRequests += 1;
      if (childrenRequests === 2 && options.headers.Authorization === "Bearer access-token-1") {
        return { ok: false, status: 401 };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            { id: "movie-1", name: "Movie-One.mp4", file: {}, size: 1024 },
          ],
        }),
      };
    },
  });

  assert.equal((await provider.listMovies()).length, 1);
  assert.equal((await provider.listMovies()).length, 1);
  assert.equal(tokenRequests, 2);
  assert.equal(childrenRequests, 3);
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

      if (String(url).includes("/children")) {
        return {
          ok: true,
          json: async () => ({
            value: [
              { id: "movie-1", name: "Movie-One.mp4", file: {}, size: 1024 },
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
        }),
      };
    },
  });

  await assert.rejects(
    provider.resolvePlayback("movie-1"),
    /did not return a playback url/i,
  );
});

test("rejects OneDrive playback ids outside the configured movie folder", async () => {
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
      const requestUrl = String(url);

      if (requestUrl.includes("/oauth2/v2.0/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "access-token",
            expires_in: 3600,
          }),
        };
      }

      if (requestUrl.includes("/root-item/children")) {
        return {
          ok: true,
          json: async () => ({
            value: [
              { id: "allowed-movie", name: "Allowed.mp4", file: {}, size: 1024 },
            ],
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          id: "outside-movie",
          name: "Private-Outside-Folder.mp4",
          file: {},
          "@microsoft.graph.downloadUrl": "https://download.example/private",
        }),
      };
    },
  });

  await assert.rejects(
    provider.resolvePlayback("outside-movie"),
    /not in the configured movie folder/i,
  );
});
