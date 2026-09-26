const test = require("node:test");
const assert = require("node:assert/strict");

const { createJellyfinProvider } = require("../lib/providers/jellyfin");

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("Jellyfin provider lists playable movies and episodes with app artwork URLs", async () => {
  const requests = [];
  const provider = createJellyfinProvider({
    env: {
      JELLYFIN_URL: "http://jellyfin.local:8096",
      JELLYFIN_API_KEY: "server-key",
      JELLYFIN_LIBRARY_ID: "library-1",
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return jsonResponse({
        Items: [
          {
            Id: "movie-1",
            Type: "Movie",
            Name: "Toy Story 5",
            Path: "C:\\Movies\\Toy Story 5.mp4",
            Size: 1234,
            ProductionYear: 2026,
            RunTimeTicks: 76800000000,
            CommunityRating: 8.2,
            OfficialRating: "PG-13",
            Overview: "A family adventure.",
            People: [{ Type: "Actor", Name: "Example Actor" }, { Type: "Director", Name: "Example Director" }],
            Studios: [{ Name: "Taylor-Made Pictures" }],
            Tags: ["family", "adventure"],
            Genres: ["Family"],
            BackdropImageTags: ["backdrop"],
          },
          {
            Id: "episode-1",
            Type: "Episode",
            Name: "The Bumpy Road to Love",
            SeriesName: "Northern Exposure",
            SeasonName: "Season 3",
            ParentIndexNumber: 3,
            IndexNumber: 1,
            Path: "C:\\TV\\Northern Exposure\\Season 3\\episode.avi",
          },
          { Id: "folder-1", Type: "Folder", Name: "Ignore me", Path: "C:\\Movies" },
        ],
      });
    },
  });

  const library = await provider.listLibrary();
  assert.equal(library.movies.length, 2);
  assert.equal(library.movies[0].posterUrl, "/api/jellyfin/image/movie-1");
  assert.equal(library.movies[0].backdropUrl, "/api/jellyfin/image/movie-1?type=Backdrop");
  assert.equal(library.movies[0].description, "A family adventure.");
  assert.equal(library.movies[0].runtime, "2h 08m");
  assert.equal(library.movies[0].rating, "8.2");
  assert.deepEqual(library.movies[0].cast, ["Example Actor"]);
  assert.deepEqual(library.movies[0].director, ["Example Director"]);
  assert.equal(library.movies[1].folder, "Northern Exposure/Season 3");
  assert.equal(library.folders.some((folder) => folder.path === "Northern Exposure/Season 3"), true);
  assert.match(requests[0].url, /\/Items\?/);
  assert.match(requests[0].url, /ParentId=library-1/);
  assert.equal(requests[0].options.headers["X-Emby-Token"], "server-key");
});

test("Jellyfin provider resolves playback and forwards byte ranges to Jellyfin", async () => {
  const requests = [];
  const provider = createJellyfinProvider({
    env: { JELLYFIN_URL: "http://jellyfin.local:8096", JELLYFIN_API_KEY: "server-key" },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("/Items/movie-1?")) {
        return jsonResponse({
          Id: "movie-1",
          Name: "Toy Story 5",
          Path: "C:\\Movies\\Toy Story 5.mp4",
          MediaSources: [{ MediaStreams: [{ Type: "Video", Codec: "h264" }] }],
        });
      }
      return new Response("movie-bytes", {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": "bytes 0-10/100",
          "accept-ranges": "bytes",
        },
      });
    },
  });

  const playback = await provider.resolvePlayback("movie-1");
  assert.deepEqual(playback, {
    url: "/api/jellyfin/stream?movieId=movie-1",
    expiresAt: null,
    contentType: "video/mp4",
    title: "Toy Story 5",
  });

  const upstream = await provider.proxyStream("movie-1", {
    method: "GET",
    headers: { range: "bytes=0-10" },
  });
  assert.equal(upstream.status, 206);
  const streamRequest = requests.find((entry) => entry.url.includes("/Videos/movie-1/stream"));
  assert.match(streamRequest.url, /Static=true/);
  assert.equal(streamRequest.options.headers.Range, "bytes=0-10");
  assert.equal(streamRequest.options.headers["X-Emby-Token"], "server-key");
});

test("Jellyfin provider fails closed when the server key is missing", async () => {
  const provider = createJellyfinProvider({ env: { JELLYFIN_URL: "http://jellyfin.local:8096" } });
  await assert.rejects(provider.listMovies(), /JELLYFIN_API_KEY is not configured/i);
});
