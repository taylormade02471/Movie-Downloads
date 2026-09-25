const test = require("node:test");
const assert = require("node:assert/strict");

const { MemoryStore } = require("../lib/store");
const {
  applyViewerOperations,
  createDefaultViewerState,
  createViewerStateManager,
  deriveContinueWatching,
  deriveHistory,
  normalizeViewerState,
} = require("../lib/viewer-state");

const movies = [
  { id: "movie-1", title: "Movie One" },
  { id: "movie-2", title: "Movie Two" },
];

test("creates a versioned empty viewer state", () => {
  assert.deepEqual({ ...createDefaultViewerState("family", 1_000), movies: {} }, {
    schemaVersion: 1,
    profileId: "family",
    revision: 0,
    updatedAt: 1_000,
    settings: {
      autoplayNext: false,
      resumeEnabled: true,
      hideCompleted: false,
    },
    movies: {},
    queue: [],
  });
});

test("applies progress, flags, queue, and settings operations", () => {
  const initial = createDefaultViewerState("family", 1_000);
  const result = applyViewerOperations(initial, [
    {
      type: "progress",
      movieId: "movie-1",
      positionSeconds: 120,
      durationSeconds: 600,
      playbackStatus: "paused",
    },
    { type: "setFlag", movieId: "movie-1", flag: "favorite", value: true },
    { type: "setFlag", movieId: "movie-1", flag: "watchLater", value: true },
    { type: "queueAdd", movieId: "movie-2" },
    { type: "settings", values: { autoplayNext: true } },
  ], { movieIds: new Set(["movie-1", "movie-2"]), now: 2_000 });

  assert.equal(result.changed, true);
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.movies["movie-1"].positionSeconds, 120);
  assert.equal(result.state.movies["movie-1"].favorite, true);
  assert.equal(result.state.movies["movie-1"].watchLater, true);
  assert.deepEqual(result.state.queue, ["movie-2"]);
  assert.equal(result.state.settings.autoplayNext, true);
  assert.equal(result.state.updatedAt, 2_000);
});

test("completion is explicit and late progress does not clear it", () => {
  let state = createDefaultViewerState("home", 1_000);
  state = applyViewerOperations(state, [
    { type: "progress", movieId: "movie-1", positionSeconds: 590, durationSeconds: 600 },
    { type: "setCompleted", movieId: "movie-1", value: true },
  ], { movieIds: new Set(["movie-1"]), now: 2_000 }).state;

  state = applyViewerOperations(state, [
    { type: "progress", movieId: "movie-1", positionSeconds: 100, durationSeconds: 600 },
  ], { movieIds: new Set(["movie-1"]), now: 3_000 }).state;

  assert.ok(state.movies["movie-1"].completedAt);
  assert.equal(state.movies["movie-1"].positionSeconds, 100);
});

test("derives continue watching and history without completed titles", () => {
  let state = createDefaultViewerState("family", 1_000);
  state = applyViewerOperations(state, [
    { type: "progress", movieId: "movie-1", positionSeconds: 120, durationSeconds: 600 },
  ], { movieIds: new Set(["movie-1", "movie-2"]), now: 1_500 }).state;
  state = applyViewerOperations(state, [
    { type: "progress", movieId: "movie-2", positionSeconds: 590, durationSeconds: 600 },
    { type: "setCompleted", movieId: "movie-2", value: true },
  ], { movieIds: new Set(["movie-1", "movie-2"]), now: 2_000 }).state;

  assert.deepEqual(deriveContinueWatching(state, movies).map((movie) => movie.id), ["movie-1"]);
  assert.deepEqual(deriveHistory(state, movies).map((movie) => movie.id), ["movie-2", "movie-1"]);
});

test("rejects unknown movies, invalid numbers, and dangerous keys", () => {
  const initial = createDefaultViewerState("guest", 1_000);
  assert.throws(
    () => applyViewerOperations(initial, [{ type: "queueAdd", movieId: "missing" }], {
      movieIds: new Set(["movie-1"]),
      now: 1_000,
    }),
    /unknown movie/i,
  );
  assert.throws(
    () => applyViewerOperations(initial, [{ type: "progress", movieId: "__proto__", positionSeconds: 1, durationSeconds: 2 }], {
      movieIds: new Set(["__proto__"]),
      now: 1_000,
    }),
    /invalid movie/i,
  );
  assert.throws(
    () => applyViewerOperations(initial, [{ type: "progress", movieId: "movie-1", positionSeconds: Infinity, durationSeconds: 2 }], {
      movieIds: new Set(["movie-1"]),
      now: 1_000,
    }),
    /finite/i,
  );
});

test("normalizes corrupt or cross-profile state to a safe snapshot", () => {
  const normalized = normalizeViewerState("not-json", "home", 4_000);
  assert.equal(normalized.profileId, "home");
  assert.equal(normalized.updatedAt, 4_000);
  assert.deepEqual(normalized.queue, []);

  const otherProfile = normalizeViewerState(JSON.stringify({
    schemaVersion: 1,
    profileId: "family",
    revision: 4,
    updatedAt: 2_000,
    settings: {},
    movies: {},
    queue: [],
  }), "home", 4_000);
  assert.equal(otherProfile.profileId, "home");
  assert.equal(otherProfile.revision, 0);
});

test("viewer-state manager isolates profiles and retries concurrent updates", async () => {
  let now = 10_000;
  const store = new MemoryStore(() => now);
  const manager = createViewerStateManager({
    store,
    listMovies: async () => movies,
    now: () => now,
    durable: true,
  });

  await Promise.all([
    manager.apply("home", [{ type: "queueAdd", movieId: "movie-1" }]),
    manager.apply("home", [{ type: "queueAdd", movieId: "movie-2" }]),
  ]);
  await manager.apply("family", [{ type: "queueAdd", movieId: "movie-2" }]);

  const home = await manager.get("home");
  const family = await manager.get("family");
  assert.deepEqual(home.queue.sort(), ["movie-1", "movie-2"]);
  assert.deepEqual(family.queue, ["movie-2"]);
});
