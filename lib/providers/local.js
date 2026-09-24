const fs = require("node:fs");
const path = require("node:path");

const { promises: fsp } = fs;

const { isStreamableExtension, movieTitleFromName } = require("../media");

function normalizeMovieId(movieId) {
  let decoded;

  try {
    decoded = decodeURIComponent(movieId || "");
  } catch {
    return null;
  }

  const normalized = path.posix.normalize(decoded.replaceAll("\\", "/"));
  if (!normalized || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    return null;
  }

  return normalized;
}

async function walkMovies(rootDir, currentDir = rootDir, prefix = "") {
  let entries = [];

  try {
    entries = await fsp.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      await fsp.mkdir(rootDir, { recursive: true });
      return [];
    }
    throw error;
  }

  const movies = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      movies.push(...await walkMovies(rootDir, fullPath, relativePath));
      continue;
    }

    if (!entry.isFile() || !isStreamableExtension(entry.name)) {
      continue;
    }

    const stats = await fsp.stat(fullPath);
    const folder = path.posix.dirname(relativePath) === "."
      ? ""
      : path.posix.dirname(relativePath);

    movies.push({
      id: relativePath,
      title: movieTitleFromName(entry.name),
      folder,
      size: stats.size,
      source: "local",
    });
  }

  return movies;
}

function createLocalProvider({ moviesDir }) {
  const resolvedMoviesDir = path.resolve(moviesDir);

  return {
    kind: "local",
    moviesDir: resolvedMoviesDir,
    async listMovies() {
      const movies = await walkMovies(resolvedMoviesDir);
      movies.sort((left, right) => {
        const byTitle = left.title.localeCompare(right.title);
        return byTitle || left.id.localeCompare(right.id);
      });
      return movies;
    },
    resolveMoviePath(encodedMovieId) {
      const movieId = normalizeMovieId(encodedMovieId);
      if (!movieId) {
        return null;
      }

      const filePath = path.resolve(resolvedMoviesDir, movieId);
      return filePath.startsWith(resolvedMoviesDir) ? filePath : null;
    },
    async resolvePlayback(movieId) {
      const normalized = normalizeMovieId(movieId);
      if (!normalized) {
        const error = new Error("Invalid movie path.");
        error.statusCode = 400;
        throw error;
      }

      return {
        url: `/api/stream/${encodeURIComponent(normalized)}`,
        expiresAt: null,
      };
    },
  };
}

module.exports = {
  createLocalProvider,
};
