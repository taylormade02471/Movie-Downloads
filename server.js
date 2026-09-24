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
  return (relative === "" || !relative.startsWith("..")) && !path.isAbsolute(relative);
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

  if (fileName !== path.basename(fileName)) {
    return null;
  }

  const fullPath = path.resolve(moviesDir, fileName);

  if (!isWithinDirectory(moviesDir, fullPath)) {
    return null;
  }

  return fullPath;
}

async function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function getStreamHeaders(filePath, size, range) {
  const contentType = getContentType(filePath);

  if (!range) {
    return {
      statusCode: 200,
      headers: {
        "Content-Length": size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    return {
      statusCode: 416,
      headers: { "Content-Range": `bytes */${size}` },
    };
  }

  let start;
  let end;

  if (match[1] === "" && match[2] !== "") {
    const suffixLength = Number.parseInt(match[2], 10);
    if (Number.isNaN(suffixLength) || suffixLength <= 0) {
      return {
        statusCode: 416,
        headers: { "Content-Range": `bytes */${size}` },
      };
    }

    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = match[1] ? Number.parseInt(match[1], 10) : 0;
    end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  }

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return {
      statusCode: 416,
      headers: { "Content-Range": `bytes */${size}` },
    };
  }

  end = Math.min(end, size - 1);

  return {
    statusCode: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
    start,
    end,
  };
}

function streamFile(request, response, filePath, size) {
  const streamResponse = getStreamHeaders(filePath, size, request.headers.range);
  response.writeHead(streamResponse.statusCode, streamResponse.headers);

  if (streamResponse.statusCode !== 206) {
    if (streamResponse.statusCode !== 200) {
      response.end();
      return;
    }

    createReadStream(filePath).pipe(response);
    return;
  }

  createReadStream(filePath, {
    start: streamResponse.start,
    end: streamResponse.end,
  })
    .on("error", () => {
      response.destroy();
    })
    .pipe(response);
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

        if (!STREAMABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
          await sendJson(response, 415, { error: "Unsupported movie format." });
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
          const streamResponse = getStreamHeaders(filePath, stats.size, request.headers.range);
          response.writeHead(streamResponse.statusCode, streamResponse.headers);
          response.end();
          return;
        }

        streamFile(request, response, filePath, stats.size);
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405);
        response.end();
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

      response.writeHead(200, {
        "Content-Type": getContentType(filePath),
        "Content-Length": fileContents.length,
      });
      response.end(request.method === "HEAD" ? undefined : fileContents);
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
  getStreamHeaders,
  listMovies,
  resolveMoviePath,
  getContentType,
};
