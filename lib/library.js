const path = require("node:path");

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function isSampleVideo(relativePath, fileName = "") {
  const pathParts = normalizePath(relativePath).split("/").filter(Boolean);
  if (pathParts.some((part) => /^samples?$/i.test(part))) {
    return true;
  }

  return /(?:^|[._ -])samples?(?:[._ -]|$)/i.test(path.basename(fileName, path.extname(fileName)));
}

function inferSeriesInfo(relativePath, fileName = "") {
  const normalized = normalizePath(relativePath);
  const folder = path.posix.dirname(normalized) === "." ? "" : path.posix.dirname(normalized);
  const parts = folder.split("/").filter(Boolean);
  const episodeMarker = String(fileName).match(/\bS(\d{1,2})E(\d{1,3})\b/i);

  let seasonIndex = -1;
  let seasonNumber = null;
  let seriesName = "";
  let namedSeasonName = "";
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    const exactSeason = /^(?:season\s*|s)(\d{1,2})$/i.exec(part.trim());
    const namedSeason = /^(.+?)\s+season\s*(\d{1,2})$/i.exec(part.trim());
    if (!exactSeason && !namedSeason) continue;

    seasonIndex = index;
    seasonNumber = Number(exactSeason ? exactSeason[1] : namedSeason[2]);
    if (namedSeason) {
      seriesName = namedSeason[1].trim();
      namedSeasonName = seriesName;
    } else {
      const candidates = parts.slice(0, index).filter((partName) => (
        !/^(?:tv\s*shows?|tv\s*series|shows?|series|seasons?)$/i.test(partName.trim())
      ));
      seriesName = candidates[candidates.length - 1] || "";
    }
    break;
  }

  if (!seasonNumber && episodeMarker) {
    seasonNumber = Number(episodeMarker[1]);
    const candidates = parts.filter((partName) => (
      !/^(?:tv\s*shows?|tv\s*series|shows?|series|seasons?)$/i.test(partName.trim())
    ));
    seriesName = candidates[candidates.length - 1] || "";
    seasonIndex = parts.length;
  }

  if (!seriesName || !seasonNumber) {
    return {
      contentType: "movie",
      seriesName: "",
      seriesPath: "",
      seasonName: "",
      seasonNumber: null,
      episodeNumber: episodeMarker ? Number(episodeMarker[2]) : null,
    };
  }

  const seasonName = `Season ${seasonNumber}`;
  let seriesParts = parts.slice(0, seasonIndex);
  const lastPart = seriesParts[seriesParts.length - 1] || "";
  if (namedSeasonName && lastPart && lastPart.toLowerCase() === seriesName.toLowerCase()) {
    seriesParts = seriesParts.slice(0, -1);
  }
  if (!seriesParts.length || !seriesParts[seriesParts.length - 1].toLowerCase().includes(seriesName.toLowerCase())) {
    seriesParts.push(seriesName);
  }

  return {
    contentType: "episode",
    seriesName,
    seriesPath: seriesParts.join("/"),
    seasonName,
    seasonNumber,
    episodeNumber: episodeMarker ? Number(episodeMarker[2]) : null,
  };
}

function buildSeriesGroups(movies) {
  const groups = new Map();
  for (const movie of Array.isArray(movies) ? movies : []) {
    const info = movie.contentType === "episode" || movie.seriesName
      ? movie
      : inferSeriesInfo(movie.folder ? `${movie.folder}/${movie.fileName || ""}` : movie.fileName, movie.fileName);
    if (!info.seriesName || !info.seriesPath) continue;

    const key = info.seriesPath.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        id: `series:${info.seriesPath}`,
        title: info.seriesName,
        seriesName: info.seriesName,
        seriesPath: info.seriesPath,
        folder: info.seriesPath,
        contentType: "series",
        posterUrl: movie.posterUrl || "",
        backdropUrl: movie.backdropUrl || "",
        episodes: [],
        seasons: [],
      };
      groups.set(key, group);
    }
    if (!group.posterUrl && movie.posterUrl) group.posterUrl = movie.posterUrl;
    if (!group.backdropUrl && movie.backdropUrl) group.backdropUrl = movie.backdropUrl;
    group.episodes.push(movie);

    const seasonKey = String(info.seasonNumber || info.seasonName || "0");
    let season = group.seasons.find((entry) => entry.key === seasonKey);
    if (!season) {
      season = {
        key: seasonKey,
        name: info.seasonName || `Season ${info.seasonNumber}`,
        number: info.seasonNumber || null,
        folder: movie.folder || info.seriesPath,
        posterUrl: movie.posterUrl || "",
        episodeCount: 0,
      };
      group.seasons.push(season);
    }
    season.episodeCount += 1;
    if (!season.posterUrl && movie.posterUrl) season.posterUrl = movie.posterUrl;
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      episodes: group.episodes.sort((left, right) => (
        (Number(left.seasonNumber) || 0) - (Number(right.seasonNumber) || 0)
        || (Number(left.episodeNumber) || 0) - (Number(right.episodeNumber) || 0)
        || String(left.title).localeCompare(String(right.title))
      )),
      seasons: group.seasons.sort((left, right) => (Number(left.number) || 0) - (Number(right.number) || 0)),
      seasonCount: group.seasons.length,
      episodeCount: group.episodes.length,
    }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

module.exports = {
  buildSeriesGroups,
  inferSeriesInfo,
  isSampleVideo,
};
