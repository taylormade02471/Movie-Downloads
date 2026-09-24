const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { createReadStream, promises: fsp } = fs;
const { R_OK } = fs.constants;

const {
  getContentType,
  isStreamableExtension,
} = require("./lib/media");
const { createLocalProvider } = require("./lib/providers/local");
const { createOneDriveProvider } = require("./lib/providers/onedrive");
const { createKeyValueStore } = require("./lib/store");

const DEFAULT_BODY_LIMIT = 8 * 1024;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX_ATTEMPTS = 5;
const SESSION_COOKIE_NAME = "movie_room_session";

class HttpError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.statusCode = statusCode;
    this.headers = options.headers || {};
    this.payload = options.payload || { error: message };
  }
}

function isWithinDirectory(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath);
  return (relative === "" || !relative.startsWith("..")) && !path.isAbsolute(relative);
}

function noStoreHeaders(extraHeaders = {}) {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    ...extraHeaders,
  };
}

function getOrigin(request, trustProxy = false) {
  const forwardedProtocol = trustProxy
    ? (request.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    : "";
  const protocol = forwardedProtocol || (request.socket.encrypted ? "https" : "http");
  return `${protocol}://${request.headers.host || "localhost"}`;
}

function isSecureRequest(request, trustProxy = false) {
  const forwardedProtocol = trustProxy
    ? (request.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    : "";
  return forwardedProtocol === "https" || Boolean(request.socket.encrypted);
}

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      cookies[name] = value;
    }
  }

  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${value}`];
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  return parts.join("; ");
}

function signValue(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function encodeSignedValue(value, secret) {
  return `${value}.${signValue(value, secret)}`;
}

function decodeSignedValue(value, secret) {
  const separatorIndex = value.lastIndexOf(".");
  if (separatorIndex <= 0) {
    return null;
  }

  const rawValue = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  const expected = signValue(rawValue, secret);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer) ? rawValue : null;
}

function safeCompare(value, expected) {
  const left = Buffer.from(value || "", "utf8");
  const right = Buffer.from(expected || "", "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function getClientAddress(request, trustProxy = false) {
  const forwarded = request.headers["x-forwarded-for"];
  if (trustProxy && typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return request.socket.remoteAddress || "unknown";
}

async function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function sendEmpty(response, statusCode, headers = {}) {
  response.writeHead(statusCode, headers);
  response.end();
}

async function readJsonBody(request, limit = DEFAULT_BODY_LIMIT) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function ensureSameOrigin(request, expectedOrigin = "", trustProxy = false) {
  const origin = request.headers.origin;
  const allowedOrigin = expectedOrigin || getOrigin(request, trustProxy);

  if (origin && origin !== allowedOrigin) {
    throw new HttpError(403, "Cross-site requests are not allowed.");
  }

  const site = request.headers["sec-fetch-site"];
  if (site && !["same-origin", "same-site", "none"].includes(site)) {
    throw new HttpError(403, "Cross-site requests are not allowed.");
  }
}

function buildSessionCookie(token, maxAgeSeconds, secure) {
  return serializeCookie(SESSION_COOKIE_NAME, token, {
    path: "/",
    maxAge: maxAgeSeconds,
    httpOnly: true,
    sameSite: "Lax",
    secure,
  });
}

function buildClearedSessionCookie(secure) {
  return serializeCookie(SESSION_COOKIE_NAME, "", {
    path: "/",
    maxAge: 0,
    expires: new Date(0),
    httpOnly: true,
    sameSite: "Lax",
    secure,
  });
}

function buildClearedSessionCookies() {
  return [
    buildClearedSessionCookie(false),
    buildClearedSessionCookie(true),
  ];
}

async function ensureReadableFile(filePath) {
  await fsp.access(filePath, R_OK);
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
        ...noStoreHeaders(),
      },
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    return {
      statusCode: 416,
      headers: {
        "Content-Range": `bytes */${size}`,
        ...noStoreHeaders(),
      },
    };
  }

  let start;
  let end;

  if (match[1] === "" && match[2] !== "") {
    const suffixLength = Number.parseInt(match[2], 10);
    if (Number.isNaN(suffixLength) || suffixLength <= 0) {
      return {
        statusCode: 416,
        headers: {
          "Content-Range": `bytes */${size}`,
          ...noStoreHeaders(),
        },
      };
    }

    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = match[1] ? Number.parseInt(match[1], 10) : 0;
    end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  }

  if (
    Number.isNaN(start)
    || Number.isNaN(end)
    || start < 0
    || end < start
    || start >= size
  ) {
    return {
      statusCode: 416,
      headers: {
        "Content-Range": `bytes */${size}`,
        ...noStoreHeaders(),
      },
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
      ...noStoreHeaders(),
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

function buildAuthConfig(options = {}) {
  const env = options.env || process.env;
  return {
    password: options.password ?? env.MOVIE_PASSWORD ?? "",
    sessionSecret: options.sessionSecret ?? env.SESSION_SECRET ?? "",
    sessionTtlMs: options.sessionTtlMs ?? parseNumber(env.SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
    bodyLimit: options.bodyLimit ?? parseNumber(env.AUTH_BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT),
    rateLimitWindowMs: options.rateLimitWindowMs
      ?? parseNumber(env.AUTH_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
    rateLimitMaxAttempts: options.rateLimitMaxAttempts
      ?? parseNumber(env.AUTH_RATE_LIMIT_MAX_ATTEMPTS, DEFAULT_RATE_LIMIT_MAX_ATTEMPTS),
  };
}

function createSessionManager(store, authConfig, now = Date.now, trustProxy = false) {
  const prefix = "session:";
  const ttlSeconds = Math.ceil(authConfig.sessionTtlMs / 1000);

  return {
    isConfigured() {
      return Boolean(authConfig.password && authConfig.sessionSecret);
    },
    async create(secure) {
      const sessionId = crypto.randomBytes(24).toString("base64url");
      const expiresAt = now() + authConfig.sessionTtlMs;
      await store.set(`${prefix}${sessionId}`, JSON.stringify({ expiresAt }), authConfig.sessionTtlMs);
      return buildSessionCookie(
        encodeSignedValue(sessionId, authConfig.sessionSecret),
        ttlSeconds,
        secure,
      );
    },
    async get(request, required = true) {
      if (!this.isConfigured()) {
        throw new HttpError(503, "Authentication is not configured.");
      }

      const cookies = parseCookies(request.headers.cookie);
      const rawCookie = cookies[SESSION_COOKIE_NAME];
      if (!rawCookie) {
        if (!required) {
          return null;
        }

        throw new HttpError(401, "Sign in is required.", {
          headers: { "Set-Cookie": buildClearedSessionCookies() },
        });
      }

      const sessionId = decodeSignedValue(rawCookie, authConfig.sessionSecret);
      if (!sessionId) {
        throw new HttpError(401, "Session is invalid.", {
          headers: { "Set-Cookie": buildClearedSessionCookies() },
        });
      }

      const sessionJson = await store.get(`${prefix}${sessionId}`);
      if (!sessionJson) {
        throw new HttpError(401, "Session expired.", {
          headers: { "Set-Cookie": buildClearedSessionCookies() },
        });
      }

      let session;
      try {
        session = JSON.parse(sessionJson);
      } catch {
        await store.delete(`${prefix}${sessionId}`);
        throw new HttpError(401, "Session expired.", {
          headers: { "Set-Cookie": buildClearedSessionCookies() },
        });
      }

      if (!session.expiresAt || session.expiresAt <= now()) {
        await store.delete(`${prefix}${sessionId}`);
        throw new HttpError(401, "Session expired.", {
          headers: { "Set-Cookie": buildClearedSessionCookies() },
        });
      }

      return { sessionId, expiresAt: session.expiresAt };
    },
    async destroy(request) {
      const secure = isSecureRequest(request, trustProxy);
      if (!this.isConfigured()) {
        return buildClearedSessionCookies();
      }

      const cookies = parseCookies(request.headers.cookie);
      const rawCookie = cookies[SESSION_COOKIE_NAME];

      if (!rawCookie) {
        return buildClearedSessionCookies();
      }

      const sessionId = decodeSignedValue(rawCookie, authConfig.sessionSecret);
      if (sessionId) {
        await store.delete(`${prefix}${sessionId}`);
      }

      return buildClearedSessionCookies();
    },
  };
}

function createRateLimiter(store, authConfig, now = Date.now, trustProxy = false) {
  const prefix = "login-attempts:";

  return {
    async assertCanAttempt(request) {
      const key = `${prefix}${getClientAddress(request, trustProxy)}`;
      const stateJson = await store.get(key);
      const state = stateJson ? JSON.parse(stateJson) : null;

      if (!state || state.windowStartedAt + authConfig.rateLimitWindowMs <= now()) {
        return;
      }

      if (state.count >= authConfig.rateLimitMaxAttempts) {
        throw new HttpError(429, "Too many failed sign-in attempts. Please try again later.");
      }
    },
    async recordFailure(request) {
      const key = `${prefix}${getClientAddress(request, trustProxy)}`;
      const stateJson = await store.get(key);
      const currentTime = now();
      let state = stateJson ? JSON.parse(stateJson) : null;

      if (!state || state.windowStartedAt + authConfig.rateLimitWindowMs <= currentTime) {
        state = { count: 0, windowStartedAt: currentTime };
      }

      state.count += 1;
      await store.set(key, JSON.stringify(state), authConfig.rateLimitWindowMs);
    },
    async clear(request) {
      await store.delete(`${prefix}${getClientAddress(request, trustProxy)}`);
    },
  };
}

function createProvider(options = {}) {
  if (options.provider) {
    return options.provider;
  }

  const env = options.env || process.env;
  const providerName = (env.MOVIE_PROVIDER || "local").toLowerCase();

  if (providerName === "onedrive") {
    return createOneDriveProvider({
      env,
      fetchImpl: options.fetchImpl || fetch,
      store: options.store,
    });
  }

  return createLocalProvider({
    moviesDir: options.moviesDir || path.join(__dirname, "movies"),
  });
}

function createAppContext(options = {}) {
  const authConfig = buildAuthConfig(options.auth || {});
  const store = options.store || createKeyValueStore({
    env: options.env || process.env,
    fetchImpl: options.fetchImpl || fetch,
  });
  const provider = createProvider({
    ...options,
    store,
  });
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const appOrigin = options.appOrigin
    || env.APP_ORIGIN
    || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : "");
  const trustProxy = options.trustProxy ?? (env.TRUST_PROXY === "true" || Boolean(env.VERCEL));

  return {
    appOrigin,
    authConfig,
    provider,
    publicDir: path.resolve(options.publicDir || path.join(__dirname, "public")),
    sessionManager: createSessionManager(store, authConfig, now, trustProxy),
    rateLimiter: createRateLimiter(store, authConfig, now, trustProxy),
    trustProxy,
  };
}

function createRequestHandler(options = {}) {
  const context = createAppContext(options);

  return async function handleRequest(request, response) {
    try {
      const url = new URL(request.url, getOrigin(request, context.trustProxy));

      if (request.method === "POST" && url.pathname === "/api/login") {
        ensureSameOrigin(request, context.appOrigin, context.trustProxy);
        if (!context.sessionManager.isConfigured()) {
          throw new HttpError(503, "Authentication is not configured.");
        }

        await context.rateLimiter.assertCanAttempt(request);
        const body = await readJsonBody(request, context.authConfig.bodyLimit);
        const password = typeof body.password === "string" ? body.password : "";

        if (!safeCompare(password, context.authConfig.password)) {
          await context.rateLimiter.recordFailure(request);
          throw new HttpError(401, "The password was not accepted.");
        }

        await context.rateLimiter.clear(request);
        const cookie = await context.sessionManager.create(isSecureRequest(request, context.trustProxy));
        sendEmpty(response, 204, noStoreHeaders({ "Set-Cookie": cookie }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/logout") {
        ensureSameOrigin(request, context.appOrigin, context.trustProxy);
        const cookie = await context.sessionManager.destroy(request);
        sendEmpty(response, 204, noStoreHeaders({ "Set-Cookie": cookie }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/session") {
        if (!context.sessionManager.isConfigured()) {
          await sendJson(response, 200, {
            authenticated: false,
            expiresAt: null,
            provider: context.provider.kind,
            authConfigured: false,
          }, noStoreHeaders());
          return;
        }

        let session = null;

        try {
          session = await context.sessionManager.get(request, false);
        } catch (error) {
          if (error instanceof HttpError && error.statusCode === 401) {
            await sendJson(response, 200, {
              authenticated: false,
              expiresAt: null,
              provider: context.provider.kind,
              authConfigured: true,
            }, noStoreHeaders(error.headers));
            return;
          }
          throw error;
        }

        await sendJson(response, 200, {
          authenticated: Boolean(session),
          expiresAt: session?.expiresAt ?? null,
          provider: context.provider.kind,
          authConfigured: true,
        }, noStoreHeaders());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/movies") {
        await context.sessionManager.get(request, true);
        const movies = await context.provider.listMovies();
        await sendJson(response, 200, movies, noStoreHeaders());
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/playback/")) {
        await context.sessionManager.get(request, true);
        let movieId = "";
        try {
          movieId = decodeURIComponent(url.pathname.slice("/api/playback/".length));
        } catch {
          throw new HttpError(400, "Invalid movie path.");
        }
        const playback = await context.provider.resolvePlayback(movieId);
        await sendJson(response, 200, playback, noStoreHeaders());
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/api/stream/")) {
        await context.sessionManager.get(request, true);

        if (context.provider.kind !== "local") {
          throw new HttpError(404, "Streaming is not available for this provider.");
        }

        const movieId = url.pathname.slice("/api/stream/".length);
        const filePath = context.provider.resolveMoviePath(movieId);

        if (!filePath) {
          throw new HttpError(400, "Invalid movie path.");
        }

        if (!isWithinDirectory(context.provider.moviesDir, filePath)) {
          throw new HttpError(400, "Invalid movie path.");
        }

        if (!isStreamableExtension(filePath)) {
          throw new HttpError(415, "Unsupported movie format.");
        }

        let stats;
        try {
          stats = await fsp.stat(filePath);
        } catch (error) {
          if (error.code === "ENOENT") {
            throw new HttpError(404, "Movie not found.");
          }
          throw error;
        }

        if (!stats.isFile()) {
          throw new HttpError(404, "Movie not found.");
        }

        try {
          await ensureReadableFile(filePath);
        } catch (error) {
          if (error.code === "EACCES") {
            throw new HttpError(403, "Movie is not readable.");
          }
          if (error.code === "ENOENT") {
            throw new HttpError(404, "Movie not found.");
          }
          throw error;
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
      const filePath = path.resolve(context.publicDir, publicPath);

      if (!isWithinDirectory(context.publicDir, filePath) && filePath !== path.join(context.publicDir, "index.html")) {
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
      if (error instanceof HttpError) {
        await sendJson(
          response,
          error.statusCode,
          error.payload,
          noStoreHeaders(error.headers),
        );
        return;
      }

      if (error && Number.isInteger(error.statusCode)) {
        await sendJson(
          response,
          error.statusCode,
          { error: error.message || "Request failed." },
          noStoreHeaders(),
        );
        return;
      }

      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Internal server error." }));
    }
  };
}

function createServer(options = {}) {
  return http.createServer(createRequestHandler(options));
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
  createAppContext,
  createRequestHandler,
  createServer,
  ensureReadableFile,
  getContentType,
  getStreamHeaders,
  isWithinDirectory,
};
