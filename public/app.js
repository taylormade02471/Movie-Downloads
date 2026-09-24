const movieSelect = document.getElementById("movie-select");
const reloadButton = document.getElementById("reload");
const player = document.getElementById("player");
const status = document.getElementById("status");

function updateStatus(message) {
  status.textContent = message;
}

function movieLabel(movie) {
  const sizeInGb = (movie.size / (1024 ** 3)).toFixed(2);
  return `${movie.title} (${sizeInGb} GB)`;
}

async function loadLibrary(selectedStreamPath = movieSelect.value) {
  updateStatus("Loading library…");

  const response = await fetch("/api/movies");
  if (!response.ok) {
    throw new Error("Unable to load movie library.");
  }

  const movies = await response.json();
  movieSelect.innerHTML = "";

  if (!movies.length) {
    player.removeAttribute("src");
    player.load();
    updateStatus("No movies found yet. Add video files to the movies folder.");
    return [];
  }

  for (const movie of movies) {
    const option = document.createElement("option");
    option.value = movie.streamPath;
    option.textContent = movieLabel(movie);
    movieSelect.appendChild(option);
  }

  const availablePaths = new Set(movies.map((movie) => movie.streamPath));
  if (selectedStreamPath && availablePaths.has(selectedStreamPath)) {
    movieSelect.value = selectedStreamPath;
  }

  updateStatus("Library ready. Select a movie to start streaming.");
  return movies;
}

function playSelectedMovie() {
  const streamPath = movieSelect.value;
  if (!streamPath || !streamPath.startsWith("/api/stream/")) {
    updateStatus("Invalid movie stream path.");
    return;
  }

  player.src = new URL(streamPath, window.location.origin).toString();
  player.load();
  updateStatus("Connecting to stream and buffering playback…");
}

movieSelect.addEventListener("change", playSelectedMovie);
reloadButton.addEventListener("click", async () => {
  try {
    const previousSelection = movieSelect.value;
    const movies = await loadLibrary(previousSelection);
    if (movies.length && (!previousSelection || movieSelect.value !== previousSelection || !player.currentSrc)) {
      playSelectedMovie();
    }
  } catch (error) {
    updateStatus(error.message);
  }
});

player.addEventListener("waiting", () => {
  updateStatus("Buffering more video in the background…");
});

player.addEventListener("canplay", () => {
  updateStatus("Ready to play.");
});

player.addEventListener("playing", () => {
  updateStatus("Streaming now.");
});

player.addEventListener("stalled", () => {
  updateStatus("Connection slowed down. Waiting for more buffered video…");
});

player.addEventListener("error", () => {
  updateStatus("This movie could not be played in the browser.");
});

loadLibrary()
  .then((movies) => {
    if (movies.length) {
      playSelectedMovie();
    }
  })
  .catch((error) => {
    updateStatus(error.message);
  });
