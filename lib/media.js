const path = require("node:path");

const STREAMABLE_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".ogg",
  ".ogv",
  ".mkv",
]);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".ogv": "video/ogg",
  ".mkv": "video/x-matroska",
};

function getContentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function isStreamableExtension(filePath) {
  return STREAMABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function movieTitleFromName(name) {
  return path.parse(name).name
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*(480p|720p|1080p|2160p|4k|x264|x265|hevc|aac|bluray|web)[^)]*\)/gi, " ")
    .replace(/[._-]+/g, " ")
    .replace(/^\s*\d{1,2}\s+(?=[a-z])/i, "")
    .replace(/\s+\b(?:19|20)\d{2}\b.*$/i, " ")
    .replace(/\s+(?:family\s+comedy|action\s+comedy|romantic\s+comedy)\s*$/i, " ")
    .replace(/\s+\b(?:480p|576p|720p|1080p|2160p|4k|uhd|hdr|dv|web\s*dl|webrip|bluray|blu\s*ray|brrip|retail|xvid|x264|x265|h264|h265|h246|hevc|aac|dts|ddp\d*(?:\.\d+)?|10bit|yify|rarbg|yts|proper|repack|extended|unrated|multi|dksubs|subs|eng\s+subs|hq\s+pre)\b.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function posterSlugFromTitle(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "movie";
}

function posterUrlFromTitle(title) {
  return `/posters/${posterSlugFromTitle(title)}.jpg`;
}

module.exports = {
  CONTENT_TYPES,
  STREAMABLE_EXTENSIONS,
  getContentType,
  isStreamableExtension,
  movieTitleFromName,
  posterSlugFromTitle,
  posterUrlFromTitle,
};
