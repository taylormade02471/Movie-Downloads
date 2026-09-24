const http = require("http");
const fs = require("fs");
const path = require("path");

const { createReadStream, promises: fsp } = fs;

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

function isWithinDirectory(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function listMovies(moviesDir) {
  let entries = [];

  try {
    entries = await fsp.readdir(moviesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      await fsp.mkdir(moviesDir, { recursive: true });
      return [];
    }
    throw error;
  }

  const movies = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!STREAMABLE_EXTENSIONS.has(extension)) {
      continue;
    }

    const fullPath = path.join(moviesDir, entry.name);
    const stats = await fsp.stat(fullPath);

    movies.push({
      title: path.parse(entry.name).name.replaceAll(/[_-]+/g, " "),
      filename: entry.name,
      size: stats.size,
      streamPath: `/api/stream/${encodeURIComponent(entry.name)}`,
    });
  }

  movies.sort((a, b) => a.title.localeCompare(b.title));
  return movies;
}

function resolveMoviePath(moviesDir, encodedFileName) {
  let fileName = "";

  try {
    fileName = decodeURIComponent(encodedFileName || "");
  } catch {
    return null;
  }

  const fullPath = path.resolve(moviesDir, fileName);

  if (!isWithinDirectory(moviesDir, fullPath) && fullPath !== path.resolve(moviesDir, path.basename(fileName))) {
    return null;
  }

  return fullPath;
}

async function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function streamFile(request, response, filePath, size) {
  const contentType = getContentType(filePath);
  const range = request.headers.range;

  if (!range) {
    response.writeHead(200, {
      "Content-Length": size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });

    createReadStream(filePath).pipe(response);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${size}` });
    response.end();
    return;
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end < start ||
    start >= size ||
    end >= size
  ) {
    response.writeHead(416, { "Content-Range": `bytes */${size}` });
    response.end();
    return;
  }

  response.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Content-Length": end - start + 1,
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });

  createReadStream(filePath, { start, end }).pipe(response);
}

function createServer(options = {}) {
  const moviesDir = path.resolve(options.moviesDir || path.join(__dirname, "movies"));
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, "public"));

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/movies") {
        const movies = await listMovies(moviesDir);
        await sendJson(response, 200, movies);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/api/stream/")) {
        const encodedFileName = url.pathname.slice("/api/stream/".length);
        const filePath = resolveMoviePath(moviesDir, encodedFileName);

        if (!filePath) {
          await sendJson(response, 400, { error: "Invalid movie path." });
          return;
        }

        let stats;
        try {
          stats = await fsp.stat(filePath);
        } catch (error) {
          if (error.code === "ENOENT") {
            await sendJson(response, 404, { error: "Movie not found." });
            return;
          }
          throw error;
        }

        if (!stats.isFile()) {
          await sendJson(response, 404, { error: "Movie not found." });
          return;
        }

        if (request.method === "HEAD") {
          response.writeHead(200, {
            "Content-Length": stats.size,
            "Content-Type": getContentType(filePath),
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
          });
          response.end();
          return;
        }

        streamFile(request, response, filePath, stats.size);
        return;
      }

      const publicPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const filePath = path.resolve(publicDir, publicPath);

      if (!isWithinDirectory(publicDir, filePath) && filePath !== path.join(publicDir, "index.html")) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      let fileContents;
      try {
        fileContents = await fsp.readFile(filePath);
      } catch (error) {
        if (error.code === "ENOENT") {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        throw error;
      }

      response.writeHead(200, { "Content-Type": getContentType(filePath) });
      response.end(fileContents);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Internal server error." }));
    }
  });
}

async function startServer() {
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";
  const server = createServer();

  server.listen(port, host, () => {
    console.log(`Movie Room is running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createServer,
  listMovies,
  resolveMoviePath,
  getContentType,
};
