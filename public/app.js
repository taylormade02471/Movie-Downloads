function createApp({
  movieSelect,
  reloadButton,
  logoutButton,
  searchInput,
  passwordForm,
  passwordInput,
  submitButton,
  player,
  status,
  bufferStatus,
  loginStatus,
  librarySummary,
  folderShelf,
  movieGrid,
  permissionPanel,
  enablePermissionsButton,
  skipPermissionsButton,
  permissionStatus,
  castButton,
  tvGuideTitle,
  tvGuideSteps,
  tvGuideStatus,
  keepAwakeButton,
  fullscreenButton,
  authPanel,
  libraryPanel,
  fetchImpl,
  locationOrigin,
  createOption,
  documentRef = typeof document !== "undefined" ? document : null,
  navigatorRef = typeof navigator !== "undefined" ? navigator : null,
  windowRef = typeof window !== "undefined" ? window : null,
  localStorageRef = typeof localStorage !== "undefined" ? localStorage : null,
  mediaMetadataCtor = typeof MediaMetadata !== "undefined" ? MediaMetadata : null,
  setTimeoutImpl = (callback, delay) => setTimeout(callback, delay),
  clearTimeoutImpl = (timer) => clearTimeout(timer),
  stallRecoveryMs = 12000,
  maxPlaybackRefreshes = 3,
  targetBufferSeconds = 300,
}) {
  let playbackRefreshInProgress = false;
  let playbackRefreshAttempts = 0;
  let resumeAfterRefresh = null;
  let stallRecoveryTimer = null;
  let stallPosition = null;
  let playbackRequestVersion = 0;
  let stableRefreshPosition = null;
  let allMovies = [];
  let allFolders = [];
  let activeFolder = "all";
  let searchTerm = "";
  let wakeLock = null;
  let keepAwakeWanted = true;
  let safariAirPlayAvailable = false;
  let googleCastContext = null;
  let googleCastReady = false;
  let authenticated = false;
  const expectedLibraryCount = 16;
  const permissionStorageKey = "movie_room_permissions_v1";

  function hasMethod(value, methodName) {
    return Boolean(value && typeof value[methodName] === "function");
  }

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
    updateBufferStatus();
    if (seconds >= targetBufferSeconds) {
      return `${message} 5 minutes ready ahead.`;
    }
    return seconds >= 2 ? `${message} ${formatBufferSeconds(seconds)} ready ahead.` : message;
  }

  function formatBufferSeconds(seconds) {
    if (seconds >= 60) {
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return remainingSeconds
        ? `${minutes} min ${remainingSeconds} sec`
        : `${minutes} min`;
    }

    return `${seconds} seconds`;
  }

  function updateBufferStatus() {
    if (!bufferStatus) {
      return;
    }

    const seconds = Math.floor(bufferedSecondsAhead());
    const progress = Math.min(seconds / targetBufferSeconds, 1);
    bufferStatus.textContent = seconds >= targetBufferSeconds
      ? "Buffer target met: 5 minutes ready ahead."
      : `Buffer target: ${formatBufferSeconds(seconds)} ready of 5 minutes.`;
    if (bufferStatus.style) {
      bufferStatus.style.setProperty("--buffer-progress", `${Math.round(progress * 100)}%`);
    }
  }

  function selectedMovie() {
    const movieId = movieSelect.value;
    return allMovies.find((movie) => movie.id === movieId) || null;
  }

  function updateMediaSession(movie) {
    if (!navigatorRef || !navigatorRef.mediaSession || !mediaMetadataCtor || !movie) {
      return;
    }

    try {
      navigatorRef.mediaSession.metadata = new mediaMetadataCtor({
        title: movie.title || movie.fileName || "Movie Room",
        artist: movie.folder || "Movie Room",
        album: "Movie Downloads",
      });
    } catch {
      return;
    }

    const actions = {
      play: () => {
        if (hasMethod(player, "play")) {
          player.play();
        }
      },
      pause: () => {
        if (hasMethod(player, "pause")) {
          player.pause();
        }
      },
      seekbackward: () => {
        player.currentTime = Math.max((Number(player.currentTime) || 0) - 10, 0);
      },
      seekforward: () => {
        const currentTime = Number(player.currentTime) || 0;
        player.currentTime = Number.isFinite(player.duration)
          ? Math.min(currentTime + 30, Math.max(player.duration - 0.1, 0))
          : currentTime + 30;
      },
    };

    for (const [action, handler] of Object.entries(actions)) {
      try {
        navigatorRef.mediaSession.setActionHandler(action, handler);
      } catch {
        // Some browsers expose Media Session but not every action.
      }
    }
  }

  function updatePlaybackState(state) {
    if (navigatorRef && navigatorRef.mediaSession) {
      navigatorRef.mediaSession.playbackState = state;
    }
  }

  function updateKeepAwakeButton(message = "") {
    if (!keepAwakeButton) {
      return;
    }

    if (!navigatorRef || !navigatorRef.wakeLock || !hasMethod(navigatorRef.wakeLock, "request")) {
      keepAwakeButton.textContent = "Keep Awake Unavailable";
      keepAwakeButton.disabled = true;
      return;
    }

    keepAwakeButton.disabled = false;
    keepAwakeButton.textContent = wakeLock
      ? "Keep Awake On"
      : "Keep Awake";

    if (message) {
      updateStatus(message);
    }
  }

  async function requestWakeLock() {
    if (!navigatorRef || !navigatorRef.wakeLock || !hasMethod(navigatorRef.wakeLock, "request") || wakeLock) {
      updateKeepAwakeButton();
      return false;
    }

    try {
      wakeLock = await navigatorRef.wakeLock.request("screen");
      if (hasMethod(wakeLock, "addEventListener")) {
        wakeLock.addEventListener("release", () => {
          wakeLock = null;
          updateKeepAwakeButton();
        });
      }
      updateKeepAwakeButton("Keep awake is on while this browser stays open.");
      return true;
    } catch {
      updateKeepAwakeButton("Keep awake could not be started. Start playback, then tap Keep Awake again.");
      return false;
    }
  }

  async function releaseWakeLock() {
    const lock = wakeLock;
    wakeLock = null;
    if (hasMethod(lock, "release")) {
      await lock.release().catch(() => {});
    }
    updateKeepAwakeButton();
  }

  function updateCastButton() {
    if (!castButton) {
      return;
    }

    castButton.disabled = !authenticated;
    if (safariAirPlayAvailable || player.webkitShowPlaybackTargetPicker) {
      castButton.textContent = "Safari AirPlay";
      return;
    }

    if (googleCastReady) {
      castButton.textContent = "Choose Google TV";
      return;
    }

    castButton.textContent = browserCastLabel();
  }

  function browserInfo() {
    const userAgent = navigatorRef && navigatorRef.userAgent ? navigatorRef.userAgent : "";
    const vendor = navigatorRef && navigatorRef.vendor ? navigatorRef.vendor : "";
    const isChromium = /Chrome|CriOS|Chromium|Edg|OPR/i.test(userAgent);
    const isSafari = /Safari/i.test(userAgent) && /Apple/i.test(vendor) && !/Chrome|CriOS|Chromium|Edg|OPR/i.test(userAgent);
    const isIOS = /iPad|iPhone|iPod/i.test(userAgent) || (navigatorRef && navigatorRef.platform === "MacIntel" && navigatorRef.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(userAgent);

    return { isAndroid, isChromium, isIOS, isSafari };
  }

  function browserCastLabel() {
    const info = browserInfo();
    if (info.isSafari || info.isIOS) {
      return "Safari AirPlay Help";
    }
    if (info.isChromium || info.isAndroid) {
      return "Google Cast Help";
    }
    return "TV Cast Help";
  }

  function browserCastInstructions() {
    const info = browserInfo();
    if (info.isSafari || info.isIOS) {
      return "iPhone TV playback uses Safari AirPlay: keep the iPhone and Apple TV or AirPlay TV on the same Wi-Fi, start the movie, then tap Safari AirPlay or the AirPlay icon in the video controls. Keep Safari open while the TV plays.";
    }
    if (info.isChromium || info.isAndroid) {
      return "Google Cast uses Wi-Fi: keep this device and the Chromecast, Google TV, or Cast-enabled TV on the same Wi-Fi, start the movie, tap Google Cast, then choose the TV by its Google Home name.";
    }
    return "Start the movie, then use your browser's Cast, AirPlay, or screen-mirroring option. TV discovery happens through the same Wi-Fi network.";
  }

  function castDeviceName(session) {
    const activeSession = session || (googleCastContext && hasMethod(googleCastContext, "getCurrentSession")
      ? googleCastContext.getCurrentSession()
      : null);
    const castDevice = activeSession && hasMethod(activeSession, "getCastDevice")
      ? activeSession.getCastDevice()
      : null;
    const friendlyName = castDevice && castDevice.friendlyName;
    return typeof friendlyName === "string" && friendlyName.trim()
      ? friendlyName.trim()
      : "Google TV";
  }

  function castState() {
    return googleCastContext && hasMethod(googleCastContext, "getCastState")
      ? googleCastContext.getCastState()
      : "";
  }

  async function initializeGoogleCast() {
    const info = browserInfo();
    if (info.isIOS || info.isSafari || !info.isChromium) {
      return false;
    }

    const castAvailable = windowRef ? await windowRef.__movieRoomCastApiReady : false;
    const castFramework = windowRef && windowRef.cast ? windowRef.cast.framework : null;
    const chromeCast = windowRef && windowRef.chrome ? windowRef.chrome.cast : null;
    if (
      !castAvailable
      || !castFramework
      || !castFramework.CastContext
      || !hasMethod(castFramework.CastContext, "getInstance")
      || !chromeCast
      || !chromeCast.media
      || !chromeCast.media.DEFAULT_MEDIA_RECEIVER_APP_ID
    ) {
      updateCastButton();
      updateTvGuide();
      return false;
    }

    googleCastContext = castFramework.CastContext.getInstance();
    googleCastContext.setOptions({
      receiverApplicationId: chromeCast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chromeCast.AutoJoinPolicy ? chromeCast.AutoJoinPolicy.ORIGIN_SCOPED : undefined,
    });
    googleCastReady = true;

    const castStateChanged = castFramework.CastContextEventType
      ? castFramework.CastContextEventType.CAST_STATE_CHANGED
      : null;
    if (castStateChanged) {
      googleCastContext.addEventListener(castStateChanged, () => {
        updateCastButton();
        updateTvGuide();
      });
    }

    const sessionStateChanged = castFramework.CastContextEventType
      ? castFramework.CastContextEventType.SESSION_STATE_CHANGED
      : null;
    if (sessionStateChanged) {
      googleCastContext.addEventListener(sessionStateChanged, () => {
        updateCastButton();
        updateTvGuide();
      });
    }

    updateCastButton();
    updateTvGuide();
    return true;
  }

  async function requestCastPlayback(movieId) {
    const response = await handleApiResponse(
      await fetchImpl("/api/cast/playback", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ movieId }),
      }),
      "Unable to prepare this movie for Google Cast.",
    );
    return response.json();
  }

  async function loadSelectedMovieOnCast(session) {
    const movie = selectedMovie();
    if (!movie) {
      updateStatus("Select a movie before choosing a TV.");
      return false;
    }

    updateStatus(`Preparing ${movie.title || "this movie"} for ${castDeviceName(session)}...`);
    const playback = await requestCastPlayback(movie.id);
    const mediaApi = windowRef && windowRef.chrome && windowRef.chrome.cast ? windowRef.chrome.cast.media : null;
    if (!mediaApi || !mediaApi.MediaInfo || !mediaApi.LoadRequest) {
      throw new Error("Google Cast became unavailable. Reload Chrome and try again.");
    }

    const mediaInfo = new mediaApi.MediaInfo(playback.url, playback.contentType || "video/mp4");
    if (mediaApi.GenericMediaMetadata) {
      const metadata = new mediaApi.GenericMediaMetadata();
      metadata.title = playback.title || movie.title || movie.fileName || "Movie Room";
      metadata.subtitle = movie.folder || "Movie Room";
      mediaInfo.metadata = metadata;
    }

    const request = new mediaApi.LoadRequest(mediaInfo);
    request.autoplay = true;
    request.currentTime = Number.isFinite(player.currentTime)
      ? Math.max(0, player.currentTime)
      : 0;
    await session.loadMedia(request);
    if (hasMethod(player, "pause")) {
      player.pause();
    }
    updateStatus(`Playing on ${castDeviceName(session)}. This device is now the remote.`);
    if (tvGuideStatus) {
      tvGuideStatus.textContent = `${castDeviceName(session)} is connected through Wi-Fi and playing the selected movie.`;
    }
    return true;
  }

  function replaceGuideSteps(steps) {
    if (!tvGuideSteps || !tvGuideSteps.ownerDocument) {
      return;
    }

    tvGuideSteps.replaceChildren();
    for (const step of steps) {
      const item = tvGuideSteps.ownerDocument.createElement("li");
      item.textContent = step;
      tvGuideSteps.append(item);
    }
  }

  function updateTvGuide() {
    const info = browserInfo();
    if (info.isSafari || info.isIOS) {
      if (tvGuideTitle) {
        tvGuideTitle.textContent = "iPhone to TV";
      }
      replaceGuideSteps([
        "Connect the iPhone and Apple TV or AirPlay TV to the same Wi-Fi network.",
        "Open this page in Safari, sign in, and start the movie.",
        "Tap Safari AirPlay above, or tap the AirPlay icon inside the video controls, then choose the TV.",
        "Keep Safari open on the phone while the TV plays.",
      ]);
      if (tvGuideStatus) {
        tvGuideStatus.textContent = player.webkitShowPlaybackTargetPicker || safariAirPlayAvailable
          ? "AirPlay is available from this player. Tap Safari AirPlay after the movie starts."
          : "If the AirPlay icon is missing, use iPhone Control Center Screen Mirroring or confirm the TV supports AirPlay and is on the same Wi-Fi.";
      }
      return;
    }

    if (info.isChromium || info.isAndroid) {
      if (tvGuideTitle) {
        tvGuideTitle.textContent = "Google Cast to TV";
      }
      replaceGuideSteps([
        "Connect the Android phone and Chromecast, Google TV, or Cast-capable TV to the same Wi-Fi network.",
        "Open this page in Chrome, sign in, and start the movie.",
        "Tap Choose Google TV to open Google's Wi-Fi device picker and select the TV by its Google Home name.",
        "Keep Chrome open on the phone while the TV plays.",
      ]);
      if (tvGuideStatus) {
        const session = googleCastContext && hasMethod(googleCastContext, "getCurrentSession")
          ? googleCastContext.getCurrentSession()
          : null;
        if (session) {
          tvGuideStatus.textContent = `${castDeviceName(session)} is connected through Wi-Fi.`;
        } else if (
          googleCastReady
          && windowRef
          && windowRef.cast
          && windowRef.cast.framework
          && windowRef.cast.framework.CastState
          && castState() === windowRef.cast.framework.CastState.NO_DEVICES_AVAILABLE
        ) {
          tvGuideStatus.textContent = "No Google Cast TVs were found. Confirm the TV and this device are on the same Wi-Fi and that the TV appears in Google Home.";
        } else if (googleCastReady) {
          tvGuideStatus.textContent = "Google Cast is ready. Tap Choose Google TV to see the friendly device names saved in Google Home.";
        } else {
          tvGuideStatus.textContent = "Google Cast is loading in Chrome. TV discovery uses Wi-Fi, not Bluetooth pairing.";
        }
      }
      return;
    }

    if (tvGuideTitle) {
      tvGuideTitle.textContent = "Phone to TV";
    }
    if (tvGuideStatus) {
      tvGuideStatus.textContent = browserCastInstructions();
    }
  }

  async function promptRemotePlayback() {
    if (player.webkitShowPlaybackTargetPicker) {
      try {
        player.webkitShowPlaybackTargetPicker();
        updateStatus("Choose your Apple TV or AirPlay TV in the Safari picker. Keep Safari open on the iPhone as the controller.");
        return;
      } catch {
        updateStatus("AirPlay was not started. Open the video controls and use the AirPlay icon if Safari shows it there.");
        return;
      }
    }

    if (googleCastReady && googleCastContext) {
      try {
        let session = hasMethod(googleCastContext, "getCurrentSession")
          ? googleCastContext.getCurrentSession()
          : null;
        if (!session) {
          updateStatus("Opening the Google Cast Wi-Fi device picker...");
          const errorCode = await googleCastContext.requestSession();
          if (errorCode) {
            updateStatus("Google Cast did not connect. Confirm the TV is on the same Wi-Fi and try again.");
            return;
          }
          session = hasMethod(googleCastContext, "getCurrentSession")
            ? googleCastContext.getCurrentSession()
            : null;
        }

        if (!session) {
          updateStatus("No Google Cast TV was selected.");
          return;
        }

        await loadSelectedMovieOnCast(session);
        return;
      } catch {
        updateStatus("Google Cast was canceled or could not connect. Confirm both devices are on the same Wi-Fi.");
        return;
      }
    }

    updateStatus(browserCastInstructions());
  }

  function allowRemotePlayback() {
    player.disableRemotePlayback = false;
    if (hasMethod(player, "removeAttribute")) {
      player.removeAttribute("disableremoteplayback");
      player.removeAttribute("x-webkit-wirelessvideoplaybackdisabled");
    }
    if (hasMethod(player, "setAttribute")) {
      player.setAttribute("x-webkit-airplay", "allow");
      player.setAttribute("webkit-playsinline", "");
    }
    updateCastButton();
    updateTvGuide();
  }

  async function openFullscreenPlayer() {
    if (player.requestFullscreen) {
      await player.requestFullscreen().catch(() => {});
      return;
    }

    if (player.webkitEnterFullscreen) {
      player.webkitEnterFullscreen();
      return;
    }

    updateStatus("Fullscreen is not available in this browser.");
  }

  function updateLoginStatus(message) {
    loginStatus.textContent = message;
  }

  function updatePermissionStatus(message) {
    if (permissionStatus) {
      permissionStatus.textContent = message;
    }
  }

  function markPermissionPanelDone() {
    try {
      if (localStorageRef && hasMethod(localStorageRef, "setItem")) {
        localStorageRef.setItem(permissionStorageKey, "done");
      }
    } catch {
      // Browsers can disable localStorage. The panel can still be dismissed for this page view.
    }

    if (permissionPanel) {
      permissionPanel.hidden = true;
    }
  }

  function showPermissionPanelIfNeeded() {
    if (!permissionPanel) {
      return;
    }

    let alreadyHandled = false;
    try {
      alreadyHandled = Boolean(localStorageRef && hasMethod(localStorageRef, "getItem") && localStorageRef.getItem(permissionStorageKey) === "done");
    } catch {
      alreadyHandled = false;
    }

    permissionPanel.hidden = alreadyHandled;
    if (!alreadyHandled) {
      updatePermissionStatus("Tap allow to let the browser show the permissions it supports.");
    }
  }

  function requestLocationPermission() {
    return new Promise((resolve) => {
      if (!navigatorRef || !navigatorRef.geolocation || !hasMethod(navigatorRef.geolocation, "getCurrentPosition")) {
        resolve("Location is not available in this browser.");
        return;
      }

      navigatorRef.geolocation.getCurrentPosition(
        () => resolve("Location permission allowed."),
        () => resolve("Location permission was not allowed or is unavailable."),
        {
          enableHighAccuracy: false,
          maximumAge: 10 * 60 * 1000,
          timeout: 6000,
        },
      );
    });
  }

  async function requestFirstRunPermissions() {
    if (enablePermissionsButton) {
      enablePermissionsButton.disabled = true;
    }
    updatePermissionStatus("Opening browser permission prompts...");

    const results = [];
    results.push("Cookies are allowed for this site session.");
    results.push(await requestLocationPermission());
    if (navigatorRef && navigatorRef.wakeLock && hasMethod(navigatorRef.wakeLock, "request")) {
      const wakeLockStarted = await requestWakeLock();
      results.push(wakeLockStarted ? "Screen wake permission is ready." : "Screen wake permission was not started yet.");
    } else {
      results.push("Screen wake permission is not available in this browser.");
    }
    results.push("TV discovery uses the Wi-Fi picker shown by Google Cast or Safari AirPlay.");

    updatePermissionStatus(results.join(" "));
    markPermissionPanelDone();
    if (enablePermissionsButton) {
      enablePermissionsButton.disabled = false;
    }
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

  function setAuthenticated(isAuthenticated) {
    authenticated = Boolean(isAuthenticated);
    authPanel.hidden = authenticated;
    libraryPanel.hidden = !authenticated;
    if (searchInput) {
      searchInput.disabled = !authenticated;
    }
    if (reloadButton) {
      reloadButton.disabled = !authenticated;
    }
    if (logoutButton) {
      logoutButton.disabled = !authenticated;
    }
    if (castButton) {
      updateCastButton();
    }
    if (keepAwakeButton) {
      keepAwakeButton.disabled = !authenticated || !navigatorRef || !navigatorRef.wakeLock || !hasMethod(navigatorRef.wakeLock, "request");
    }
    if (fullscreenButton) {
      fullscreenButton.disabled = !authenticated;
    }
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

  function movieSizeLabel(size) {
    const numericSize = Number(size) || 0;
    if (numericSize <= 0) {
      return "still uploading";
    }

    if (numericSize >= 1024 ** 3) {
      return `${(numericSize / (1024 ** 3)).toFixed(2)} GB`;
    }

    if (numericSize >= 1024 ** 2) {
      return `${(numericSize / (1024 ** 2)).toFixed(0)} MB`;
    }

    return `${numericSize} bytes`;
  }

  function normalizeLibraryPayload(payload) {
    if (Array.isArray(payload)) {
      return { movies: payload, folders: [] };
    }

    return {
      movies: payload && Array.isArray(payload.movies) ? payload.movies : [],
      folders: payload && Array.isArray(payload.folders) ? payload.folders : [],
    };
  }

  function buildFoldersFromMovies(movies, folders) {
    const folderMap = new Map();
    for (const folder of folders) {
      if (!folder || !folder.path) {
        continue;
      }
      folderMap.set(folder.path, {
        ...folder,
        name: folder.name || folder.path.split("/").pop(),
      });
    }

    for (const movie of movies) {
      if (!movie.folder) {
        continue;
      }

      const parts = movie.folder.split("/");
      for (let index = 0; index < parts.length; index += 1) {
        const folderPath = parts.slice(0, index + 1).join("/");
        if (!folderMap.has(folderPath)) {
          folderMap.set(folderPath, {
            id: folderPath,
            path: folderPath,
            name: parts[index],
            parent: parts.slice(0, index).join("/"),
            hidden: parts[index].startsWith("."),
          });
        }
      }
    }

    return Array.from(folderMap.values()).map((folder) => {
      const descendantMovies = movies.filter((movie) => (
        movie.folder === folder.path || movie.folder.startsWith(`${folder.path}/`)
      ));
      return {
        ...folder,
        movieCount: Number.isFinite(Number(folder.movieCount)) ? Number(folder.movieCount) : descendantMovies.length,
        playableCount: Number.isFinite(Number(folder.playableCount))
          ? Number(folder.playableCount)
          : descendantMovies.filter((movie) => (Number(movie.size) || 0) > 0).length,
        uploadingCount: Number.isFinite(Number(folder.uploadingCount))
          ? Number(folder.uploadingCount)
          : descendantMovies.filter((movie) => (Number(movie.size) || 0) <= 0).length,
      };
    }).sort((left, right) => left.path.localeCompare(right.path));
  }

  function movieMatchesFilter(movie) {
    const folderMatches = activeFolder === "all"
      || (activeFolder === "" && !movie.folder)
      || movie.folder === activeFolder
      || movie.folder.startsWith(`${activeFolder}/`);
    const searchable = `${movie.title || ""} ${movie.fileName || ""} ${movie.folder || ""}`.toLowerCase();
    return folderMatches && searchable.includes(searchTerm);
  }

  function updateLibrarySummary(movies) {
    if (!librarySummary) {
      return;
    }

    const foundCount = movies.length;
    const playableCount = movies.filter((movie) => (Number(movie.size) || 0) > 0).length;
    const uploadingCount = foundCount - playableCount;
    const waitingCount = Math.max(expectedLibraryCount - foundCount, 0);
    const parts = [
      `${foundCount} of ${expectedLibraryCount} files found`,
      `${playableCount} ready`,
    ];

    if (uploadingCount > 0) {
      parts.push(`${uploadingCount} still uploading`);
    }
    if (waitingCount > 0) {
      parts.push(`${waitingCount} not there yet`);
    }

    librarySummary.textContent = parts.join(" / ");
  }

  function renderFolderShelf() {
    if (!folderShelf || typeof folderShelf.replaceChildren !== "function") {
      return;
    }

    const documentRef = folderShelf.ownerDocument;
    const folders = buildFoldersFromMovies(allMovies, allFolders);
    const buttons = [];

    function createFolderButton(label, folderPath, count, extraText = "") {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "folder-chip";
      if (activeFolder === folderPath) {
        button.classList.add("active");
      }
      button.textContent = extraText ? `${label} ${extraText} ${count}` : `${label} ${count}`;
      button.addEventListener("click", () => {
        activeFolder = folderPath;
        renderLibrary();
      });
      return button;
    }

    buttons.push(createFolderButton("All", "all", allMovies.length));
    buttons.push(createFolderButton("Main Folder", "", allMovies.filter((movie) => !movie.folder).length));

    for (const folder of folders) {
      buttons.push(createFolderButton(
        folder.name,
        folder.path,
        folder.movieCount || 0,
        folder.hidden ? "hidden" : "",
      ));
    }

    folderShelf.replaceChildren(...buttons);
  }

  function renderMovieGrid() {
    if (!movieGrid || typeof movieGrid.replaceChildren !== "function") {
      return;
    }

    const documentRef = movieGrid.ownerDocument;
    const filteredMovies = allMovies.filter(movieMatchesFilter);

    if (!filteredMovies.length) {
      const emptyState = documentRef.createElement("p");
      emptyState.className = "empty-state";
      emptyState.textContent = "No matching files here yet.";
      movieGrid.replaceChildren(emptyState);
      return;
    }

    const cards = filteredMovies.map((movie) => {
      const button = documentRef.createElement("button");
      const ready = (Number(movie.size) || 0) > 0;
      button.type = "button";
      button.className = ready ? "movie-card" : "movie-card unavailable";
      button.disabled = !ready;
      button.dataset.movieId = movie.id;

      const poster = documentRef.createElement("span");
      poster.className = "poster";
      poster.textContent = (movie.extension || movie.fileName || "video").replace(".", "").slice(0, 4).toUpperCase();

      const title = documentRef.createElement("span");
      title.className = "movie-title";
      title.textContent = movie.title || movie.fileName || "Untitled movie";

      const meta = documentRef.createElement("span");
      meta.className = "movie-meta";
      meta.textContent = [movie.folder || "Main Folder", movieSizeLabel(movie.size)].join(" / ");

      const badge = documentRef.createElement("span");
      badge.className = ready ? "ready-badge" : "upload-badge";
      badge.textContent = ready ? "Ready" : "Still uploading";

      button.append(poster, title, meta, badge);
      button.addEventListener("click", () => {
        if (!ready) {
          return;
        }

        movieSelect.value = movie.id;
        playSelectedMovie().catch((error) => {
          updateStatus(error.message);
        });
      });

      return button;
    });

    movieGrid.replaceChildren(...cards);
  }

  function renderLibrary() {
    updateLibrarySummary(allMovies);
    renderFolderShelf();
    renderMovieGrid();
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

      throw new Error((payload && payload.error) || fallbackMessage);
    }

    return response;
  }

  async function loadLibrary(selectedMovieId = movieSelect.value) {
    updateStatus("Loading library…");
    movieSelect.disabled = true;

    const response = await handleApiResponse(
      await fetchImpl("/api/library", { credentials: "same-origin" }),
      "Unable to load movie library.",
    );

    const library = normalizeLibraryPayload(await response.json());
    const movies = library.movies;
    allMovies = movies;
    allFolders = library.folders;
    movieSelect.innerHTML = "";
    renderLibrary();

    if (!movies.length) {
      movieSelect.disabled = true;
      player.removeAttribute("src");
      player.load();
      updateStatus("No movie files found yet. When the files finish showing up in the Downloads folder, they will appear here.");
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
      updateStatus("Movie files are listed, but they are still uploading to OneDrive.");
      return [];
    }

    const playableIds = new Set(playableMovies.map((movie) => movie.id));
    movieSelect.value = selectedMovieId && playableIds.has(selectedMovieId)
      ? selectedMovieId
      : playableMovies[0].id;

    movieSelect.disabled = false;
    updateStatus("Library ready. Loading the selected movie for smooth playback.");
    renderLibrary();
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
      if (superseded && (!error || error.code !== "SESSION_EXPIRED")) {
        return false;
      }
      throw error;
    }

    if (requestVersion !== playbackRequestVersion || movieSelect.value !== movieId) {
      return false;
    }

    if (resumeState && resumeState.movieId === movieId) {
      resumeAfterRefresh = resumeState;
      stableRefreshPosition = resumeState.position;
    }
    player.preload = "auto";
    player.src = /^https?:\/\//i.test(playback.url)
      ? playback.url
      : new URL(playback.url, locationOrigin).toString();
    player.load();
    updateMediaSession(selectedMovie());
    updateBufferStatus();
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
      if (!refreshed && resumeAfterRefresh && resumeAfterRefresh.movieId === movieId) {
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
      const message = (payload && payload.error) || "Unable to verify the current session.";
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
      announceLoginError((payload && payload.error) || "Unable to sign in.");
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
    allMovies = [];
    allFolders = [];
    activeFolder = "all";
    searchTerm = "";
    if (searchInput) {
      searchInput.value = "";
    }
    renderLibrary();
    await releaseWakeLock();
    updatePlaybackState("none");
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

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        searchTerm = searchInput.value.trim().toLowerCase();
        renderMovieGrid();
      });
    }

    if (enablePermissionsButton) {
      enablePermissionsButton.addEventListener("click", () => {
        requestFirstRunPermissions().catch((error) => {
          updatePermissionStatus(error.message);
          enablePermissionsButton.disabled = false;
        });
      });
    }

    if (skipPermissionsButton) {
      skipPermissionsButton.addEventListener("click", () => {
        markPermissionPanelDone();
      });
    }

    if (castButton) {
      castButton.addEventListener("click", () => {
        promptRemotePlayback().catch((error) => {
          updateStatus(error.message);
        });
      });
    }

    if (keepAwakeButton) {
      keepAwakeButton.addEventListener("click", () => {
        keepAwakeWanted = !wakeLock;
        if (wakeLock) {
          releaseWakeLock().catch(() => {});
          updateStatus("Keep awake is off.");
          return;
        }

        requestWakeLock().catch(() => {});
      });
    }

    if (fullscreenButton) {
      fullscreenButton.addEventListener("click", () => {
        openFullscreenPlayer().catch((error) => {
          updateStatus(error.message);
        });
      });
    }

    player.addEventListener("webkitplaybacktargetavailabilitychanged", (event) => {
      safariAirPlayAvailable = event.availability === "available";
      updateCastButton();
      updateTvGuide();
    });

    if (documentRef && hasMethod(documentRef, "addEventListener")) {
      documentRef.addEventListener("visibilitychange", () => {
        if (documentRef.visibilityState === "visible" && keepAwakeWanted && !wakeLock && !player.paused) {
          requestWakeLock().catch(() => {});
        }
      });
    }

    allowRemotePlayback();
    updateKeepAwakeButton();
    updateCastButton();
    updateTvGuide();
    updateBufferStatus();
    showPermissionPanelIfNeeded();
    initializeGoogleCast().catch(() => {
      googleCastReady = false;
      updateCastButton();
      updateTvGuide();
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
      updatePlaybackState("playing");
      if (keepAwakeWanted) {
        requestWakeLock().catch(() => {});
      }
      updateStatus(statusWithBuffer("Streaming now."));
    });

    player.addEventListener("progress", () => {
      const secondsAhead = bufferedSecondsAhead();
      if (secondsAhead >= 2) {
        clearStallRecovery();
        updateStatus(statusWithBuffer(player.paused ? "Ready to play." : "Streaming now."));
      } else {
        updateBufferStatus();
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

      updateBufferStatus();
    });

    player.addEventListener("pause", () => {
      clearStallRecovery();
      updatePlaybackState("paused");
    });
    player.addEventListener("ended", () => {
      clearStallRecovery();
      updatePlaybackState("none");
      releaseWakeLock().catch(() => {});
    });

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
      const mediaErrorCode = player.error ? player.error.code : undefined;
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
    searchInput: document.getElementById("library-search"),
    passwordForm: document.getElementById("password-form"),
    passwordInput: document.getElementById("password"),
    submitButton: document.getElementById("login-submit"),
    player: document.getElementById("player"),
    status: document.getElementById("status"),
    bufferStatus: document.getElementById("buffer-status"),
    loginStatus: document.getElementById("login-status"),
    librarySummary: document.getElementById("library-summary"),
    folderShelf: document.getElementById("folder-shelf"),
    movieGrid: document.getElementById("movie-grid"),
    permissionPanel: document.getElementById("permission-panel"),
    enablePermissionsButton: document.getElementById("enable-permissions"),
    skipPermissionsButton: document.getElementById("skip-permissions"),
    permissionStatus: document.getElementById("permission-status"),
    castButton: document.getElementById("cast-tv"),
    tvGuideTitle: document.getElementById("tv-guide-title"),
    tvGuideSteps: document.getElementById("tv-guide-steps"),
    tvGuideStatus: document.getElementById("tv-guide-status"),
    keepAwakeButton: document.getElementById("keep-awake"),
    fullscreenButton: document.getElementById("fullscreen-player"),
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
