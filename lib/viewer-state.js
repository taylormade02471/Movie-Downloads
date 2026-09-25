const VIEWER_STATE_PREFIX = "viewer-state:v1:";
const PROFILE_IDS = new Set(["home", "family", "guest"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_OPERATIONS = 100;
const MAX_QUEUE_LENGTH = 100;
const MAX_MOVIE_RECORDS = 500;
const MAX_SNAPSHOT_BYTES = 250_000;
const SETTINGS_DEFAULTS = {
  autoplayNext: false,
  resumeEnabled: true,
  hideCompleted: false,
};

function normalizeProfileId(profileId) {
  const normalized = String(profileId || "").trim().toLowerCase();
  if (!PROFILE_IDS.has(normalized)) {
    throw new Error("A valid viewer profile is required.");
  }
  return normalized;
}

function assertMovieId(movieId) {
  if (typeof movieId !== "string" || !movieId.trim() || movieId.length > 240 || DANGEROUS_KEYS.has(movieId)) {
    throw new Error("Invalid movie ID.");
  }
  return movieId;
}

function safeMovieMap() {
  return Object.create(null);
}

function cloneMovieRecord(record) {
  return {
    positionSeconds: Number.isFinite(record && record.positionSeconds)
      ? Math.max(0, record.positionSeconds)
      : 0,
    durationSeconds: Number.isFinite(record && record.durationSeconds)
      ? Math.max(0, record.durationSeconds)
      : 0,
    lastWatchedAt: Number.isFinite(record && record.lastWatchedAt)
      ? Math.max(0, record.lastWatchedAt)
      : 0,
    completedAt: Number.isFinite(record && record.completedAt)
      ? Math.max(0, record.completedAt)
      : null,
    favorite: Boolean(record && record.favorite),
    watchLater: Boolean(record && record.watchLater),
    playbackStatus: typeof (record && record.playbackStatus) === "string"
      ? record.playbackStatus.slice(0, 24)
      : "paused",
  };
}

function createDefaultViewerState(profileId, now = Date.now()) {
  return {
    schemaVersion: 1,
    profileId: normalizeProfileId(profileId),
    revision: 0,
    updatedAt: now,
    settings: { ...SETTINGS_DEFAULTS },
    movies: safeMovieMap(),
    queue: [],
  };
}

function parseState(raw) {
  if (!raw) {
    return null;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? raw : null;
}

function normalizeViewerState(raw, profileId, now = Date.now()) {
  const normalizedProfileId = normalizeProfileId(profileId);
  const parsed = parseState(raw);
  if (!parsed || parsed.schemaVersion !== 1 || parsed.profileId !== normalizedProfileId) {
    return createDefaultViewerState(normalizedProfileId, now);
  }

  const state = createDefaultViewerState(normalizedProfileId, now);
  state.revision = Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
  state.updatedAt = Number.isFinite(parsed.updatedAt) ? Math.max(0, parsed.updatedAt) : now;
  if (parsed.settings && typeof parsed.settings === "object") {
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      if (typeof parsed.settings[key] === "boolean") {
        state.settings[key] = parsed.settings[key];
      }
    }
  }

  if (parsed.movies && typeof parsed.movies === "object") {
    const movieKeys = Object.keys(parsed.movies).filter((key) => !DANGEROUS_KEYS.has(key));
    for (const movieId of movieKeys.slice(0, MAX_MOVIE_RECORDS)) {
      try {
        assertMovieId(movieId);
        state.movies[movieId] = cloneMovieRecord(parsed.movies[movieId]);
      } catch {
        // Invalid historical records are discarded during normalization.
      }
    }
  }

  if (Array.isArray(parsed.queue)) {
    const queue = [];
    for (const candidate of parsed.queue) {
      try {
        const movieId = assertMovieId(candidate);
        if (!queue.includes(movieId) && queue.length < MAX_QUEUE_LENGTH) {
          queue.push(movieId);
        }
      } catch {
        // Invalid historical queue entries are discarded.
      }
    }
    state.queue = queue;
  }

  return state;
}

function requireMovie(operation, movieIds) {
  const movieId = assertMovieId(operation.movieId);
  if (!movieIds || !movieIds.has(movieId)) {
    throw new Error("Unknown movie.");
  }
  return movieId;
}

function applyViewerOperations(state, operations, context = {}) {
  if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS) {
    throw new Error("Too many viewer-state operations.");
  }
  const movieIds = context.movieIds instanceof Set ? context.movieIds : new Set(context.movieIds || []);
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const next = normalizeViewerState(state, state.profileId, now);
  let changed = false;

  for (const operation of operations) {
    if (!operation || typeof operation.type !== "string") {
      throw new Error("Invalid viewer-state operation.");
    }

    if (operation.type === "progress") {
      const movieId = requireMovie(operation, movieIds);
      if (!Number.isFinite(operation.positionSeconds) || !Number.isFinite(operation.durationSeconds)) {
        throw new Error("Progress values must be finite.");
      }
      const durationSeconds = Math.max(0, operation.durationSeconds);
      const positionSeconds = Math.min(
        Math.max(0, operation.positionSeconds),
        durationSeconds || Math.max(0, operation.positionSeconds),
      );
      const previous = next.movies[movieId] || cloneMovieRecord(null);
      const updated = {
        ...previous,
        positionSeconds,
        durationSeconds,
        lastWatchedAt: now,
        playbackStatus: typeof operation.playbackStatus === "string"
          ? operation.playbackStatus.slice(0, 24)
          : previous.playbackStatus,
      };
      if (JSON.stringify(previous) !== JSON.stringify(updated)) {
        next.movies[movieId] = updated;
        changed = true;
      }
      continue;
    }

    if (operation.type === "setCompleted") {
      const movieId = requireMovie(operation, movieIds);
      if (typeof operation.value !== "boolean") {
        throw new Error("Completion value must be boolean.");
      }
      const previous = next.movies[movieId] || cloneMovieRecord(null);
      const updated = { ...previous, completedAt: operation.value ? now : null };
      if (JSON.stringify(previous) !== JSON.stringify(updated)) {
        next.movies[movieId] = updated;
        changed = true;
      }
      continue;
    }

    if (operation.type === "setFlag") {
      const movieId = requireMovie(operation, movieIds);
      if (operation.flag !== "favorite" && operation.flag !== "watchLater") {
        throw new Error("Invalid viewer-state flag.");
      }
      if (typeof operation.value !== "boolean") {
        throw new Error("Flag value must be boolean.");
      }
      const previous = next.movies[movieId] || cloneMovieRecord(null);
      if (previous[operation.flag] !== operation.value) {
        next.movies[movieId] = { ...previous, [operation.flag]: operation.value };
        changed = true;
      }
      continue;
    }

    if (operation.type === "queueAdd") {
      const movieId = requireMovie(operation, movieIds);
      if (!next.queue.includes(movieId)) {
        if (next.queue.length >= MAX_QUEUE_LENGTH) {
          throw new Error("Viewer queue is full.");
        }
        next.queue.push(movieId);
        changed = true;
      }
      continue;
    }

    if (operation.type === "queueRemove") {
      const movieId = requireMovie(operation, movieIds);
      const index = next.queue.indexOf(movieId);
      if (index !== -1) {
        next.queue.splice(index, 1);
        changed = true;
      }
      continue;
    }

    if (operation.type === "queueMove") {
      const movieId = requireMovie(operation, movieIds);
      if (!Number.isInteger(operation.toIndex) || operation.toIndex < 0 || operation.toIndex >= next.queue.length) {
        throw new Error("Invalid queue position.");
      }
      const fromIndex = next.queue.indexOf(movieId);
      if (fromIndex === -1) {
        throw new Error("Movie is not in the viewer queue.");
      }
      if (fromIndex !== operation.toIndex) {
        next.queue.splice(fromIndex, 1);
        next.queue.splice(operation.toIndex, 0, movieId);
        changed = true;
      }
      continue;
    }

    if (operation.type === "settings") {
      if (!operation.values || typeof operation.values !== "object") {
        throw new Error("Viewer settings are required.");
      }
      for (const key of Object.keys(operation.values)) {
        if (!Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key) || typeof operation.values[key] !== "boolean") {
          throw new Error("Invalid viewer setting.");
        }
        if (next.settings[key] !== operation.values[key]) {
          next.settings[key] = operation.values[key];
          changed = true;
        }
      }
      continue;
    }

    throw new Error("Unknown viewer-state operation.");
  }

  if (changed) {
    next.revision += 1;
    next.updatedAt = now;
  }
  if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("Viewer state is too large.");
  }
  return { state: next, changed };
}

