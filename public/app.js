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
  setTimeoutImpl = (callback, delay) => setTimeout(callback, delay),
  clearTimeoutImpl = (timer) => clearTimeout(timer),
  stallRecoveryMs = 12000,
  maxPlaybackRefreshes = 3,
}) {
  let playbackRefreshInProgress = false;
  let playbackRefreshAttempts = 0;
  let resumeAfterRefresh = null;
  let stallRecoveryTimer = null;
  let stallPosition = null;
  let playbackRequestVersion = 0;
  let stableRefreshPosition = null;

  function updateStatus(message) {
    status.textContent = message;
  }

  function clearStallRecovery() {
    if (stallRecoveryTimer !== null) {
      clearTimeoutImpl(stallRecoveryTimer);
      stallRecoveryTimer = null;
    }
    stallPosition = null;
  }

  function bufferedSecondsAhead() {
    if (!player.buffered || typeof player.buffered.length !== "number") {
      return 0;
    }

    const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
    try {
      for (let index = 0; index < player.buffered.length; index += 1) {
        const start = player.buffered.start(index);
        const end = player.buffered.end(index);
        if (currentTime >= start - 0.25 && currentTime <= end + 0.25) {
          return Math.max(0, end - currentTime);
        }
      }
    } catch {
      return 0;
    }

    return 0;
  }

  function statusWithBuffer(message) {
    const seconds = Math.floor(bufferedSecondsAhead());
    return seconds >= 2 ? `${message} ${seconds} seconds ready ahead.` : message;
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
    const size = Number(movie.size) || 0;
    const folderLabel = movie.folder ? ` — ${movie.folder}` : "";
    if (size <= 0) {
      return `${movie.title}${folderLabel} (still uploading)`;
    }

    const sizeInGb = (size / (1024 ** 3)).toFixed(2);
    return `${movie.title}${folderLabel} (${sizeInGb} GB)`;
  }

  async function handleApiResponse(response, fallbackMessage) {
    if (response.status === 401) {
      clearStallRecovery();
      playbackRequestVersion += 1;
      resumeAfterRefresh = null;
      movieSelect.value = "";
      setAuthenticated(false);
      player.removeAttribute("src");
      player.load();
      const sessionError = new Error("Your session expired. Sign in again to keep watching.");
      sessionError.code = "SESSION_EXPIRED";
      throw sessionError;
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

    const playableMovies = movies.filter((movie) => (Number(movie.size) || 0) > 0);

    for (const movie of movies) {
      const option = createOption();
      option.value = movie.id;
      option.textContent = movieLabel(movie);
      option.disabled = (Number(movie.size) || 0) <= 0;
      movieSelect.appendChild(option);
    }

    if (!playableMovies.length) {
      clearStallRecovery();
      playbackRequestVersion += 1;
      movieSelect.value = "";
      movieSelect.disabled = true;
      player.removeAttribute("src");
      player.load();
      updateStatus("Movies are listed, but they are still uploading to OneDrive.");
      return [];
    }

    const playableIds = new Set(playableMovies.map((movie) => movie.id));
    movieSelect.value = selectedMovieId && playableIds.has(selectedMovieId)
      ? selectedMovieId
      : playableMovies[0].id;

    movieSelect.disabled = false;
    updateStatus("Library ready. Loading the selected movie for smooth playback.");
    return playableMovies;
  }

  async function playSelectedMovie({ isRefresh = false, expectedMovieId = null, resumeState = null } = {}) {
    const movieId = expectedMovieId || movieSelect.value;
    if (!isRefresh) {
      clearStallRecovery();
      playbackRefreshAttempts = 0;
      resumeAfterRefresh = null;
      stableRefreshPosition = null;
    }

    if (!movieId || (expectedMovieId && movieSelect.value !== expectedMovieId)) {
      updateStatus("Select a movie to start streaming.");
      return false;
    }

    const requestVersion = ++playbackRequestVersion;
    updateStatus("Requesting a secure playback link…");
    let playback;
    try {
      const response = await handleApiResponse(
        await fetchImpl("/api/playback", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ movieId }),
        }),
        "Unable to start playback.",
      );
      playback = await response.json();
    } catch (error) {
      const superseded = requestVersion !== playbackRequestVersion || movieSelect.value !== movieId;
      if (superseded && error?.code !== "SESSION_EXPIRED") {
        return false;
      }
      throw error;
    }

    if (requestVersion !== playbackRequestVersion || movieSelect.value !== movieId) {
      return false;
    }

    if (resumeState?.movieId === movieId) {
      resumeAfterRefresh = resumeState;
      stableRefreshPosition = resumeState.position;
    }
    player.preload = "auto";
    player.src = /^https?:\/\//i.test(playback.url)
      ? playback.url
      : new URL(playback.url, locationOrigin).toString();
    player.load();
    updateStatus("Loading video ahead for smooth playback…");
    return true;
  }

  async function refreshPlaybackLink(finalMessage) {
    clearStallRecovery();
    const movieId = movieSelect.value;

    if (!movieId || playbackRefreshInProgress) {
      return false;
    }

    if (playbackRefreshAttempts >= maxPlaybackRefreshes) {
      resumeAfterRefresh = null;
      updateStatus(finalMessage);
      return false;
    }

    playbackRefreshAttempts += 1;
    playbackRefreshInProgress = true;
    const resumeState = {
      movieId,
      position: Number.isFinite(player.currentTime) ? player.currentTime : 0,
      shouldPlay: !player.paused && !player.ended,
    };
    updateStatus("Refreshing the secure stream and keeping your place…");

    try {
      const refreshed = await playSelectedMovie({
        isRefresh: true,
        expectedMovieId: movieId,
        resumeState,
      });
      if (!refreshed && resumeAfterRefresh?.movieId === movieId) {
        resumeAfterRefresh = null;
      }
      return refreshed;
    } catch (error) {
      resumeAfterRefresh = null;
      updateStatus(error.message);
      return false;
    } finally {
      playbackRefreshInProgress = false;
    }
  }

  function scheduleStallRecovery(message) {
    updateStatus(statusWithBuffer(message));

    if (
      stallRecoveryTimer !== null
      || playbackRefreshInProgress
      || !movieSelect.value
      || player.paused
      || player.ended
    ) {
      return;
    }

    const movieId = movieSelect.value;
    const position = Number.isFinite(player.currentTime) ? player.currentTime : 0;
    const sourceVersion = playbackRequestVersion;
    stallPosition = position;
    stallRecoveryTimer = setTimeoutImpl(() => {
      stallRecoveryTimer = null;
      stallPosition = null;

      if (
        playbackRequestVersion !== sourceVersion
        || movieSelect.value !== movieId
        || player.paused
        || player.ended
        || (Number.isFinite(player.currentTime) && player.currentTime > position + 0.5)
        || bufferedSecondsAhead() >= 2
      ) {
        return;
      }

      void refreshPlaybackLink("The stream could not keep a stable connection. Reload the movie to try again.");
    }, stallRecoveryMs);
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
      return;
    }

    await playSelectedMovie();
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

    clearStallRecovery();
    playbackRequestVersion += 1;
    resumeAfterRefresh = null;
    setAuthenticated(false);
    movieSelect.innerHTML = "";
    movieSelect.value = "";
    movieSelect.disabled = true;
    player.removeAttribute("src");
    player.load();
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
      scheduleStallRecovery("Loading more video while keeping your place…");
    });

    player.addEventListener("canplay", () => {
      if (bufferedSecondsAhead() >= 2) {
        clearStallRecovery();
      }
      updateStatus(statusWithBuffer("Ready to play."));
    });

    player.addEventListener("canplaythrough", () => {
      clearStallRecovery();
      updateStatus(statusWithBuffer("Ready for smooth playback."));
    });

    player.addEventListener("playing", () => {
      clearStallRecovery();
      updateStatus(statusWithBuffer("Streaming now."));
    });

    player.addEventListener("progress", () => {
      const secondsAhead = bufferedSecondsAhead();
      if (secondsAhead >= 2) {
        clearStallRecovery();
        updateStatus(statusWithBuffer(player.paused ? "Ready to play." : "Streaming now."));
      }
    });

    player.addEventListener("timeupdate", () => {
      if (
        stallRecoveryTimer !== null
        && stallPosition !== null
        && Number.isFinite(player.currentTime)
        && player.currentTime > stallPosition + 0.5
      ) {
        clearStallRecovery();
      }

      if (
        stableRefreshPosition !== null
        && Number.isFinite(player.currentTime)
        && player.currentTime >= stableRefreshPosition + 30
      ) {
        playbackRefreshAttempts = 0;
        stableRefreshPosition = null;
      }
    });

    player.addEventListener("pause", clearStallRecovery);
    player.addEventListener("ended", clearStallRecovery);

    player.addEventListener("loadedmetadata", () => {
      if (!resumeAfterRefresh) {
        return;
      }

      const { movieId, position, shouldPlay } = resumeAfterRefresh;
      resumeAfterRefresh = null;

      if (movieSelect.value !== movieId) {
        return;
      }

      if (position > 0 && Number.isFinite(player.duration)) {
        player.currentTime = Math.min(position, Math.max(player.duration - 0.1, 0));
      }

      if (shouldPlay && typeof player.play === "function") {
        const playPromise = player.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {});
        }
      }
    });

    player.addEventListener("stalled", () => {
      scheduleStallRecovery("Connection slowed down. Loading more video while keeping your place…");
    });

    player.addEventListener("error", () => {
      clearStallRecovery();
      const mediaErrorCode = player.error?.code;
      if (mediaErrorCode === 1) {
        return;
      }
      if (mediaErrorCode === 3 || mediaErrorCode === 4) {
        resumeAfterRefresh = null;
        updateStatus("This video format is not supported smoothly by this browser. MP4 with H.264 video and AAC audio works best.");
        return;
      }

      if (mediaErrorCode !== 2) {
        resumeAfterRefresh = null;
        updateStatus("This movie could not be played in the browser.");
        return;
      }

      void refreshPlaybackLink("This movie could not keep a stable streaming connection.");
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
