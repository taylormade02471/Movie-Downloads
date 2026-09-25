const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");

const { createReadStream, promises: fsp } = fs;
const { R_OK } = fs.constants;

const {
  getContentType,
  isStreamableExtension,
  movieTitleFromName,
} = require("./lib/media");
const { createLocalProvider } = require("./lib/providers/local");
const { createOneDriveProvider } = require("./lib/providers/onedrive");
const { createJellyfinProvider } = require("./lib/providers/jellyfin");
const { createKeyValueStore } = require("./lib/store");
const { createViewerStateManager, normalizeProfileId } = require("./lib/viewer-state");

const DEFAULT_BODY_LIMIT = 8 * 1024;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX_ATTEMPTS = 5;
const DEFAULT_TV_PAIRING_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_TV_PAIRING_RATE_LIMIT_MAX_ATTEMPTS = 10;
const DEFAULT_CAST_PLAYBACK_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TV_PAIRING_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TV_DEVICE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = "movie_room_session";
const CAST_TICKET_PREFIX = "cast-playback:";
const TV_PAIRING_PREFIX = "tv-pairing:";
const TV_CODE_PREFIX = "tv-code:";
const TV_DEVICE_PREFIX = "tv-device:";

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
    ...mediaFeatureHeaders(),
    ...extraHeaders,
  };
}

function mediaFeatureHeaders(extraHeaders = {}) {
  return {
    "Permissions-Policy": "autoplay=(self), fullscreen=(self), geolocation=(self), local-network=(self), local-network-access=(self), loopback-network=(self), picture-in-picture=(self), screen-wake-lock=(self)",
    ...extraHeaders,
  };
}

