const fs = require("node:fs");
const path = require("node:path");

const { promises: fsp } = fs;

const { isStreamableExtension, movieTitleFromName, posterUrlFromTitle } = require("../media");
const { buildSeriesGroups, inferSeriesInfo, isSampleVideo } = require("../library");

// The canonical root also contains app packages, recovery copies, and a few
// original torrent-release folders. They are not part of the active library;
// scanning them would make the same title appear twice. Keep this list narrow
// and explicit so ordinary user-created movie folders remain discoverable.
const IGNORED_ROOT_DIRECTORIES = new Set([
  "Applications",
  "_Recovery",
  "Jackass Collection 2000-2026 1080p WEB-DL HEVC x265 5.1 BONE",
  "Jackass.Forever.2022.1080p.WEBRip.DD5.1.X.264-EVO",
  "www.Torrenting.com - Bomb.Girls.Facing.the.Enemy.2014.1080p.WEB.H264-DiMEPiECE",
]);

function isWithinDirectory(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath);
  return (relative === "" || !relative.startsWith("..")) && !path.isAbsolute(relative);
}

function normalizeMovieId(movieId) {
  const rawMovieId = movieId || "";
  let decoded = rawMovieId;

  if (/%[0-9A-Fa-f]{2}/.test(rawMovieId)) {
    try {
      decoded = decodeURIComponent(rawMovieId);
    } catch {
      return null;
    }
  }

  const normalized = path.posix.normalize(decoded.replaceAll("\\", "/"));
  if (!normalized || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    return null;
  }

  return normalized;
}

function encodeMovieIdForPath(movieId) {
  return movieId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function createFolderEntry(folderPath, source = "local") {
  const normalizedPath = folderPath.replaceAll("\\", "/");
  const name = path.posix.basename(normalizedPath);
  const parent = path.posix.dirname(normalizedPath);

  return {
    id: normalizedPath,
    path: normalizedPath,
    name,
    parent: parent === "." ? "" : parent,
    source,
    hidden: name.startsWith("."),
  };
}

function withFolderCounts(folders, movies) {
  return folders.map((folder) => {
    const descendantMovies = movies.filter((movie) => (
      movie.folder === folder.path || movie.folder.startsWith(`${folder.path}/`)
    ));
    return {
      ...folder,
      movieCount: descendantMovies.length,
      playableCount: descendantMovies.filter((movie) => (Number(movie.size) || 0) > 0).length,
      uploadingCount: descendantMovies.filter((movie) => (Number(movie.size) || 0) <= 0).length,
    };
  });
}

async function walkLibrary(rootDir, currentDir = rootDir, prefix = "") {
  let entries = [];

  try {
    entries = await fsp.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      await fsp.mkdir(rootDir, { recursive: true });
      return { movies: [], folders: [] };
    }
    throw error;
  }

  const movies = [];
  const folders = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (!prefix && IGNORED_ROOT_DIRECTORIES.has(entry.name)) {
        continue;
      }
      folders.push(createFolderEntry(relativePath));
      const nestedLibrary = await walkLibrary(rootDir, fullPath, relativePath);
      folders.push(...nestedLibrary.folders);
      movies.push(...nestedLibrary.movies);
      continue;
    }

    if (!entry.isFile() || !isStreamableExtension(entry.name) || isSampleVideo(relativePath, entry.name)) {
      continue;
    }

    const stats = await fsp.stat(fullPath);
    const folder = path.posix.dirname(relativePath) === "."
      ? ""
      : path.posix.dirname(relativePath);

    const title = movieTitleFromName(entry.name);
    const seriesInfo = inferSeriesInfo(relativePath, entry.name);
    movies.push({
      id: relativePath,
      title,
      fileName: entry.name,
      folder,
      extension: path.extname(entry.name).toLowerCase(),
      posterUrl: posterUrlFromTitle(title),
      size: stats.size,
      source: "local",
      ...seriesInfo,
    });
  }

  return { movies, folders };
}

function createLocalProvider({ moviesDir }) {
  const resolvedMoviesDir = path.resolve(moviesDir);

  return {
    kind: "local",
    moviesDir: resolvedMoviesDir,
    async listLibrary() {
      const library = await walkLibrary(resolvedMoviesDir);
      library.movies.sort((left, right) => {
        const byTitle = left.title.localeCompare(right.title);
        return byTitle || left.id.localeCompare(right.id);
      });
      library.folders = withFolderCounts(library.folders, library.movies).sort((left, right) => (
        left.path.localeCompare(right.path)
      ));
      library.series = buildSeriesGroups(library.movies);
      return library;
    },
    async listMovies() {
      return (await this.listLibrary()).movies;
    },
    resolveMoviePath(encodedMovieId) {
      const movieId = normalizeMovieId(encodedMovieId);
      if (!movieId) {
        return null;
      }

      const filePath = path.resolve(resolvedMoviesDir, movieId);
      return isWithinDirectory(resolvedMoviesDir, filePath) ? filePath : null;
    },
    async resolvePlayback(movieId) {
      const normalized = normalizeMovieId(movieId);
      if (!normalized) {
        const error = new Error("Invalid movie path.");
        error.statusCode = 400;
        throw error;
      }

      return {
        url: `/api/stream/${encodeMovieIdForPath(normalized)}`,
        expiresAt: null,
      };
    },
  };
}

module.exports = {
  createLocalProvider,
};
