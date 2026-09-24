const { isStreamableExtension, movieTitleFromName } = require("../media");

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const REFRESH_TOKEN_KEY = "onedrive:refresh-token";

function asProviderError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function mapWithConcurrency(items, limit, iteratee) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function createFolderEntry(entry, folder) {
  const folderPath = folder ? `${folder}/${entry.name}` : entry.name;
  const parent = folder || "";
  return {
    id: entry.id,
    path: folderPath,
    name: entry.name,
    parent,
    source: "onedrive",
    hidden: entry.name.startsWith("."),
  };
}

function withFolderCounts(folders, movies) {
  return folders.map((folder) => {
    const descendantMovies = movies.filter((movie) => (
      movie.folder === folder.path || movie.folder.startsWith(`${folder.path}/`)
    ));
    return {
      ...folder,
      movieCount: descendantMovies.length,
      playableCount: descendantMovies.filter((movie) => (Number(movie.size) || 0) > 0).length,
      uploadingCount: descendantMovies.filter((movie) => (Number(movie.size) || 0) <= 0).length,
    };
  });
}

function createOneDriveProvider({ env = process.env, fetchImpl = fetch, store }) {
  const config = {
    clientId: env.ONEDRIVE_CLIENT_ID || "",
    clientSecret: env.ONEDRIVE_CLIENT_SECRET || "",
    publicClient: env.ONEDRIVE_PUBLIC_CLIENT === "true",
    redirectUri: env.ONEDRIVE_REDIRECT_URI || "",
    refreshToken: env.ONEDRIVE_REFRESH_TOKEN || "",
    driveId: env.ONEDRIVE_DRIVE_ID || "",
    rootItemId: env.ONEDRIVE_ROOT_ITEM_ID || "",
  };

  let cachedToken = null;
  let cachedTokenExpiresAt = 0;

  async function getPersistedRefreshToken() {
    if (!store) {
      return config.refreshToken;
    }

    return (await store.get(REFRESH_TOKEN_KEY)) || config.refreshToken;
  }

  async function persistRefreshToken(refreshToken) {
    if (!refreshToken || !store) {
      return;
    }

    await store.set(REFRESH_TOKEN_KEY, refreshToken);
    config.refreshToken = refreshToken;
  }

  async function fetchJson(url, accessToken, options = {}) {
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + accessToken,
        ...(options.headers || {}),
      },
    });

    if (response.status === 401 || response.status === 403) {
      const error = asProviderError("OneDrive authorization failed.", 502);
      error.oneDriveAuthorizationFailure = true;
      throw error;
    }

    if (response.status === 404) {
      throw asProviderError("The configured OneDrive folder or movie was not found.", 404);
    }

    if (!response.ok) {
      throw asProviderError("OneDrive did not accept the request.", 502);
    }

    return response.json();
  }

  async function fetchDownloadUrl(accessToken, movieId) {
    const response = await fetchImpl(
      `${GRAPH_ROOT}/drives/${encodeURIComponent(config.driveId)}`
        + `/items/${encodeURIComponent(movieId)}/content`,
      {
        headers: {
          Authorization: "Bearer " + accessToken,
        },
        redirect: "manual",
      },
    );

    if (response.status === 401 || response.status === 403) {
      const error = asProviderError("OneDrive authorization failed.", 502);
      error.oneDriveAuthorizationFailure = true;
      throw error;
    }

    if (response.status === 404) {
      throw asProviderError("The configured OneDrive folder or movie was not found.", 404);
    }

    if (response.status < 300 || response.status >= 400) {
      throw asProviderError("OneDrive did not return a playback URL.", 502);
    }

    const downloadUrl = response.headers?.get("location") || "";
    if (!downloadUrl.startsWith("https://")) {
      throw asProviderError("OneDrive did not return a playback URL.", 502);
    }

    return downloadUrl;
  }

  async function getAccessToken() {
    if (!config.clientId || !config.redirectUri || !config.driveId || !config.rootItemId) {
      throw asProviderError("OneDrive is not fully configured.");
    }

    if (!config.publicClient && !config.clientSecret) {
      throw asProviderError(
        "OneDrive is missing ONEDRIVE_CLIENT_SECRET. Set ONEDRIVE_PUBLIC_CLIENT=true only for public-client app registrations.",
      );
    }

    if (cachedToken && cachedTokenExpiresAt > Date.now() + 60_000) {
      return cachedToken;
    }

    const refreshToken = await getPersistedRefreshToken();
    if (!refreshToken) {
      throw asProviderError("OneDrive is missing a refresh token.");
    }

    const body = new URLSearchParams({
      client_id: config.clientId,
      grant_type: "refresh_token",
      redirect_uri: config.redirectUri,
      refresh_token: refreshToken,
      scope: "offline_access Files.Read",
    });

    if (config.clientSecret) {
      body.set("client_secret", config.clientSecret);
    }

    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      throw asProviderError("OneDrive refresh token exchange failed.", 502);
    }

    const payload = await response.json();
    if (!payload.access_token) {
      throw asProviderError("OneDrive did not return an access token.", 502);
    }

    cachedToken = payload.access_token;
    cachedTokenExpiresAt = Date.now() + (Number(payload.expires_in) || 3600) * 1000;

    if (payload.refresh_token) {
      await persistRefreshToken(payload.refresh_token);
    }

    return cachedToken;
  }

  async function withAccessTokenRetry(operation) {
    let accessToken = await getAccessToken();

    try {
      return await operation(accessToken);
    } catch (error) {
      if (!error?.oneDriveAuthorizationFailure) {
        throw error;
      }

      cachedToken = null;
      cachedTokenExpiresAt = 0;
      accessToken = await getAccessToken();
      return operation(accessToken);
    }
  }

  async function listChildren(accessToken, itemId, folder = "") {
    const movies = [];
    const folders = [];
    let nextUrl = `${GRAPH_ROOT}/drives/${encodeURIComponent(config.driveId)}`
      + `/items/${encodeURIComponent(itemId)}/children`
      + "?$select=id,name,size,file,folder";

    while (nextUrl) {
      const payload = await fetchJson(nextUrl, accessToken);
      const childFolders = [];

      for (const entry of payload.value || []) {
        if (entry.folder) {
          childFolders.push(entry);
          folders.push(createFolderEntry(entry, folder));
          continue;
        }

        if (!entry.file || !isStreamableExtension(entry.name)) {
          continue;
        }

        movies.push({
          id: entry.id,
          title: movieTitleFromName(entry.name),
          fileName: entry.name,
          folder,
          extension: entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase(),
          size: entry.size || 0,
          source: "onedrive",
        });
      }

      if (childFolders.length) {
        const nestedMovies = await mapWithConcurrency(
          childFolders,
          3,
          (entry) => {
            const nextFolder = folder ? `${folder}/${entry.name}` : entry.name;
            return listChildren(accessToken, entry.id, nextFolder);
          },
        );
        for (const nestedLibrary of nestedMovies) {
          movies.push(...nestedLibrary.movies);
          folders.push(...nestedLibrary.folders);
        }
      }

      nextUrl = payload["@odata.nextLink"] || "";
    }

    return { movies, folders };
  }

  async function listLibraryWithAccessToken(accessToken) {
    const library = await listChildren(accessToken, config.rootItemId);
    library.movies.sort((left, right) => {
      const byTitle = left.title.localeCompare(right.title);
      const byFolder = left.folder.localeCompare(right.folder);
      return byTitle || byFolder || left.id.localeCompare(right.id);
    });
    library.folders = withFolderCounts(library.folders, library.movies).sort((left, right) => (
      left.path.localeCompare(right.path)
    ));
    return library;
  }

  return {
    kind: "onedrive",
    async listLibrary() {
      return withAccessTokenRetry((accessToken) => listLibraryWithAccessToken(accessToken));
    },
    async listMovies() {
      const library = await withAccessTokenRetry((accessToken) => listLibraryWithAccessToken(accessToken));
      return library.movies;
    },
    async resolvePlayback(movieId) {
      return withAccessTokenRetry(async (accessToken) => {
        const movies = (await listLibraryWithAccessToken(accessToken)).movies;
        if (!movies.some((movie) => movie.id === movieId)) {
          throw asProviderError("The movie is not in the configured movie folder.", 404);
        }

        const payload = await fetchJson(
          `${GRAPH_ROOT}/drives/${encodeURIComponent(config.driveId)}`
            + `/items/${encodeURIComponent(movieId)}`
            + "?$select=id,name,file,size,@microsoft.graph.downloadUrl",
          accessToken,
        );

        if (!payload.file || !isStreamableExtension(payload.name || "")) {
          throw asProviderError("Unsupported movie format.", 415);
        }

        const downloadUrl = payload["@microsoft.graph.downloadUrl"]
          || await fetchDownloadUrl(accessToken, movieId);

        return {
          url: downloadUrl,
          expiresAt: null,
        };
      });
    },
  };
}

module.exports = {
  createOneDriveProvider,
};
