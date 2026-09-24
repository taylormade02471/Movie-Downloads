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
  return path.parse(name).name.replaceAll(/[_-]+/g, " ");
}

module.exports = {
  CONTENT_TYPES,
  STREAMABLE_EXTENSIONS,
  getContentType,
  isStreamableExtension,
  movieTitleFromName,
};
