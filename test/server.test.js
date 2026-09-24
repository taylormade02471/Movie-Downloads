const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createServer } = require("../server");
const { createApp } = require("../public/app");

function createTempLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "movie-room-"));
  const moviesDir = path.join(root, "movies");
  const publicDir = path.join(root, "public");
  fs.mkdirSync(moviesDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "index.html"), "<h1>Movie Room</h1>");
  fs.writeFileSync(path.join(publicDir, "app.js"), "console.log('ok');");
  return { root, moviesDir, publicDir };
}

test("lists movies and serves the watch page", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "Family-Night.mp4"), "abcdef");

  const server = createServer({ moviesDir, publicDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Movie Room/);

  const moviesResponse = await fetch(`http://127.0.0.1:${port}/api/movies`);
  assert.equal(moviesResponse.status, 200);

  const movies = await moviesResponse.json();
  assert.deepEqual(
    movies.map((movie) => movie.title),
    ["Family Night"],
  );
  assert.equal(movies[0].streamPath, "/api/stream/Family-Night.mp4");
});

test("supports partial content requests for background buffering and seeking", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "clip.mp4"), "0123456789");

  const server = createServer({ moviesDir, publicDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/stream/clip.mp4`, {
    headers: { Range: "bytes=2-5" },
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await response.text(), "2345");
});

test("supports suffix byte ranges and HEAD range probes", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "clip.mp4"), "0123456789");

  const server = createServer({ moviesDir, publicDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const suffixResponse = await fetch(`http://127.0.0.1:${port}/api/stream/clip.mp4`, {
    headers: { Range: "bytes=-4" },
  });

  assert.equal(suffixResponse.status, 206);
  assert.equal(suffixResponse.headers.get("content-range"), "bytes 6-9/10");
  assert.equal(await suffixResponse.text(), "6789");

  const headResponse = await fetch(`http://127.0.0.1:${port}/api/stream/clip.mp4`, {
    method: "HEAD",
    headers: { Range: "bytes=2-5" },
  });

  assert.equal(headResponse.status, 206);
  assert.equal(headResponse.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(headResponse.headers.get("content-length"), "4");
  assert.equal(await headResponse.text(), "");
});

test("clamps oversized ranges and rejects traversal attempts", async (t) => {
  const { root, moviesDir, publicDir } = createTempLibrary();
  fs.writeFileSync(path.join(moviesDir, "clip.mp4"), "0123456789");

  const server = createServer({ moviesDir, publicDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const oversizedRangeResponse = await fetch(`http://127.0.0.1:${port}/api/stream/clip.mp4`, {
    headers: { Range: "bytes=0-999999" },
  });

  assert.equal(oversizedRangeResponse.status, 206);
  assert.equal(oversizedRangeResponse.headers.get("content-range"), "bytes 0-9/10");
  assert.equal(await oversizedRangeResponse.text(), "0123456789");

  const traversalResponse = await fetch(`http://127.0.0.1:${port}/api/stream/..%2Fclip.mp4`);
  assert.equal(traversalResponse.status, 400);

  const invalidRangeResponse = await fetch(`http://127.0.0.1:${port}/api/stream/clip.mp4`, {
    headers: { Range: "bytes=100-200" },
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
  const player = {
    currentSrc: "",
    load() {},
    addEventListener() {},
    removeAttribute() {},
  };
  const status = { textContent: "" };

  const app = createApp({
    movieSelect,
    reloadButton,
    player,
    status,
    fetchImpl: async () => ({ ok: false }),
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

  const server = createServer({ moviesDir, publicDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(() => {
    server.close();
    fs.chmodSync(moviePath, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/stream/locked.mp4`, {
    method: "HEAD",
  });

  assert.equal(response.status, 403);
});