function movieWithRecord(movie, record) {
  return { ...movie, viewerState: cloneMovieRecord(record) };
}

function deriveContinueWatching(state, movies) {
  return movies
    .map((movie) => ({ movie, record: state.movies[movie.id] }))
    .filter((entry) => entry.record && entry.record.positionSeconds > 0 && !entry.record.completedAt)
    .sort((left, right) => right.record.lastWatchedAt - left.record.lastWatchedAt)
    .map((entry) => movieWithRecord(entry.movie, entry.record));
}

function deriveHistory(state, movies) {
  return movies
    .map((movie) => ({ movie, record: state.movies[movie.id] }))
    .filter((entry) => entry.record && entry.record.lastWatchedAt > 0)
    .sort((left, right) => right.record.lastWatchedAt - left.record.lastWatchedAt)
    .map((entry) => movieWithRecord(entry.movie, entry.record));
}

function createViewerStateManager({ store, listMovies, now = Date.now, durable = Boolean(store && store.durable), ttlMs = 180 * 24 * 60 * 60 * 1000 }) {
  if (!store || typeof store.get !== "function" || typeof store.compareAndSet !== "function") {
    throw new Error("Viewer state requires a compare-and-set store.");
  }

  async function readLibrary() {
    const library = await listMovies();
    return {
      movies: library,
      movieIds: new Set(library.map((movie) => movie.id).filter((movieId) => typeof movieId === "string")),
    };
  }

  return {
    isReady() {
      return durable;
    },

    async get(profileId) {
      const normalizedProfileId = normalizeProfileId(profileId);
      const raw = await store.get(VIEWER_STATE_PREFIX + normalizedProfileId);
      return normalizeViewerState(raw, normalizedProfileId, now());
    },

    async apply(profileId, operations) {
      const normalizedProfileId = normalizeProfileId(profileId);
      const { movieIds } = await readLibrary();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const key = VIEWER_STATE_PREFIX + normalizedProfileId;
        const raw = await store.get(key);
        const base = normalizeViewerState(raw, normalizedProfileId, now());
        const result = applyViewerOperations(base, operations, { movieIds, now: now() });
        if (!result.changed) {
          return result.state;
        }
        const saved = await store.compareAndSet(key, raw, JSON.stringify(result.state), ttlMs);
        if (saved) {
          return result.state;
        }
      }
      throw new Error("Viewer state changed too often; please retry.");
    },
  };
}

module.exports = {
  applyViewerOperations,
  createDefaultViewerState,
  createViewerStateManager,
  deriveContinueWatching,
  deriveHistory,
  normalizeProfileId,
  normalizeViewerState,
};
