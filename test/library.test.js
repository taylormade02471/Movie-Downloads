const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createLocalProvider } = require("../lib/providers/local");
const { isSampleVideo } = require("../lib/library");

test("local provider recursively scans the canonical root and groups seasons", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "movie-room-library-"));
  fs.mkdirSync(path.join(root, "TV Shows", "Northern Exposure", "Northern Exposure Season 3"), { recursive: true });
  fs.mkdirSync(path.join(root, "TV Shows", "Jackass", "Season 01"), { recursive: true });
  fs.mkdirSync(path.join(root, "Movies", "Acme"), { recursive: true });
  fs.mkdirSync(path.join(root, "Movies", "Acme", "Sample"), { recursive: true });
  fs.writeFileSync(path.join(root, "TV Shows", "Northern Exposure", "Northern Exposure Season 3", "Northern Exposure S03E01.avi"), "episode");
  fs.writeFileSync(path.join(root, "TV Shows", "Jackass", "Season 01", "Jackass - S01E01 - Pilot.mkv"), "episode");
  fs.writeFileSync(path.join(root, "Movies", "Acme", "Acme.mp4"), "movie");
  fs.writeFileSync(path.join(root, "Movies", "Acme", "Sample", "Acme.sample.mkv"), "sample");

  const library = await createLocalProvider({ moviesDir: root }).listLibrary();
  assert.equal(library.movies.length, 3);
  assert.deepEqual(
    library.series.map((series) => ({ title: series.title, seasons: series.seasonCount, episodes: series.episodeCount })),
    [
      { title: "Jackass", seasons: 1, episodes: 1 },
      { title: "Northern Exposure", seasons: 1, episodes: 1 },
    ],
  );
  assert.equal(library.movies.find((movie) => movie.fileName.endsWith(".avi")).contentType, "episode");
  assert.equal(library.movies.find((movie) => movie.title === "Acme").contentType, "movie");
  assert.equal(isSampleVideo("Movies/Acme/Sample/Acme.sample.mkv", "Acme.sample.mkv"), true);
});

test("local provider excludes application, recovery, and known release duplicate roots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "movie-room-dedup-"));
  fs.mkdirSync(path.join(root, "Movies"), { recursive: true });
  fs.mkdirSync(path.join(root, "Applications"), { recursive: true });
  fs.mkdirSync(path.join(root, "_Recovery", "duplicates-2026-09-26"), { recursive: true });
  fs.mkdirSync(path.join(root, "www.Torrenting.com - Bomb.Girls.Facing.the.Enemy.2014.1080p.WEB.H264-DiMEPiECE"), { recursive: true });
  fs.writeFileSync(path.join(root, "Movies", "Bomb Girls Facing the Enemy.mkv"), "organized");
  fs.writeFileSync(path.join(root, "Applications", "old.apk"), "not media");
  fs.writeFileSync(path.join(root, "_Recovery", "duplicates-2026-09-26", "Bomb Girls Facing the Enemy.mkv"), "backup");
  fs.writeFileSync(path.join(root, "www.Torrenting.com - Bomb.Girls.Facing.the.Enemy.2014.1080p.WEB.H264-DiMEPiECE", "Bomb.Girls.mkv"), "duplicate");

  const library = await createLocalProvider({ moviesDir: root }).listLibrary();
  assert.deepEqual(library.movies.map((movie) => movie.title), ["Bomb Girls Facing the Enemy"]);
  assert.equal(library.folders.some((folder) => folder.path === "_Recovery"), false);
  assert.equal(library.folders.some((folder) => folder.path === "Applications"), false);
});
