const path = require("node:path");

const { movieTitleFromName } = require("../media");

function providerError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function createJellyfinProvider({ env = process.env, fetchImpl = fetch } = {}) {
  const baseUrl = normalizeBaseUrl(env.JELLYFIN_URL || "http://127.0.0.1:8096");
  const apiKey = String(env.JELLYFIN_API_KEY || "").trim();
  const libraryId = String(env.JELLYFIN_LIBRARY_ID || "").trim();
  const headers = {
    Accept: "application/json",
    ...(apiKey ? { "X-Emby-Token": apiKey } : {}),
  };

  async function requestJson(endpoint) {
    if (!apiKey) {
      throw providerError("Jellyfin is selected, but JELLYFIN_API_KEY is not configured.", 503);
    }
    const response = await fetchImpl(`${baseUrl}${endpoint}`, { headers });
    if (response.status === 401 || response.status === 403) {
      throw providerError("Jellyfin rejected the configured API key.", 502);
    }
    if (!response.ok) {
      throw providerError(`Jellyfin returned HTTP ${response.status}.`, 502);
    }
    return response.json();
  }

  function imageUrl(id) {
    return `/api/jellyfin/image/${encodeURIComponent(id)}`;
  }

  function streamUrl(id) {
    return `/api/jellyfin/stream?movieId=${encodeURIComponent(id)}`;
  }

  function mapItem(item) {
    const fileName = item.Path ? path.basename(item.Path) : `${item.Name || "Movie"}.mp4`;
    const extension = path.extname(fileName).toLowerCase();
    const folder = item.SeriesName
      ? [item.SeriesName, item.SeasonName || (item.ParentIndexNumber ? `Season ${item.ParentIndexNumber}` : "")]
        .filter(Boolean).join("/")
      : "";
    return {
      id: item.Id,
      title: item.Name || movieTitleFromName(fileName),
      fileName,
      folder,
      extension,
      posterUrl: imageUrl(item.Id),
      backdropUrl: item.BackdropImageTags?.length ? imageUrl(item.Id) : "",
      size: Number(item.Size) || 0,
      source: "jellyfin",
      contentType: item.Type === "Episode" ? "episode" : "movie",
      year: item.ProductionYear || null,
      runtimeTicks: item.RunTimeTicks || null,
      overview: item.Overview || "",
      genres: Array.isArray(item.Genres) ? item.Genres : [],
      seriesName: item.SeriesName || "",
      seasonNumber: item.ParentIndexNumber || null,
      episodeNumber: item.IndexNumber || null,
    };
  }

  async function listLibrary() {
    const params = new URLSearchParams({
      Recursive: "true",
      IncludeItemTypes: "Movie,Episode",
      Fields: "Path,MediaSources,RunTimeTicks,Genres,ProductionYear,Overview,SeriesName,SeasonName,ParentIndexNumber,IndexNumber,BackdropImageTags",
      SortBy: "SortName",
      SortOrder: "Ascending",
      Limit: "10000",
    });
    if (libraryId) params.set("ParentId", libraryId);
    const payload = await requestJson(`/Items?${params.toString()}`);
    const movies = (payload.Items || [])
      .filter((item) => item && (item.Type === "Movie" || item.Type === "Episode"))
      .map(mapItem);
    const folderMap = new Map();
    for (const movie of movies) {
      if (!movie.folder) continue;
      const parts = movie.folder.split("/");
      for (let index = 0; index < parts.length; index += 1) {
        const folderPath = parts.slice(0, index + 1).join("/");
        if (!folderMap.has(folderPath)) {
          folderMap.set(folderPath, {
            id: folderPath,
            path: folderPath,
            name: parts[index],
            parent: parts.slice(0, index).join("/"),
            source: "jellyfin",
            hidden: parts[index].startsWith("."),
          });
        }
      }
    }
    const folders = [...folderMap.values()].map((folder) => {
      const children = movies.filter((movie) => movie.folder === folder.path || movie.folder.startsWith(`${folder.path}/`));
      return { ...folder, movieCount: children.length, playableCount: children.length, uploadingCount: 0 };
    });
    return { movies, folders };
  }

  async function resolvePlayback(movieId) {
    const payload = await requestJson(`/Items/${encodeURIComponent(movieId)}?Fields=Path,MediaSources,RunTimeTicks,ProductionYear,Overview`);
    if (!payload || !payload.Id) {
      throw providerError("Jellyfin could not find a streamable movie.", 415);
    }
    return {
      url: streamUrl(payload.Id),
      expiresAt: null,
      contentType: payload.MediaSources?.[0]?.MediaStreams?.find((stream) => stream.Type === "Video")?.Codec
        ? "video/" + path.extname(payload.Path || ".mp4").slice(1)
        : "video/mp4",
      title: payload.Name || movieTitleFromName(payload.Path || "Movie"),
    };
  }

  async function proxyImage(id, request) {
    if (!apiKey) throw providerError("Jellyfin API key is not configured.", 503);
    const response = await fetchImpl(`${baseUrl}/Items/${encodeURIComponent(id)}/Images/Primary`, {
      method: request.method,
      headers: { "X-Emby-Token": apiKey },
    });
    return response;
  }

  async function proxyStream(id, request) {
    if (!apiKey) throw providerError("Jellyfin API key is not configured.", 503);
    const response = await fetchImpl(`${baseUrl}/Videos/${encodeURIComponent(id)}/stream?Static=true`, {
      method: request.method,
      headers: {
        "X-Emby-Token": apiKey,
        ...(request.headers.range ? { Range: request.headers.range } : {}),
      },
    });
    return response;
  }

  return {
    kind: "jellyfin",
    jellyfinBaseUrl: baseUrl,
    async listLibrary() { return listLibrary(); },
    async listMovies() { return (await listLibrary()).movies; },
    async resolvePlayback(movieId) { return resolvePlayback(movieId); },
    proxyImage,
    proxyStream,
  };
}

module.exports = { createJellyfinProvider };
