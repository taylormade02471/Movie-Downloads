function createApp({
  movieSelect,
  reloadButton,
  logoutButton,
  passwordForm,
  passwordInput,
  submitButton,
  player,
  status,
  loginStatus,
  authPanel,
  libraryPanel,
  fetchImpl,
  locationOrigin,
  createOption,
}) {
  function updateStatus(message) {
    status.textContent = message;
  }

  function updateLoginStatus(message) {
    loginStatus.textContent = message;
  }

  function setPasswordErrorState(hasError) {
    if (typeof passwordInput.setAttribute !== "function" || typeof passwordInput.removeAttribute !== "function") {
      return;
    }

    if (hasError) {
      passwordInput.setAttribute("aria-invalid", "true");
      return;
    }

    passwordInput.removeAttribute("aria-invalid");
  }

  function setAuthenticated(authenticated) {
    authPanel.hidden = authenticated;
    libraryPanel.hidden = !authenticated;
  }

  function setAuthUnavailable(unavailable) {
    passwordInput.disabled = unavailable;
    if (submitButton) {
      submitButton.disabled = unavailable;
    }
  }

  function announceLoginError(message) {
    updateLoginStatus(message);
    setPasswordErrorState(true);
    if (typeof loginStatus.focus === "function") {
      loginStatus.focus();
    }
  }

  function movieLabel(movie) {
    const sizeInGb = (movie.size / (1024 ** 3)).toFixed(2);
    const folderLabel = movie.folder ? ` — ${movie.folder}` : "";
    return `${movie.title}${folderLabel} (${sizeInGb} GB)`;
  }

  async function handleApiResponse(response, fallbackMessage) {
    if (response.status === 401) {
      setAuthenticated(false);
      player.removeAttribute("src");
      player.load();
      throw new Error("Your session expired. Sign in again to keep watching.");
    }

    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      throw new Error(payload?.error || fallbackMessage);
    }

    return response;
  }

  async function loadLibrary(selectedMovieId = movieSelect.value) {
    updateStatus("Loading library…");
    movieSelect.disabled = true;

    const response = await handleApiResponse(
      await fetchImpl("/api/movies", { credentials: "same-origin" }),
      "Unable to load movie library.",
    );

    const movies = await response.json();
    movieSelect.innerHTML = "";

    if (!movies.length) {
      movieSelect.disabled = true;
      player.removeAttribute("src");
      player.load();
      updateStatus("No movies found yet. Add supported video files to the active movie provider.");
      return [];
    }

    for (const movie of movies) {
      const option = createOption();
      option.value = movie.id;
      option.textContent = movieLabel(movie);
      movieSelect.appendChild(option);
    }

    const availableIds = new Set(movies.map((movie) => movie.id));
    if (selectedMovieId && availableIds.has(selectedMovieId)) {
      movieSelect.value = selectedMovieId;
    }

    movieSelect.disabled = false;
    updateStatus("Library ready. Select a movie to start streaming.");
    return movies;
  }

  async function playSelectedMovie() {
    const movieId = movieSelect.value;
    if (!movieId) {
      updateStatus("Select a movie to start streaming.");
      return;
    }

    updateStatus("Requesting a secure playback link…");
    const response = await handleApiResponse(
      await fetchImpl(`/api/playback/${encodeURIComponent(movieId)}`, {
        credentials: "same-origin",
      }),
      "Unable to start playback.",
    );
    const playback = await response.json();

    player.src = /^https?:\/\//i.test(playback.url)
      ? playback.url
      : new URL(playback.url, locationOrigin).toString();
    player.load();
    updateStatus("Connecting to stream and buffering playback…");
  }

  async function loadSession() {
    const response = await fetchImpl("/api/session", { credentials: "same-origin" });
    if (response.status === 401) {
      setAuthUnavailable(false);
      setAuthenticated(false);
      updateStatus("Sign in to browse the movie library.");
      return false;
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const message = payload?.error || "Unable to verify the current session.";
      if (response.status === 503) {
        setAuthUnavailable(true);
        updateLoginStatus(message);
      }
      setAuthenticated(false);
      updateStatus(message);
      return false;
    }

    const session = await response.json();
    setAuthUnavailable(false);
    if (session.authConfigured === false) {
      setAuthenticated(false);
      updateLoginStatus("Authentication is not configured yet.");
      updateStatus("Authentication is not configured yet.");
      setAuthUnavailable(true);
      return false;
    }
    setAuthenticated(session.authenticated);
    if (!session.authenticated) {
      updateStatus("Sign in to browse the movie library.");
      return false;
    }

    return true;
  }

  async function handleLogin(event) {
    event.preventDefault();
    updateLoginStatus("Signing in…");

    const response = await fetchImpl("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: passwordInput.value }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      if (response.status === 503) {
        setAuthUnavailable(true);
      }
      announceLoginError(payload?.error || "Unable to sign in.");
      setAuthenticated(false);
      passwordInput.select();
      return;
    }

    passwordInput.value = "";
    updateLoginStatus("");
    setPasswordErrorState(false);
    setAuthUnavailable(false);
    setAuthenticated(true);
    let movies;
    try {
      movies = await loadLibrary();
    } catch (error) {
      if (authPanel.hidden) {
        setAuthenticated(false);
      }
      throw error;
    }
    if (!movies.length) {
      updateStatus("No movies found yet. Add supported video files to the active movie provider.");
    }
  }

  async function handleLogout() {
    const response = await fetchImpl("/api/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    await handleApiResponse(response, "Unable to sign out.");

    setAuthenticated(false);
    player.removeAttribute("src");
    player.load();
    movieSelect.innerHTML = "";
    movieSelect.disabled = true;
    updateStatus("Signed out.");
  }

  function initialize() {
    movieSelect.addEventListener("change", () => {
      playSelectedMovie().catch((error) => {
        updateStatus(error.message);
      });
    });

    reloadButton.addEventListener("click", async () => {
      try {
        const previousSelection = movieSelect.value;
        const movies = await loadLibrary(previousSelection);

        if (movies.length && movieSelect.value) {
          await playSelectedMovie();
        }
      } catch (error) {
        updateStatus(error.message);
      }
    });

    logoutButton.addEventListener("click", () => {
      handleLogout().catch((error) => {
        updateStatus(error.message);
      });
    });

    passwordForm.addEventListener("submit", (event) => {
      handleLogin(event).catch((error) => {
        announceLoginError(error.message);
      });
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

    loadSession()
      .then(async (authenticated) => {
        if (!authenticated) {
          return;
        }

        const movies = await loadLibrary();
        if (movies.length) {
          await playSelectedMovie();
        }
      })
      .catch((error) => {
        updateStatus(error.message);
      });
  }

  return {
    handleLogin,
    handleLogout,
    initialize,
    loadLibrary,
    loadSession,
    movieLabel,
    playSelectedMovie,
    setAuthenticated,
    updateStatus,
  };
}

if (typeof document !== "undefined") {
  createApp({
    movieSelect: document.getElementById("movie-select"),
    reloadButton: document.getElementById("reload"),
    logoutButton: document.getElementById("logout"),
    passwordForm: document.getElementById("password-form"),
    passwordInput: document.getElementById("password"),
    submitButton: document.getElementById("login-submit"),
    player: document.getElementById("player"),
    status: document.getElementById("status"),
    loginStatus: document.getElementById("login-status"),
    authPanel: document.getElementById("auth-panel"),
    libraryPanel: document.getElementById("library-panel"),
    fetchImpl: fetch,
    locationOrigin: window.location.origin,
    createOption: () => document.createElement("option"),
  }).initialize();
}

if (typeof module !== "undefined") {
  module.exports = { createApp };
}
