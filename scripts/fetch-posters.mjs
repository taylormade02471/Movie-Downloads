import fs from "node:fs/promises";
import path from "node:path";

import media from "../lib/media.js";

const {
  isStreamableExtension,
  movieTitleFromName,
  posterSlugFromTitle,
} = media;

const repoRoot = path.resolve(import.meta.dirname, "..");
const moviesDir = path.resolve(repoRoot, "movies");
const postersDir = path.resolve(repoRoot, "public", "posters");

function usage() {
  return [
    "Usage:",
    "  npm run posters",
    "  npm run posters -- --site [--force]",
    "  npm run posters -- \"Movie Title\" \"Another Movie\"",
    "",
    "The downloader uses Apple/iTunes movie search and saves clean cover files into public/posters/.",
  ].join("\n");
}

function movieLookupFromName(name) {
  const title = movieTitleFromName(name);
  const yearMatch = String(name || "").match(/\b((?:19|20)\d{2})\b/);
  return {
    title,
    searchTitle: yearMatch ? `${title} ${yearMatch[1]}` : title,
  };
}

async function findMovieTitlesFromSite() {
  const origin = String(process.env.APP_ORIGIN || "").replace(/\/$/, "");
  const password = process.env.MOVIE_PASSWORD || "";
  if (!origin || !password) {
    throw new Error("--site requires APP_ORIGIN and MOVIE_PASSWORD in the environment");
  }

  const loginResponse = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({ password }),
    redirect: "manual",
  });
  if (!loginResponse.ok) {
    throw new Error(`Live Movie Room login failed: ${loginResponse.status}`);
  }

  const cookieHeader = loginResponse.headers.get("set-cookie") || "";
  const sessionCookie = cookieHeader.split(";", 1)[0];
  if (!sessionCookie) {
    throw new Error("Live Movie Room login did not return a session cookie");
  }

  const libraryResponse = await fetch(`${origin}/api/library`, {
    headers: {
      Accept: "application/json",
      Cookie: sessionCookie,
    },
  });
  if (!libraryResponse.ok) {
    throw new Error(`Live Movie Room library failed: ${libraryResponse.status}`);
  }

  const library = await libraryResponse.json();
  return Array.isArray(library.movies)
    ? library.movies
      .map((movie) => movieLookupFromName(movie.fileName || movie.title || ""))
      .filter((movie) => movie.title)
    : [];
}

async function findMovieTitles(rootDir) {
  const titles = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && isStreamableExtension(entry.name)) {
        titles.push(movieLookupFromName(entry.name));
      }
    }
  }

  await walk(rootDir);
  return titles;
}

function artworkUrlForPoster(result) {
  const url = result?.artworkUrl100 || "";
  if (!url) {
    return "";
  }

  return url.replace(/100x100bb\.(jpg|png|webp)$/i, "600x900bb.$1");
}

function comparableTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchPoster(title, searchTitle = title) {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", searchTitle);
  url.searchParams.set("media", "movie");
  url.searchParams.set("entity", "movie");
  url.searchParams.set("limit", "5");

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Poster search failed for ${title}: ${response.status}`);
  }

  const payload = await response.json();
  const normalizedTitle = comparableTitle(title);
  const results = Array.isArray(payload.results) ? payload.results : [];
  const best = results.find((result) => (
    comparableTitle(result.trackName) === normalizedTitle
  )) || results[0];

  const applePosterUrl = artworkUrlForPoster(best);
  if (applePosterUrl) {
    return {
      posterUrl: applePosterUrl,
      matchedTitle: best?.trackName || "",
      source: "Apple",
    };
  }

  const wikipediaUrl = new URL("https://en.wikipedia.org/w/api.php");
  const wikipediaParams = {
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: `${searchTitle} film`,
    gsrnamespace: "0",
    gsrlimit: "5",
    prop: "pageimages|description|info",
    piprop: "thumbnail",
    pithumbsize: "600",
    pilicense: "any",
    inprop: "url",
    origin: "*",
  };
  for (const [key, value] of Object.entries(wikipediaParams)) {
    wikipediaUrl.searchParams.set(key, value);
  }

  const wikipediaResponse = await fetch(wikipediaUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "MovieRoom/1.0 private media library",
    },
  });
  if (!wikipediaResponse.ok) {
    throw new Error(`Wikipedia poster search failed for ${title}: ${wikipediaResponse.status}`);
  }

  const wikipediaPayload = await wikipediaResponse.json();
  const pages = Array.isArray(wikipediaPayload?.query?.pages)
    ? wikipediaPayload.query.pages
    : [];
  const filmPages = pages.filter((page) => (
    page?.thumbnail?.source
    && /\b(film|movie)\b/i.test(String(page.description || ""))
  ));
  const normalizedSearchTitle = comparableTitle(searchTitle);
  const searchTokens = new Set(normalizedSearchTitle.split(" ").filter(Boolean));
  const scoredPages = filmPages.map((page, index) => {
    const pageTitle = comparableTitle(page.title);
    const pageTokens = new Set(pageTitle.split(" ").filter(Boolean));
    const overlap = [...searchTokens].filter((token) => pageTokens.has(token)).length;
    let score = overlap * 5 - index;
    if (pageTitle === normalizedTitle) {
      score += 120;
    } else if (pageTitle.startsWith(normalizedSearchTitle)) {
      score += 100;
    } else if (pageTitle.startsWith(normalizedTitle)) {
      score += 80;
    }
    return { page, score };
  });
  scoredPages.sort((left, right) => right.score - left.score);
  const wikipediaBest = scoredPages[0]?.page;

  return {
    posterUrl: wikipediaBest?.thumbnail?.source || "",
    matchedTitle: wikipediaBest?.title || "",
    source: "Wikipedia",
  };
}

async function downloadPoster({ title, searchTitle }, force = false) {
  const slug = posterSlugFromTitle(title);
  const destination = path.join(postersDir, `${slug}.jpg`);

  try {
    await fs.access(destination);
    if (!force) {
      console.log(`skip ${title} -> ${path.relative(repoRoot, destination)}`);
      return;
    }
  } catch {
    // Download below.
  }

  const { posterUrl, matchedTitle, source } = await searchPoster(title, searchTitle);
  if (!posterUrl) {
    console.warn(`missing ${title}: no poster result`);
    return;
  }

  const imageResponse = await fetch(posterUrl);
  if (!imageResponse.ok) {
    throw new Error(`Poster image failed for ${title}: ${imageResponse.status}`);
  }
  const contentType = imageResponse.headers.get("content-type") || "";
  if (!/^image\/jpe?g\b/i.test(contentType)) {
    console.warn(`missing ${title}: poster result is ${contentType || "not a JPEG"}`);
    return;
  }

  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  await fs.mkdir(postersDir, { recursive: true });
  await fs.writeFile(destination, bytes);
  console.log(`saved ${title}${matchedTitle ? ` (${matchedTitle})` : ""} from ${source} -> ${path.relative(repoRoot, destination)}`);
}

const commandArguments = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
const useLiveSite = commandArguments.includes("--site");
const forceDownload = commandArguments.includes("--force");
const explicitTitles = commandArguments.filter((value) => value !== "--site" && value !== "--force");
const titles = explicitTitles.length
  ? explicitTitles.map((title) => ({ title, searchTitle: title }))
  : useLiveSite
    ? await findMovieTitlesFromSite()
    : await findMovieTitles(moviesDir);
const uniqueTitles = Array.from(new Map(titles.map((movie) => [movie.title, movie])).values())
  .filter((movie) => movie.title);

if (!uniqueTitles.length) {
  console.log(usage());
  process.exit(0);
}

for (const movie of uniqueTitles) {
  try {
    await downloadPoster(movie, forceDownload);
  } catch (error) {
    console.warn(`failed ${movie.title}: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
}
