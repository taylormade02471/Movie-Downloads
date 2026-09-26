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

function runtimeLabel(runTimeTicks) {
  const totalMinutes = Math.round(Number(runTimeTicks || 0) / 600000000);
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return "";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}

function peopleByType(people, type) {
  return (Array.isArray(people) ? people : [])
    .filter((person) => person && person.Type === type && person.Name)
    .map((person) => person.Name)
    .filter((name, index, names) => names.indexOf(name) === index);
}

function createJellyfinProvider({ env = process.env, fetchImpl = fetch } = {}) {
  const baseUrl = normalizeBaseUrl(env.JELLYFIN_URL || "http://127.0.0.1:8096");
  const apiKey = String(env.JELLYFIN_API_KEY || "").trim();
  const libraryId = String(env.JELLYFIN_LIBRARY_ID || "").trim();
  const authorization = apiKey
    ? `MediaBrowser Client="Movie Room", Device="Movie Room Server", DeviceId="movie-room-server", Version="1.0.0", Token="${apiKey}"`
    : "";
  const headers = {
    Accept: "application/json",
    ...(apiKey ? { Authorization: authorization, "X-Emby-Token": apiKey } : {}),
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

  function imageUrl(id, imageType = "Primary") {
    const suffix = imageType === "Backdrop" ? "?type=Backdrop" : "";
    return `/api/jellyfin/image/${encodeURIComponent(id)}${suffix}`;
  }

  function streamUrl(id) {
    return `/api/jellyfin/stream?movieId=${encodeURIComponent(id)}`;
  }

  function mapItem(item) {
    const fileName = item.Path ? path.basename(item.Path) : `${item.Name || "Movie"}.mp4`;
    const extension = path.extname(fileName).toLowerCase();
    const normalizedPath = String(item.Path || "").replace(/\\/g, "/");
    const folderMatch = normalizedPath.match(/(?:^|\/)TV Shows\/([^/]+)\/Season\s*(\d+)/i);
    const inferredSeriesName = folderMatch ? folderMatch[1].trim() : "";
    const inferredSeasonNumber = folderMatch ? Number(folderMatch[2]) : null;
    const episodeMarker = fileName.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    const seriesName = item.SeriesName || inferredSeriesName;
    const seasonNumber = item.ParentIndexNumber || inferredSeasonNumber || (episodeMarker ? Number(episodeMarker[1]) : null);
    const episodeNumber = item.IndexNumber || (episodeMarker ? Number(episodeMarker[2]) : null);
    const seasonName = item.SeasonName || (seasonNumber ? `Season ${seasonNumber}` : "");
    const cast = peopleByType(item.People, "Actor");
    const director = peopleByType(item.People, "Director");
    const description = item.Overview || "";
    const rating = Number.isFinite(Number(item.CommunityRating))
      ? Number(item.CommunityRating).toFixed(1)
      : "";
    const studios = (Array.isArray(item.Studios) ? item.Studios : [])
      .map((studio) => studio && (studio.Name || studio))
      .filter(Boolean);
    const folder = seriesName
      ? [seriesName, seasonName]
        .filter(Boolean).join("/")
      : "";
    return {
      id: item.Id,
      title: item.Name && item.Name !== seriesName ? item.Name : movieTitleFromName(fileName),
      fileName,
      folder,
      extension,
      posterUrl: imageUrl(item.Id),
      backdropUrl: item.BackdropImageTags?.length ? imageUrl(item.Id, "Backdrop") : "",
      size: Number(item.Size) || 0,
      source: "jellyfin",
      contentType: item.Type === "Episode" ? "episode" : "movie",
      year: item.ProductionYear || null,
      runtimeTicks: item.RunTimeTicks || null,
      runtime: runtimeLabel(item.RunTimeTicks),
      overview: description,
      description,
      rating,
      contentRating: item.OfficialRating || "",
      originalTitle: item.OriginalTitle || "",
      tagline: item.Tagline || "",
      premiered: item.PremiereDate || "",
      dateAdded: item.DateCreated || "",
      genres: Array.isArray(item.Genres) ? item.Genres : [],
      tags: Array.isArray(item.Tags) ? item.Tags : [],
      cast,
      director,
      studios,
      metadata: {
        originalTitle: item.OriginalTitle || "",
        tagline: item.Tagline || "",
        contentRating: item.OfficialRating || "",
        rating,
        premiered: item.PremiereDate || "",
        cast,
        director,
        studios,
        tags: Array.isArray(item.Tags) ? item.Tags : [],
      },
      seriesName,
      seasonNumber,
      episodeNumber,
    };
  }

  async function listLibrary() {
    const params = new URLSearchParams({
      Recursive: "true",
      IncludeItemTypes: "Movie,Episode",
      Fields: "Path,MediaSources,RunTimeTicks,Genres,ProductionYear,Overview,SeriesName,SeasonName,ParentIndexNumber,IndexNumber,BackdropImageTags,People,Studios,Tags,OriginalTitle,Tagline,OfficialRating,CommunityRating,PremiereDate,DateCreated",
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
    const payload = await requestJson(`/Items/${encodeURIComponent(movieId)}?Fields=Path,MediaSources,RunTimeTicks,ProductionYear,Overview,OriginalTitle,OfficialRating,CommunityRating,PremiereDate`);
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

  async function proxyImage(id, request, imageType = "Primary") {
    if (!apiKey) throw providerError("Jellyfin API key is not configured.", 503);
    const normalizedType = String(imageType).toLowerCase() === "backdrop" ? "Backdrop" : "Primary";
    const response = await fetchImpl(`${baseUrl}/Items/${encodeURIComponent(id)}/Images/${normalizedType}`, {
      method: request.method,
      headers: { Authorization: authorization, "X-Emby-Token": apiKey },
    });
    return response;
  }

  async function proxyStream(id, request) {
    if (!apiKey) throw providerError("Jellyfin API key is not configured.", 503);
    const response = await fetchImpl(`${baseUrl}/Videos/${encodeURIComponent(id)}/stream?Static=true`, {
      method: request.method,
      headers: {
        Authorization: authorization,
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
