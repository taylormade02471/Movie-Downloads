function createApp({
  movieSelect,
  reloadButton,
  player,
  status,
  fetchImpl,
  locationOrigin,
  createOption,
}) {
  function updateStatus(message) {
    status.textContent = message;
  }

  function movieLabel(movie) {
    const sizeInGb = (movie.size / (1024 ** 3)).toFixed(2);
    return `${movie.title} (${sizeInGb} GB)`;
  }

  async function loadLibrary(selectedStreamPath = movieSelect.value) {
    updateStatus("Loading library…");

    const response = await fetchImpl("/api/movies");
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
      const option = createOption();
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

    player.src = new URL(streamPath, locationOrigin).toString();
    player.load();
    updateStatus("Connecting to stream and buffering playback…");
  }

  function initialize() {
    movieSelect.addEventListener("change", playSelectedMovie);
    reloadButton.addEventListener("click", async () => {
      try {
        const previousSelection = movieSelect.value;
        const movies = await loadLibrary(previousSelection);
        const selectedStreamUrl = movieSelect.value
          ? new URL(movieSelect.value, locationOrigin).toString()
          : "";

        if (movies.length && (!selectedStreamUrl || player.currentSrc !== selectedStreamUrl)) {
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
  }

  return {
    initialize,
    loadLibrary,
    movieLabel,
    playSelectedMovie,
    updateStatus,
  };
}

if (typeof document !== "undefined") {
  createApp({
    movieSelect: document.getElementById("movie-select"),
    reloadButton: document.getElementById("reload"),
    player: document.getElementById("player"),
    status: document.getElementById("status"),
    fetchImpl: fetch,
    locationOrigin: window.location.origin,
    createOption: () => document.createElement("option"),
  }).initialize();
}

if (typeof module !== "undefined") {
  module.exports = { createApp };
}
