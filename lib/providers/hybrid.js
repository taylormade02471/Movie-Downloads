const path = require("node:path");

function providerError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fileKey(fileName) {
  return normalize(path.basename(String(fileName || "")));
}

function stemKey(fileName) {
  const name = path.basename(String(fileName || ""));
  return normalize(name.slice(0, name.length - path.extname(name).length));
}

function folderTokens(folder) {
  return new Set(normalize(folder).split(/[ /]+/).filter(Boolean));
}

function folderScore(left, right) {
  const leftTokens = folderTokens(left);
  const rightTokens = folderTokens(right);
  let score = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) score += 1;
  }
  return score;
}

function chooseCandidate(metadataItem, candidates) {
  if (candidates.length <= 1) return candidates[0] || null;
  return [...candidates].sort((left, right) => (
    folderScore(metadataItem.folder, right.folder) - folderScore(metadataItem.folder, left.folder)
    || String(left.folder).localeCompare(String(right.folder))
    || String(left.id).localeCompare(String(right.id))
  ))[0];
}

function createHybridProvider({ jellyfinProvider, oneDriveProvider }) {
  if (!jellyfinProvider || !oneDriveProvider) {
    throw new TypeError("Hybrid provider requires Jellyfin and OneDrive providers.");
  }

  const playbackIds = new Map();

  async function buildLibrary() {
    const [metadataLibrary, cloudLibrary] = await Promise.all([
      jellyfinProvider.listLibrary(),
      oneDriveProvider.listLibrary(),
    ]);
    const exactFiles = new Map();
    const stems = new Map();

    for (const cloudItem of cloudLibrary.movies) {
      const exact = fileKey(cloudItem.fileName);
      const stem = stemKey(cloudItem.fileName);
      if (exact) exactFiles.set(exact, [...(exactFiles.get(exact) || []), cloudItem]);
      if (stem) stems.set(stem, [...(stems.get(stem) || []), cloudItem]);
    }

    playbackIds.clear();
    const movies = metadataLibrary.movies.map((metadataItem) => {
      const exactMatches = exactFiles.get(fileKey(metadataItem.fileName)) || [];
      const stemMatches = stems.get(stemKey(metadataItem.fileName)) || [];
      const cloudItem = chooseCandidate(
        metadataItem,
        exactMatches.length ? exactMatches : stemMatches,
      );
      if (cloudItem) playbackIds.set(metadataItem.id, cloudItem.id);
      return {
        ...metadataItem,
        source: "hybrid",
        playbackSource: "onedrive",
        playbackAvailable: Boolean(cloudItem),
        size: Number(cloudItem?.size) || Number(metadataItem.size) || 0,
      };
    });

    return { movies, folders: metadataLibrary.folders };
  }

  async function resolvePlayback(movieId) {
    let oneDriveId = playbackIds.get(movieId);
    if (!oneDriveId) {
      await buildLibrary();
      oneDriveId = playbackIds.get(movieId);
    }
    if (!oneDriveId) {
      throw providerError("This Jellyfin title could not be matched to a OneDrive video file.", 404);
    }
    return oneDriveProvider.resolvePlayback(oneDriveId);
  }

  return {
    kind: "hybrid",
    metadataKind: "jellyfin",
    playbackKind: "onedrive",
    async listLibrary() { return buildLibrary(); },
    async listMovies() { return (await buildLibrary()).movies; },
    async resolvePlayback(movieId) { return resolvePlayback(movieId); },
    proxyImage: jellyfinProvider.proxyImage,
  };
}

module.exports = { createHybridProvider, fileKey, stemKey };