function castMediaHeaders(extraHeaders = {}) {
  return {
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type",
    "Cross-Origin-Resource-Policy": "cross-origin",
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
  const left = crypto.createHash("sha256").update(value || "", "utf8").digest();
  const right = crypto.createHash("sha256").update(expected || "", "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

function normalizePairingCode(code) {
  return String(code || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function generatePairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return code;
}

function hashSecret(secret, sessionSecret) {
  return crypto
    .createHmac("sha256", sessionSecret)
    .update(String(secret || ""))
    .digest("base64url");
}

function readBearerToken(request) {
  const header = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

async function authenticateTvRequest(context, request) {
  return context.tvDeviceManager.authenticateDevice(readBearerToken(request));
}

function readViewerProfile(value) {
  try {
    return normalizeProfileId(value || "home");
  } catch {
    throw new HttpError(400, "A valid viewer profile is required.");
  }
}

function assertViewerStateReady(context) {
  if (!context.viewerStateManager.isReady()) {
    throw new HttpError(503, "Viewer state storage is not configured.");
  }
}

function viewerStateOperations(body) {
  if (!body || !Array.isArray(body.operations)) {
    throw new HttpError(400, "Viewer-state operations are required.");
  }
  return body.operations;
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

function getStreamHeaders(filePath, size, range, extraHeaders = {}) {
  const contentType = getContentType(filePath);

  if (!range) {
    return {
      statusCode: 200,
      headers: {
        "Content-Length": size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        ...noStoreHeaders(extraHeaders),
      },
    };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    return {
      statusCode: 416,
      headers: {
        "Content-Range": `bytes */${size}`,
        ...noStoreHeaders(extraHeaders),
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
          ...noStoreHeaders(extraHeaders),
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
        ...noStoreHeaders(extraHeaders),
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
      ...noStoreHeaders(extraHeaders),
    },
    start,
    end,
  };
}

function streamFile(request, response, filePath, size, extraHeaders = {}) {
  const streamResponse = getStreamHeaders(filePath, size, request.headers.range, extraHeaders);
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

function createSessionManager(
  store,
  authConfig,
  now = Date.now,
  trustProxy = false,
  storageReady = true,
) {
  const prefix = "session:";
  const ttlSeconds = Math.ceil(authConfig.sessionTtlMs / 1000);

  return {
    isConfigured() {
      return Boolean(
        authConfig.password
        && Buffer.byteLength(authConfig.sessionSecret, "utf8") >= 32
        && storageReady,
      );
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

async function proxyFetchResponse(request, response, upstream, extraHeaders = {}) {
  const headers = {};
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  Object.assign(headers, noStoreHeaders(extraHeaders));
  response.writeHead(upstream.status, headers);
  if (request.method === "HEAD" || !upstream.body) {
    response.end();
    return;
  }
  Readable.fromWeb(upstream.body).on("error", () => response.destroy()).pipe(response);
}

function createRequestRateLimiter(store, {
  prefix,
  windowMs,
  maxAttempts,
  message,
}, now = Date.now, trustProxy = false) {
  return {
    async recordAndAssert(request) {
      const key = `${prefix}${getClientAddress(request, trustProxy)}`;
      const currentTime = now();
      const stateJson = await store.get(key);
      let state = stateJson ? JSON.parse(stateJson) : null;

      if (!state || state.windowStartedAt + windowMs <= currentTime) {
        state = { count: 0, windowStartedAt: currentTime };
      }

      state.count += 1;
      await store.set(key, JSON.stringify(state), windowMs);

      if (state.count > maxAttempts) {
        throw new HttpError(429, message);
      }
    },
  };
}

function createCastPlaybackManager(
  store,
  authConfig,
  provider,
  now = Date.now,
  ticketTtlMs = DEFAULT_CAST_PLAYBACK_TTL_MS,
) {
  return {
    async create(movieId, sessionExpiresAt) {
      const movies = await provider.listMovies();
      const movie = movies.find((entry) => entry.id === movieId);

      if (!movie) {
        throw new HttpError(404, "The movie is not in the configured movie folder.");
      }
      if ((Number(movie.size) || 0) <= 0) {
        throw new HttpError(409, "This movie is still uploading.");
      }

      const mediaName = movie.fileName || movie.id;
      // Jellyfin has already classified the item as playable and may transcode
      // containers such as AVI. Local/OneDrive providers still use the app's
      // conservative browser extension allow-list.
      if (provider.kind !== "jellyfin" && !isStreamableExtension(mediaName)) {
        throw new HttpError(415, "Unsupported movie format.");
      }

      const issuedAt = now();
      const expiresAt = Math.min(issuedAt + ticketTtlMs, sessionExpiresAt);
      const ticketId = crypto.randomBytes(32).toString("base64url");
      const record = {
        expiresAt,
        movieId,
        provider: provider.kind,
      };

      await store.set(
        `${CAST_TICKET_PREFIX}${ticketId}`,
        JSON.stringify(record),
        Math.max(1, expiresAt - issuedAt),
      );

      return {
        contentType: getContentType(mediaName),
        expiresAt,
        ticket: encodeSignedValue(ticketId, authConfig.sessionSecret),
        title: movie.title || movieTitleFromName(mediaName),
      };
    },

    async get(ticket) {
      const ticketId = decodeSignedValue(ticket || "", authConfig.sessionSecret);
      if (!ticketId) {
        throw new HttpError(401, "This Cast playback link is invalid or expired.");
      }

      const recordJson = await store.get(`${CAST_TICKET_PREFIX}${ticketId}`);
      if (!recordJson) {
        throw new HttpError(401, "This Cast playback link is invalid or expired.");
      }

      let record;
      try {
        record = JSON.parse(recordJson);
      } catch {
        await store.delete(`${CAST_TICKET_PREFIX}${ticketId}`);
        throw new HttpError(401, "This Cast playback link is invalid or expired.");
      }

      if (
        !record.movieId
        || record.provider !== provider.kind
        || !record.expiresAt
        || record.expiresAt <= now()
      ) {
        await store.delete(`${CAST_TICKET_PREFIX}${ticketId}`);
        throw new HttpError(401, "This Cast playback link is invalid or expired.");
      }

      return record;
    },
  };
}

function parseStoredRecord(recordJson, missingStatus, missingMessage) {
  if (!recordJson) {
    throw new HttpError(missingStatus, missingMessage);
  }

  try {
    return JSON.parse(recordJson);
  } catch {
    throw new HttpError(missingStatus, missingMessage);
  }
}

function createTvDeviceManager(
  store,
  authConfig,
  now = Date.now,
  options = {},
) {
  const pairingTtlMs = options.pairingTtlMs || DEFAULT_TV_PAIRING_TTL_MS;
  const deviceTtlMs = options.deviceTtlMs || DEFAULT_TV_DEVICE_TTL_MS;
  const expiredPairingRetentionMs = options.expiredPairingRetentionMs || pairingTtlMs;

  async function readPairing(pairingId) {
    const normalizedPairingId = String(pairingId || "");
    const record = parseStoredRecord(
      await store.get(`${TV_PAIRING_PREFIX}${normalizedPairingId}`),
      404,
      "Fire TV pairing was not found.",
    );

    if (!record.expiresAt || record.expiresAt <= now()) {
      throw new HttpError(410, "Fire TV pairing code expired.");
    }

    return { pairingId: normalizedPairingId, record };
  }

  async function writePairing(pairingId, record) {
    await store.set(
      `${TV_PAIRING_PREFIX}${pairingId}`,
      JSON.stringify(record),
      Math.max(1, record.expiresAt - now() + expiredPairingRetentionMs),
    );
  }

  return {
    async createPairing({ deviceLabel, pollSecret }) {
      if (!pollSecret) {
        throw new HttpError(400, "A polling secret is required.");
      }

      const createdAt = now();
      const expiresAt = createdAt + pairingTtlMs;
      const pairingId = crypto.randomBytes(18).toString("base64url");
      const code = generatePairingCode();
      const record = {
        status: "pending",
        codeHash: hashSecret(code, authConfig.sessionSecret),
        pollSecretHash: hashSecret(pollSecret, authConfig.sessionSecret),
        deviceLabel: String(deviceLabel || "Fire TV").trim().slice(0, 80) || "Fire TV",
        createdAt,
        expiresAt,
      };

      await writePairing(pairingId, record);
      await store.set(
        `${TV_CODE_PREFIX}${code}`,
        JSON.stringify({ pairingId }),
        pairingTtlMs + expiredPairingRetentionMs,
      );

      return { pairingId, code, expiresAt };
    },

    async approvePairing({ code, sessionId, profileId }) {
      const normalizedCode = normalizePairingCode(code);
      if (!normalizedCode) {
        throw new HttpError(400, "A Fire TV pairing code is required.");
      }

      const codeRecord = parseStoredRecord(
        await store.get(`${TV_CODE_PREFIX}${normalizedCode}`),
        404,
        "Fire TV pairing code was not found.",
      );
      const { pairingId, record } = await readPairing(codeRecord.pairingId);

      if (!safeCompare(record.codeHash, hashSecret(normalizedCode, authConfig.sessionSecret))) {
        throw new HttpError(404, "Fire TV pairing code was not found.");
      }
      if (record.status !== "pending") {
        throw new HttpError(409, "Fire TV pairing code was already used.");
      }

      const approvedAt = now();
      const expiresAt = approvedAt + deviceTtlMs;
      const deviceId = crypto.randomBytes(18).toString("base64url");
      const rawSecret = crypto.randomBytes(32).toString("base64url");
      const deviceToken = `${deviceId}.${rawSecret}`;
      let assignedProfileId;
      try {
        assignedProfileId = normalizeProfileId(profileId || "home");
      } catch {
        throw new HttpError(400, "A valid viewer profile is required.");
      }

      await store.set(
        `${TV_DEVICE_PREFIX}${deviceId}`,
        JSON.stringify({
          tokenHash: hashSecret(rawSecret, authConfig.sessionSecret),
          deviceLabel: record.deviceLabel,
          profileId: assignedProfileId,
          createdAt: approvedAt,
          expiresAt,
          revokedAt: null,
        }),
        deviceTtlMs,
      );

      await writePairing(pairingId, {
        ...record,
        status: "approved",
        deviceId,
        oneTimeDeviceToken: deviceToken,
        approvedAt,
        approvedBy: sessionId,
      });
      await store.delete(`${TV_CODE_PREFIX}${normalizedCode}`);

      return {
        status: "approved",
        deviceId,
        deviceLabel: record.deviceLabel,
        profileId: assignedProfileId,
        expiresAt,
      };
    },

    async pollPairing({ pairingId, pollSecret }) {
      const pairing = await readPairing(pairingId);
      const { record } = pairing;
      const pollSecretHash = hashSecret(pollSecret, authConfig.sessionSecret);
      if (!safeCompare(record.pollSecretHash, pollSecretHash)) {
        throw new HttpError(401, "Fire TV polling secret was not accepted.");
      }

      if (record.status === "pending") {
        return { status: "pending", expiresAt: record.expiresAt };
      }
      if (record.status === "approved") {
        if (record.oneTimeDeviceToken) {
          const response = {
            status: "approved",
            deviceId: record.deviceId,
            deviceToken: record.oneTimeDeviceToken,
          };
          const nextRecord = { ...record };
          delete nextRecord.oneTimeDeviceToken;
          await writePairing(pairing.pairingId, nextRecord);
          return response;
        }

        return { status: "approved", deviceId: record.deviceId };
      }

      throw new HttpError(409, "Fire TV pairing was already resolved.");
    },

    async authenticateDevice(token) {
      const separatorIndex = String(token || "").indexOf(".");
      if (separatorIndex <= 0) {
        throw new HttpError(401, "Fire TV device token is invalid.");
      }

      const deviceId = token.slice(0, separatorIndex);
      const rawSecret = token.slice(separatorIndex + 1);
      if (!deviceId || !rawSecret) {
        throw new HttpError(401, "Fire TV device token is invalid.");
      }

      let record = parseStoredRecord(
        await store.get(`${TV_DEVICE_PREFIX}${deviceId}`),
        401,
        "Fire TV device token is invalid or expired.",
      );

      const currentTime = now();
      if (!record.expiresAt || record.expiresAt <= currentTime || record.revokedAt) {
        await store.delete(`${TV_DEVICE_PREFIX}${deviceId}`);
        throw new HttpError(401, "Fire TV device token is invalid or expired.");
      }
      if (!safeCompare(record.tokenHash, hashSecret(rawSecret, authConfig.sessionSecret))) {
        throw new HttpError(401, "Fire TV device token is invalid or expired.");
      }

      const refreshedExpiresAt = Math.max(record.expiresAt, currentTime + deviceTtlMs);
      if (refreshedExpiresAt !== record.expiresAt) {
        record = { ...record, expiresAt: refreshedExpiresAt };
        await store.set(
          `${TV_DEVICE_PREFIX}${deviceId}`,
          JSON.stringify(record),
          deviceTtlMs,
        );
      }

      return {
        deviceId,
        expiresAt: record.expiresAt,
        deviceLabel: record.deviceLabel,
        profileId: record.profileId || "home",
      };
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

  if (providerName === "jellyfin") {
    return createJellyfinProvider({
      env,
      fetchImpl: options.fetchImpl || fetch,
    });
  }

  return createLocalProvider({
    moviesDir: options.moviesDir || path.join(__dirname, "movies"),
  });
}

function createPlaybackResolver(provider) {
  const pending = new Map();

  return async function resolvePlayback(movieId) {
    const existing = pending.get(movieId);
    if (existing) {
      return existing;
    }

    const resolution = Promise.resolve()
      .then(() => provider.resolvePlayback(movieId))
      .finally(() => {
        pending.delete(movieId);
      });
    pending.set(movieId, resolution);
    return resolution;
  };
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
  const storageReady = !env.VERCEL || store.durable === true;
  const castPlaybackTtlMs = options.castPlaybackTtlMs
    ?? parseNumber(env.CAST_PLAYBACK_TTL_MS, DEFAULT_CAST_PLAYBACK_TTL_MS);
  const castPlaybackManager = createCastPlaybackManager(
    store,
    authConfig,
    provider,
    now,
    castPlaybackTtlMs,
  );
  const tvDeviceManager = createTvDeviceManager(store, authConfig, now, {
    pairingTtlMs: options.tvPairingTtlMs,
    deviceTtlMs: options.tvDeviceTtlMs,
  });
  const viewerStateManager = createViewerStateManager({
    store,
    listMovies: () => provider.listMovies(),
    now,
    durable: storageReady,
  });
  const tvPairingRateLimiter = createRequestRateLimiter(store, {
    prefix: "tv-pairing-attempts:",
    windowMs: options.tvPairingRateLimitWindowMs
      ?? parseNumber(env.TV_PAIRING_RATE_LIMIT_WINDOW_MS, DEFAULT_TV_PAIRING_RATE_LIMIT_WINDOW_MS),
    maxAttempts: options.tvPairingRateLimitMaxAttempts
      ?? parseNumber(env.TV_PAIRING_RATE_LIMIT_MAX_ATTEMPTS, DEFAULT_TV_PAIRING_RATE_LIMIT_MAX_ATTEMPTS),
    message: "Too many Fire TV pairing codes were requested. Please try again later.",
  }, now, trustProxy);

  return {
    appOrigin,
    authConfig,
    castPlaybackManager,
    provider,
    resolvePlayback: createPlaybackResolver(provider),
    publicDir: path.resolve(options.publicDir || path.join(__dirname, "public")),
    sessionManager: createSessionManager(store, authConfig, now, trustProxy, storageReady),
    rateLimiter: createRateLimiter(store, authConfig, now, trustProxy),
    viewerStateManager,
    tvPairingRateLimiter,
    trustProxy,
    tvDeviceManager,
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

      if (request.method === "POST" && url.pathname === "/api/tv/pairings") {
        await context.tvPairingRateLimiter.recordAndAssert(request);
        const body = await readJsonBody(request, context.authConfig.bodyLimit);
        const pairing = await context.tvDeviceManager.createPairing({
          deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : "",
          pollSecret: typeof body.pollSecret === "string" ? body.pollSecret : "",
        });
        await sendJson(response, 201, pairing, noStoreHeaders());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tv/pairings/approve") {
        ensureSameOrigin(request, context.appOrigin, context.trustProxy);
        const session = await context.sessionManager.get(request, true);
        const body = await readJsonBody(request, context.authConfig.bodyLimit);
        const approved = await context.tvDeviceManager.approvePairing({
          code: typeof body.code === "string" ? body.code : "",
          sessionId: session.sessionId,
          profileId: readViewerProfile(body.profileId),
        });
        await sendJson(response, 200, approved, noStoreHeaders());
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/tv/pairings/")) {
        const pairingId = decodeURIComponent(url.pathname.slice("/api/tv/pairings/".length));
        const polled = await context.tvDeviceManager.pollPairing({
          pairingId,
          pollSecret: readBearerToken(request),
        });
        await sendJson(response, 200, polled, noStoreHeaders());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tv/library") {
        await authenticateTvRequest(context, request);
        const library = typeof context.provider.listLibrary === "function"
          ? await context.provider.listLibrary()
          : { movies: await context.provider.listMovies(), folders: [] };
        await sendJson(response, 200, library, noStoreHeaders());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tv/viewer-state") {
        const device = await authenticateTvRequest(context, request);
        assertViewerStateReady(context);
        const state = await context.viewerStateManager.get(device.profileId || "home");
        await sendJson(response, 200, state, noStoreHeaders());
        return;
      }

      if (request.method === "PATCH" && url.pathname === "/api/tv/viewer-state") {
        const device = await authenticateTvRequest(context, request);
        assertViewerStateReady(context);
        const body = await readJsonBody(request, context.authConfig.bodyLimit);
        if (Object.prototype.hasOwnProperty.call(body, "profileId")) {
          throw new HttpError(400, "Paired TV profile cannot be changed by the device.");
        }
        const state = await context.viewerStateManager.apply(
          device.profileId || "home",
          viewerStateOperations(body),
        );
        await sendJson(response, 200, state, noStoreHeaders());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tv/playback") {
        const device = await authenticateTvRequest(context, request);
        const body = await readJsonBody(request, context.authConfig.bodyLimit);
        const movieId = typeof body.movieId === "string" ? body.movieId : "";

        if (!movieId) {
          throw new HttpError(400, "A movie id is required.");
        }

        const tvPlayback = await context.castPlaybackManager.create(movieId, device.expiresAt);
        const ticketUrl = new URL(
          "/api/cast/stream",
          context.appOrigin || getOrigin(request, context.trustProxy),
        );
        ticketUrl.searchParams.set("ticket", tvPlayback.ticket);
        await sendJson(response, 200, {
          url: ticketUrl.toString(),
          contentType: tvPlayback.contentType,
          title: tvPlayback.title,
          expiresAt: tvPlayback.expiresAt,
        }, noStoreHeaders());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/movies") {
        await context.sessionManager.get(request, true);
        const movies = await context.provider.listMovies();
        await sendJson(response, 200, movies, noStoreHeaders());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/viewer-state") {
        await context.sessionManager.get(request, true);
        assertViewerStateReady(context);
        const profileId = readViewerProfile(url.searchParams.get("profileId"));
        const state = await context.viewerStateManager.get(profileId);
        await sendJson(response, 200, state, noStoreHeaders());
        return;
      }

      if (request.method === "PATCH" && url.pathname === "/api/viewer-state") {
        ensureSameOrigin(request, context.appOrigin, context.trustProxy);
        await context.sessionManager.get(request, true);
        assertViewerStateReady(context);
        const body = await readJsonBody(request, context.authConfig.bodyLimit);
        const profileId = readViewerProfile(body.profileId);
        const state = await context.viewerStateManager.apply(
          profileId,
          viewerStateOperations(body),
        );
        await sendJson(response, 200, state, noStoreHeaders());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/library") {
        await context.sessionManager.get(request, true);
        const library = typeof context.provider.listLibrary === "function"
          ? await context.provider.listLibrary()
          : { movies: await context.provider.listMovies(), folders: [] };
        await sendJson(response, 200, library, noStoreHeaders());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/playback") {
        ensureSameOrigin(request, context.appOrigin, context.trustProxy);
        await context.sessionManager.get(request, true);
        const body = await readJsonBody(request, context.authConfig.bodyLimit);
        const movieId = typeof body.movieId === "string" ? body.movieId : "";

        if (!movieId) {
          throw new HttpError(400, "A movie id is required.");
        }

        const playback = await context.resolvePlayback(movieId);
        await sendJson(response, 200, playback, noStoreHeaders());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/cast/playback") {
        ensureSameOrigin(request, context.appOrigin, context.trustProxy);
        const session = await context.sessionManager.get(request, true);
        const body = await readJsonBody(request, context.authConfig.bodyLimit);
        const movieId = typeof body.movieId === "string" ? body.movieId : "";

        if (!movieId) {
          throw new HttpError(400, "A movie id is required.");
        }

        const castPlayback = await context.castPlaybackManager.create(movieId, session.expiresAt);
        const ticketUrl = new URL(
          "/api/cast/stream",
          context.appOrigin || getOrigin(request, context.trustProxy),
        );
        ticketUrl.searchParams.set("ticket", castPlayback.ticket);
        await sendJson(response, 200, {
          url: ticketUrl.toString(),
          contentType: castPlayback.contentType,
          title: castPlayback.title,
          expiresAt: castPlayback.expiresAt,
        }, noStoreHeaders());
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/playback/")) {
        await context.sessionManager.get(request, true);
        let movieId = "";
        const routeMovieId = url.searchParams.get("movieId");

        if (routeMovieId) {
          movieId = routeMovieId;
        } else {
          try {
            movieId = decodeURIComponent(url.pathname.slice("/api/playback/".length));
          } catch {
            throw new HttpError(400, "Invalid movie path.");
          }
        }

        const playback = await context.resolvePlayback(movieId);
        await sendJson(response, 200, playback, noStoreHeaders());
        return;
      }

      if (request.method === "OPTIONS" && url.pathname === "/api/cast/stream") {
        sendEmpty(response, 204, noStoreHeaders(castMediaHeaders()));
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/cast/stream") {
        const corsHeaders = castMediaHeaders();
        for (const [name, value] of Object.entries(corsHeaders)) {
          response.setHeader(name, value);
        }

        const castPlayback = await context.castPlaybackManager.get(url.searchParams.get("ticket"));

        if (context.provider.kind === "jellyfin") {
          const upstream = await context.provider.proxyStream(castPlayback.movieId, request);
          await proxyFetchResponse(request, response, upstream, castMediaHeaders());
          return;
        }

        if (context.provider.kind !== "local") {
          const playback = await context.resolvePlayback(castPlayback.movieId);
          if (!playback?.url || !playback.url.startsWith("https://")) {
            throw new HttpError(502, "The movie provider did not return a secure playback link.");
          }

          response.writeHead(307, noStoreHeaders(castMediaHeaders({
            Location: playback.url,
          })));
          response.end();
          return;
        }

        const filePath = context.provider.resolveMoviePath(castPlayback.movieId);
        if (!filePath || !isWithinDirectory(context.provider.moviesDir, filePath)) {
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

        await ensureReadableFile(filePath);
        if (request.method === "HEAD") {
          const streamResponse = getStreamHeaders(
            filePath,
            stats.size,
            request.headers.range,
            corsHeaders,
          );
          response.writeHead(streamResponse.statusCode, streamResponse.headers);
          response.end();
          return;
        }

        streamFile(request, response, filePath, stats.size, corsHeaders);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/api/jellyfin/image/")) {
        await context.sessionManager.get(request, true);
        if (context.provider.kind !== "jellyfin") {
          throw new HttpError(404, "Jellyfin artwork is not enabled.");
        }
        const itemId = decodeURIComponent(url.pathname.slice("/api/jellyfin/image/".length));
        if (!itemId) throw new HttpError(400, "A Jellyfin item id is required.");
        const upstream = await context.provider.proxyImage(itemId, request);
        await proxyFetchResponse(request, response, upstream);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/jellyfin/stream") {
        await context.sessionManager.get(request, true);
        if (context.provider.kind !== "jellyfin") {
          throw new HttpError(404, "Jellyfin streaming is not enabled.");
        }
        const itemId = url.searchParams.get("movieId") || "";
        if (!itemId) throw new HttpError(400, "A Jellyfin item id is required.");
        const upstream = await context.provider.proxyStream(itemId, request);
        await proxyFetchResponse(request, response, upstream);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/api/stream/")) {
        await context.sessionManager.get(request, true);

        if (context.provider.kind !== "local") {
          throw new HttpError(404, "Streaming is not available for this provider.");
        }

        const movieId = url.searchParams.get("movieId") || url.pathname.slice("/api/stream/".length);
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
        ...mediaFeatureHeaders(),
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
  createPlaybackResolver,
  createRequestHandler,
  createServer,
  ensureReadableFile,
  getContentType,
  getStreamHeaders,
  isWithinDirectory,
};
