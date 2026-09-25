const KIDS_MOVIE_PATTERN = /\b(?:home\s+alone|toy\s+story|paw\s+patrol|spider\s*man|superman|jurassic\s+world|magic\s+faraway\s+tree)\b/i;
const TECHNICAL_FOLDER_PATTERN = /^(?:subs?|images?|drawable(?:[-_ ]?nodpi)?|res|src|main|java|providers?|firetv|api|cast|playback|stream|tv|pairings?|docs?|test|gradle|node_modules?|skills?|agents?|patterns?|search|commands|migrations|performance|advanced features)$/i;
const VIEWER_STATE_API = typeof require === "function"
  ? require("./viewer-state")
  : (typeof window !== "undefined" ? window.MovieRoomViewerState : null);

function classifyMovie(movie) {
  const source = movie || {};
  const searchable = `${source.title || ""} ${source.fileName || ""} ${source.folder || ""}`;
  return KIDS_MOVIE_PATTERN.test(searchable) ? "kids" : "adults";
}

function filterMovieFolders(folders) {
  const candidates = (Array.isArray(folders) ? folders : [])
    .filter((folder) => folder && folder.path && !folder.hidden && Number(folder.movieCount) > 0)
    .filter((folder) => {
      const parts = String(folder.path).split(/[\\/]/).filter(Boolean);
      return !parts.some((part) => TECHNICAL_FOLDER_PATTERN.test(part.trim()));
    });

  return candidates
    .filter((folder) => !candidates.some((other) => (
      other.path !== folder.path && other.path.startsWith(`${folder.path}/`)
    )))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function createApp({
  movieSelect,
  reloadButton,
  logoutButton,
  searchInput,
  passwordForm,
  passwordInput,
  submitButton,
  player,
  playerFrame,
  status,
  bufferStatus,
  nowPlayingTitle,
  nowPlayingDetail,
  loginStatus,
  librarySummary,
  folderShelf,
  categoryShelf,
  movieGrid,
  watchPlaceholder,
  watchStage,
  permissionPanel,
  enablePermissionsButton,
  skipPermissionsButton,
  permissionStatus,
  seekBackwardButton,
  seekForwardButton,
  castButton,
  tvGuideTitle,
  tvGuideSteps,
  tvGuideStatus,
  keepAwakeButton,
  fullscreenButton,
  authPanel,
  libraryPanel,
  pairFireTvButton,
  fireTvPairingForm,
  fireTvCodeInput,
  fireTvPairingStatus,
  profileToggle,
  profileMenu,
  profileLabel,
  profileAvatar,
  profileButtons = [],
  heroMovie,
  heroBackdrop,
  heroTitle,
  heroMeta,
  heroDescription,
  heroPlay,
  heroDetails,
  continueWatchingShelf,
  continueSummary,
  recentlyAddedShelf,
  picksShelf,
  movieDetailsDialog,
  detailsClose,
  detailsPoster,
  detailsTitle,
  detailsMeta,
  detailsDescription,
  detailsPlay,
  detailsWatchLater,
  detailsQueue,
  detailsStatus,
  theaterModeButton,
  miniplayerModeButton,
  upNextPanel,
  upNextTitle,
  upNextPlay,
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
  let isSeeking = false;
  let allMovies = [];
  let allFolders = [];
  let viewerState = { movies: {}, queue: [], settings: {} };
  let detailsMovie = null;
  let playerMode = "normal";
  let progressTimer = null;
  let restoredMovieId = "";
  let progressWriteInFlight = null;
  let activeFolder = "all";
  let activeCategory = "recent";
  let searchTerm = "";
  let playerVisible = false;
  let wakeLock = null;
  let keepAwakeWanted = true;
  let safariAirPlayAvailable = false;
  let googleCastContext = null;
  let googleCastReady = false;
  let authenticated = false;
  let activeProfile = "home";
  let pendingFireTvCode = "";
  const expectedLibraryCount = 16;
  const permissionStorageKey = "movie_room_permissions_v1";
  const profileStorageKey = "movie_room_viewer_profile_v1";
  const profileLastMoviePrefix = "movie_room_last_movie_v1_";
  const viewerProfiles = {
    home: { label: "Home", initial: "H" },
    family: { label: "Family", initial: "F" },
    guest: { label: "Guest", initial: "G" },
  };
  const viewerStateClient = VIEWER_STATE_API && typeof VIEWER_STATE_API.createViewerStateClient === "function"
    ? VIEWER_STATE_API.createViewerStateClient({
      fetchImpl,
      onUnauthorized: () => setAuthenticated(false),
    })
    : null;

  function hasMethod(value, methodName) {
    return Boolean(value && typeof value[methodName] === "function");
  }

  function readLocalValue(key) {
    try {
      return localStorageRef && hasMethod(localStorageRef, "getItem")
        ? localStorageRef.getItem(key)
        : null;
    } catch {
      return null;
    }
  }

  function writeLocalValue(key, value) {
    try {
      if (localStorageRef && hasMethod(localStorageRef, "setItem")) {
        localStorageRef.setItem(key, value);
      }
    } catch {
      // Private browsing can disable local storage. Profiles still work for this page view.
    }
  }

  function updateProfileUi() {
    const profile = viewerProfiles[activeProfile] || viewerProfiles.home;
    if (profileLabel) {
      profileLabel.textContent = profile.label;
    }
    if (profileAvatar) {
      profileAvatar.textContent = profile.initial;
    }
    for (const button of profileButtons) {
      const selected = button.dataset && button.dataset.viewerProfile === activeProfile;
      if (button.classList && typeof button.classList.toggle === "function") {
        button.classList.toggle("active", selected);
      }
      if (typeof button.setAttribute === "function") {
        button.setAttribute("aria-checked", selected ? "true" : "false");
      }
    }
  }

  function storedMovieForProfile() {
    return readLocalValue(`${profileLastMoviePrefix}${activeProfile}`) || "";
  }

  function rememberMovieForProfile(movieId) {
    if (movieId) {
      writeLocalValue(`${profileLastMoviePrefix}${activeProfile}`, movieId);
    }
  }

  function setViewerProfile(profileId) {
    activeProfile = Object.prototype.hasOwnProperty.call(viewerProfiles, profileId)
      ? profileId
      : "home";
    writeLocalValue(profileStorageKey, activeProfile);
    if (profileMenu) {
      profileMenu.hidden = true;
    }
    if (profileToggle && typeof profileToggle.setAttribute === "function") {
      profileToggle.setAttribute("aria-expanded", "false");
    }
    updateProfileUi();
  }

  function initializeViewerProfile() {
    setViewerProfile(readLocalValue(profileStorageKey) || "home");
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

  function seekPlayerBy(offsetSeconds) {
    if (!player || !Number.isFinite(player.duration)) {
      updateStatus("Fast forward is available when the movie finishes loading.");
      return;
    }

    const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
    const targetTime = Math.max(
      0,
      Math.min(currentTime + offsetSeconds, Math.max(player.duration - 0.1, 0)),
    );

    try {
      clearStallRecovery();
      isSeeking = true;
      player.currentTime = targetTime;
      updateStatus(offsetSeconds < 0 ? "Rewinding 10 seconds..." : "Fast forwarding 30 seconds...");
      updateBufferStatus();
    } catch {
      isSeeking = false;
      updateStatus("This browser could not seek in the current video.");
    }
  }

  function selectedMovie() {
    const movieId = movieSelect.value;
    return allMovies.find((movie) => movie.id === movieId) || null;
  }

  function setPlayerVisibility(visible, { scroll = false } = {}) {
    playerVisible = Boolean(visible);
    if (watchPlaceholder) {
      watchPlaceholder.hidden = playerVisible;
    }
    if (playerFrame) {
      playerFrame.hidden = !playerVisible;
    }
    const watchMeta = playerFrame && playerFrame.parentNode && typeof playerFrame.parentNode.querySelector === "function"
      ? playerFrame.parentNode.querySelector(".watch-meta")
      : null;
    if (watchMeta) {
      watchMeta.hidden = !playerVisible;
    }
    if (scroll && playerVisible && watchStage && typeof watchStage.scrollIntoView === "function") {
      watchStage.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function updateMediaSession(movie) {
    if (!navigatorRef || !navigatorRef.mediaSession || !mediaMetadataCtor || !movie) {
      return;
    }

    try {
      navigatorRef.mediaSession.metadata = new mediaMetadataCtor({
        title: movie.title || movie.fileName || "Movie Room",
        artist: movieFolderLabel(movie),
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
      metadata.subtitle = movieFolderLabel(movie);
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
    const fullscreenTarget = playerFrame || player;
    if (fullscreenTarget && fullscreenTarget.requestFullscreen) {
      await fullscreenTarget.requestFullscreen().catch(() => {});
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

    if (theaterModeButton) theaterModeButton.addEventListener("click", () => setPlayerMode(playerMode === "theater" ? "normal" : "theater"));
    if (miniplayerModeButton) miniplayerModeButton.addEventListener("click", () => setPlayerMode(playerMode === "miniplayer" ? "normal" : "miniplayer"));
    if (upNextPlay) upNextPlay.addEventListener("click", () => playNextFromQueue());

    if (documentRef && typeof documentRef.addEventListener === "function") {
      documentRef.addEventListener("keydown", (event) => {
        const target = event.target;
        const tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
        if (tag === "input" || tag === "textarea" || (target && target.isContentEditable)) return;
        const key = String(event.key || "").toLowerCase();
        if (key === " " || key === "k") { event.preventDefault(); if (player.paused) player.play(); else player.pause(); }
        else if (key === "j") seekPlayerBy(-10);
        else if (key === "l") seekPlayerBy(30);
        else if (key === "f") openFullscreenPlayer();
        else if (key === "t") setPlayerMode(playerMode === "theater" ? "normal" : "theater");
        else if (key === "i") setPlayerMode(playerMode === "miniplayer" ? "normal" : "miniplayer");
        else if (key === "m") player.muted = !player.muted;
        else if (key === "escape" && playerMode !== "normal") setPlayerMode("normal");
        else if (key === "/" && searchInput) { event.preventDefault(); searchInput.focus(); }
      });
      documentRef.addEventListener("pagehide", () => { savePlaybackProgress("pagehide").catch(() => {}); });
    }
    if (pairFireTvButton) {
      pairFireTvButton.disabled = !authenticated;
    }
    if (profileToggle) {
      profileToggle.disabled = !authenticated;
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
    if (size <= 0) {
      return `${movie.title} (still uploading)`;
    }

    const sizeInGb = (size / (1024 ** 3)).toFixed(2);
    return `${movie.title} (${sizeInGb} GB)`;
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

  function movieInitials(movie) {
    const title = movie.title || movie.fileName || "Movie";
    const words = title.split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "M";
  }

  function posterAltText(movie) {
    return `${movie.title || movie.fileName || "Movie"} cover`;
  }

  function displayFolderLabel(folder) {
    const parts = String(folder || "").split(/[\\/]/).filter(Boolean);
    const leaf = parts.length ? parts[parts.length - 1] : "";
    if (!leaf) {
      return "Main Folder";
    }

    let cleaned = leaf
      .replace(/\[[^\]]*]/g, " ")
      .replace(/\([^)]*(?:19|20)\d{2}[^)]*\)/gi, " ")
      .replace(/[._-]+/g, " ")
      .replace(/\s*[[(]?\b(?:19|20)\d{2}\b.*$/i, " ")
      .replace(/\s+\b(?:480p|576p|720p|1080p|2160p|4k|web\s*dl|webrip|bluray|x264|x265|h264|h265|hevc|aac)\b.*$/i, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (/^home alone 1,?\s*2,?\s*3,?\s*4,?\s*5/i.test(cleaned)) {
      cleaned = "Home Alone Collection";
    }
    if (!cleaned) {
      return "Movie library";
    }
    return cleaned.length > 36 ? `${cleaned.slice(0, 33).trim()}…` : cleaned;
  }

  function movieFolderLabel(movie) {
    const folderLabel = displayFolderLabel(movie && movie.folder);
    const title = String((movie && (movie.title || movie.fileName)) || "").toLowerCase();
    return folderLabel.toLowerCase() === title ? "Movie Room" : folderLabel;
  }

  function updateNowPlaying(movie, playback = null) {
    if (!movie) {
      if (nowPlayingTitle) {
        nowPlayingTitle.textContent = "Choose a movie";
      }
      if (nowPlayingDetail) {
        nowPlayingDetail.textContent = "Select a thumbnail below to start streaming.";
      }
      return;
    }

    if (nowPlayingTitle) {
      nowPlayingTitle.textContent = movie.title || movie.fileName || "Untitled movie";
    }
    if (nowPlayingDetail) {
      const details = [movieFolderLabel(movie), movieSizeLabel(movie.size)];
      if (playback && playback.contentType) {
        details.push(playback.contentType.replace(/^video\//, "").toUpperCase());
      }
      nowPlayingDetail.textContent = details.join(" • ");
    }
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

    if (detailsClose && movieDetailsDialog) {
      detailsClose.addEventListener("click", () => {
        if (typeof movieDetailsDialog.close === "function") movieDetailsDialog.close();
        else movieDetailsDialog.removeAttribute("open");
      });
    }
    if (detailsPlay) {
      detailsPlay.addEventListener("click", () => {
        if (!detailsMovie) return;
        if (movieDetailsDialog && typeof movieDetailsDialog.close === "function") movieDetailsDialog.close();
        movieSelect.value = detailsMovie.id;
        playSelectedMovie({ scrollToPlayer: true }).catch((error) => updateStatus(error.message));
      });
    }
    if (detailsWatchLater) {
      detailsWatchLater.addEventListener("click", async () => {
        if (!detailsMovie || !viewerStateClient) return;
        try {
          viewerState = await viewerStateClient.apply(activeProfile, [{ type: "setFlag", movieId: detailsMovie.id, flag: "watchLater", value: true }]);
          detailsStatus.textContent = "Added to Watch Later.";
          renderDiscovery();
        } catch (error) { detailsStatus.textContent = error.message; }
      });
    }
    if (detailsQueue) {
      detailsQueue.addEventListener("click", async () => {
        if (!detailsMovie || !viewerStateClient) return;
        try {
          viewerState = await viewerStateClient.apply(activeProfile, [{ type: "queueAdd", movieId: detailsMovie.id }]);
          detailsStatus.textContent = "Added to your queue.";
        } catch (error) { detailsStatus.textContent = error.message; }
      });
    }
    if (movieDetailsDialog) {
      movieDetailsDialog.addEventListener("click", (event) => {
        if (event.target === movieDetailsDialog) {
          if (typeof movieDetailsDialog.close === "function") movieDetailsDialog.close();
          else movieDetailsDialog.removeAttribute("open");
        }
      });
    }
    if (documentRef && typeof documentRef.querySelectorAll === "function") {
      for (const button of documentRef.querySelectorAll("[data-mobile-action]")) {
        button.addEventListener("click", () => {
          const action = button.dataset.mobileAction;
          if (action === "search" && searchInput) searchInput.focus();
          if (action === "home" && heroMovie) heroMovie.scrollIntoView({ behavior: "smooth", block: "start" });
          if (action === "library" && movieGrid) movieGrid.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
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
    const categoryMatches = activeCategory === "recent" || classifyMovie(movie) === activeCategory;
    const searchable = `${movie.title || ""} ${movie.fileName || ""} ${movie.folder || ""}`.toLowerCase();
    return folderMatches && categoryMatches && searchable.includes(searchTerm);
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
      foundCount >= expectedLibraryCount
        ? `${foundCount} files found`
        : `${foundCount} of ${expectedLibraryCount} files found`,
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
    const folders = filterMovieFolders(buildFoldersFromMovies(allMovies, allFolders));
    const buttons = [];

    function createFolderButton(label, folderPath, count, extraText = "") {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "folder-chip";
      if (activeFolder === folderPath) {
        button.classList.add("active");
      }
      const icon = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.classList.add("folder-icon");
      icon.setAttribute("viewBox", "0 0 24 20");
      icon.setAttribute("aria-hidden", "true");
      const iconPath = documentRef.createElementNS("http://www.w3.org/2000/svg", "path");
      iconPath.setAttribute("d", "M2 3.5A2.5 2.5 0 0 1 4.5 1h5.2l2 2H19.5A2.5 2.5 0 0 1 22 5.5v10A2.5 2.5 0 0 1 19.5 18h-15A2.5 2.5 0 0 1 2 15.5v-12ZM4 6h16v-.5a.5.5 0 0 0-.5-.5h-8.6l-2-2H4.5a.5.5 0 0 0-.5.5V6Z");
      icon.append(iconPath);
      const text = documentRef.createElement("span");
      text.className = "folder-label";
      text.textContent = extraText ? `${label} ${extraText}` : label;
      const countLabel = documentRef.createElement("span");
      countLabel.className = "folder-count";
      countLabel.textContent = String(count);
      button.append(icon, text, countLabel);
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
        displayFolderLabel(folder.name),
        folder.path,
        folder.movieCount || 0,
      ));
    }

    folderShelf.replaceChildren(...buttons);
  }

  function renderCategoryShelf() {
    if (!categoryShelf || typeof categoryShelf.replaceChildren !== "function") {
      return;
    }

    const documentRef = categoryShelf.ownerDocument;
    const categories = [
      ["recent", "All"],
      ["adults", "Adults"],
      ["kids", "Kids"],
    ];
    const buttons = categories.map(([category, label]) => {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "category-chip";
      button.textContent = label;
      button.setAttribute("aria-pressed", activeCategory === category ? "true" : "false");
      if (activeCategory === category) {
        button.classList.add("active");
      }
      button.addEventListener("click", () => {
        activeCategory = category;
        renderLibrary();
      });
      return button;
    });
    categoryShelf.replaceChildren(...buttons);
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
      const fallback = documentRef.createElement("span");
      fallback.className = "poster-fallback";
      const initials = documentRef.createElement("strong");
      initials.textContent = movieInitials(movie);
      const fallbackTitle = documentRef.createElement("span");
      fallbackTitle.textContent = movie.title || movie.fileName || "Movie";
      fallback.append(initials, fallbackTitle);
      poster.append(fallback);
      if (movie.posterUrl) {
        const image = documentRef.createElement("img");
        image.alt = posterAltText(movie);
        image.loading = "lazy";
        image.decoding = "async";
        image.src = movie.posterUrl;
        image.addEventListener("error", () => {
          image.remove();
        }, { once: true });
        poster.prepend(image);
      }

      const title = documentRef.createElement("span");
      title.className = "movie-title";
      title.textContent = movie.title || movie.fileName || "Untitled movie";

      const meta = documentRef.createElement("span");
      meta.className = "movie-meta";
      meta.textContent = [movieFolderLabel(movie), movieSizeLabel(movie.size)].join(" • ");

      const badge = documentRef.createElement("span");
      badge.className = ready ? "ready-badge" : "upload-badge";
      badge.textContent = ready ? "Ready" : "Still uploading";

      const info = documentRef.createElement("span");
      info.className = "movie-info";
      info.append(title, meta, badge);

      button.append(poster, info);
      button.addEventListener("click", () => {
        if (!ready) {
          return;
        }

        movieSelect.value = movie.id;
        rememberMovieForProfile(movie.id);
        updateNowPlaying(movie);
        playSelectedMovie({ scrollToPlayer: true }).catch((error) => {
          updateStatus(error.message);
        });
      });

      return button;
    });

    movieGrid.replaceChildren(...cards);
  }

  function viewerRecord(movieId) {
    return viewerState && viewerState.movies && viewerState.movies[movieId]
      ? viewerState.movies[movieId]
      : null;
  }

  function progressPercent(record) {
    if (!record || !Number.isFinite(record.durationSeconds) || record.durationSeconds <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, (Number(record.positionSeconds) || 0) / record.durationSeconds * 100));
  }

  function remainingLabel(record) {
    if (!record || !Number.isFinite(record.durationSeconds) || record.durationSeconds <= 0) {
      return "Resume movie";
    }
    const remaining = Math.max(0, Math.round(record.durationSeconds - (Number(record.positionSeconds) || 0)));
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    return hours ? `${hours}h ${minutes}m remaining` : `${minutes} min remaining`;
  }

  function openMovieDetails(movie) {
    if (!movie) {
      return;
    }
    detailsMovie = movie;
    if (detailsPoster) {
      detailsPoster.src = movie.posterUrl || "/movie-room-hero.png";
      detailsPoster.alt = posterAltText(movie);
    }
    if (detailsTitle) {
      detailsTitle.textContent = movie.title || movie.fileName || "Movie details";
    }
    if (detailsMeta) {
      detailsMeta.textContent = [movie.year, movie.rating, movie.runtime].filter(Boolean).join(" • ") || movieFolderLabel(movie);
    }
    if (detailsDescription) {
      detailsDescription.textContent = movie.description || `Watch ${movie.title || movie.fileName || "this movie"} in your private Movie Room.`;
    }
    if (detailsStatus) {
      detailsStatus.textContent = "";
    }
    if (movieDetailsDialog && typeof movieDetailsDialog.showModal === "function") {
      movieDetailsDialog.showModal();
    } else if (movieDetailsDialog) {
      movieDetailsDialog.setAttribute("open", "");
    }
  }

  function createShelfCard(movie, shelf) {
    const documentRef = shelf.ownerDocument;
    const card = documentRef.createElement("button");
    const ready = (Number(movie.size) || 0) > 0;
    card.type = "button";
    card.className = ready ? "movie-card" : "movie-card unavailable";
    card.disabled = !ready;
    card.dataset.movieId = movie.id;
    const poster = documentRef.createElement("span");
    poster.className = "poster";
    const fallback = documentRef.createElement("span");
    fallback.className = "poster-fallback";
    const initials = documentRef.createElement("strong");
    initials.textContent = movieInitials(movie);
    const fallbackTitle = documentRef.createElement("span");
    fallbackTitle.textContent = movie.title || movie.fileName || "Movie";
    fallback.append(initials, fallbackTitle);
    poster.append(fallback);
    if (movie.posterUrl) {
      const image = documentRef.createElement("img");
      image.alt = posterAltText(movie);
      image.loading = "lazy";
      image.src = movie.posterUrl;
      image.addEventListener("error", () => image.remove(), { once: true });
      poster.prepend(image);
    }
    const info = documentRef.createElement("span");
    info.className = "movie-info";
    const title = documentRef.createElement("span");
    title.className = "movie-title";
    title.textContent = movie.title || movie.fileName || "Untitled movie";
    const meta = documentRef.createElement("span");
    meta.className = "movie-meta";
    meta.textContent = shelf === "continue" ? remainingLabel(viewerRecord(movie.id)) : movieFolderLabel(movie);
    info.append(title, meta);
    const record = viewerRecord(movie.id);
    if (shelf === "continue" && record) {
      const track = documentRef.createElement("span");
      track.className = "progress-track";
      const fill = documentRef.createElement("span");
      fill.style.width = `${progressPercent(record)}%`;
      track.append(fill);
      info.append(track);
    }
    card.append(poster, info);
    card.addEventListener("click", () => {
      movieSelect.value = movie.id;
      rememberMovieForProfile(movie.id);
      updateNowPlaying(movie);
      playSelectedMovie({ scrollToPlayer: true }).catch((error) => updateStatus(error.message));
    });
    return card;
  }

  function renderShelf(shelf, movies, emptyText) {
    if (!shelf || typeof shelf.replaceChildren !== "function") {
      return;
    }
    if (!movies.length) {
      const empty = shelf.ownerDocument.createElement("p");
      empty.className = "empty-state";
      empty.textContent = emptyText;
      shelf.replaceChildren(empty);
      return;
    }
    shelf.replaceChildren(...movies.map((movie) => createShelfCard(movie, shelf === continueWatchingShelf ? "continue" : "recent")));
  }

  function renderDiscovery() {
    const playable = allMovies.filter((movie) => (Number(movie.size) || 0) > 0);
    const continueMovies = playable
      .filter((movie) => {
        const record = viewerRecord(movie.id);
        return record && record.positionSeconds > 0 && !record.completedAt;
      })
      .sort((left, right) => (viewerRecord(right.id).lastWatchedAt || 0) - (viewerRecord(left.id).lastWatchedAt || 0));
    const recentMovies = [...playable].slice().reverse();
    const picks = playable.filter((movie) => classifyMovie(movie) === "kids").concat(playable.filter((movie) => classifyMovie(movie) !== "kids")).slice(0, 12);
    renderShelf(continueWatchingShelf, continueMovies, "Start a movie and your progress will appear here.");
    renderShelf(recentlyAddedShelf, recentMovies, "Newly uploaded movies will appear here.");
    renderShelf(picksShelf, picks, "Your library is ready for its first pick.");
    if (continueSummary) {
      continueSummary.textContent = continueMovies.length ? `${continueMovies.length} in progress` : "Nothing started yet";
    }
    const featured = picks[0] || playable[0];
    if (featured) {
      if (heroMovie) heroMovie.hidden = false;
      if (heroBackdrop) { heroBackdrop.src = featured.backdropUrl || featured.posterUrl || "/movie-room-hero.png"; heroBackdrop.alt = `${featured.title || "Featured movie"} backdrop`; }
      if (heroTitle) heroTitle.textContent = featured.title || featured.fileName || "Featured movie";
      if (heroMeta) heroMeta.textContent = [featured.year, featured.rating, featured.runtime, movieFolderLabel(featured)].filter(Boolean).join(" • ");
      if (heroDescription) heroDescription.textContent = featured.description || "A Taylor-Made pick from your private movie collection.";
      if (heroPlay) heroPlay.onclick = () => { movieSelect.value = featured.id; playSelectedMovie({ scrollToPlayer: true }).catch((error) => updateStatus(error.message)); };
      if (heroDetails) heroDetails.onclick = () => openMovieDetails(featured);
    }
    if (upNextPanel) {
      const next = (viewerState.queue || []).map((id) => playable.find((movie) => movie.id === id)).find(Boolean);
      upNextPanel.hidden = !next;
      if (next && upNextTitle) upNextTitle.textContent = next.title || next.fileName || "Next movie";
      if (next && upNextPlay) upNextPlay.onclick = () => { movieSelect.value = next.id; playSelectedMovie({ scrollToPlayer: true }).catch((error) => updateStatus(error.message)); };
    }
  }

  function renderLibrary() {
    updateLibrarySummary(allMovies);
    renderCategoryShelf();
    renderFolderShelf();
    renderMovieGrid();
    renderDiscovery();
  }

  function setPlayerMode(mode) {
    const allowed = new Set(["normal", "theater", "miniplayer"]);
    playerMode = allowed.has(mode) ? mode : "normal";
    if (libraryPanel && libraryPanel.classList) {
      libraryPanel.classList.toggle("theater-mode", playerMode === "theater");
      libraryPanel.classList.toggle("miniplayer-mode", playerMode === "miniplayer");
    }
    if (theaterModeButton) theaterModeButton.textContent = playerMode === "theater" ? "Exit theater" : "Theater";
    if (miniplayerModeButton) miniplayerModeButton.textContent = playerMode === "miniplayer" ? "Return to player" : "Miniplayer";
    return playerMode;
  }

  function scheduleProgressSave() {
    if (progressTimer !== null) return;
    progressTimer = setTimeoutImpl(() => {
      progressTimer = null;
      savePlaybackProgress("interval").catch(() => {});
    }, 15000);
  }

  async function savePlaybackProgress(reason = "checkpoint") {
    if (!viewerStateClient || !authenticated || !movieSelect.value || !Number.isFinite(player.currentTime)) return null;
    const movieId = movieSelect.value;
    const durationSeconds = Number.isFinite(player.duration) ? Math.max(0, player.duration) : 0;
    if (durationSeconds <= 0) return null;
    const completed = reason === "ended" || player.ended || player.currentTime >= durationSeconds * 0.9;
    const operations = [{ type: "progress", movieId, positionSeconds: player.currentTime, durationSeconds, playbackStatus: completed ? "completed" : player.paused ? "paused" : "playing" }];
    if (completed) operations.push({ type: "setCompleted", movieId, value: true });
    if (progressWriteInFlight) await progressWriteInFlight;
    progressWriteInFlight = viewerStateClient.apply(activeProfile, operations)
      .then((state) => { viewerState = state; renderDiscovery(); return state; })
      .finally(() => { progressWriteInFlight = null; });
    return progressWriteInFlight;
  }

  function restorePlaybackProgress(movieId) {
    if (restoredMovieId === movieId) return;
    const record = viewerRecord(movieId);
    if (!record || !Number.isFinite(record.positionSeconds) || record.positionSeconds <= 0 || !Number.isFinite(player.duration)) return;
    restoredMovieId = movieId;
    try { player.currentTime = Math.min(record.positionSeconds, Math.max(player.duration - 0.1, 0)); } catch { /* browser may reject a seek before metadata */ }
  }

  function playNextFromQueue() {
    const currentId = movieSelect.value;
    const queue = Array.isArray(viewerState.queue) ? viewerState.queue : [];
    const nextId = queue.find((movieId) => movieId !== currentId && allMovies.some((movie) => movie.id === movieId && (Number(movie.size) || 0) > 0));
    const next = allMovies.find((movie) => movie.id === nextId) || allMovies.find((movie) => movie.id !== currentId && (Number(movie.size) || 0) > 0);
    if (!next) return false;
    movieSelect.value = next.id;
    playSelectedMovie({ scrollToPlayer: true }).catch((error) => updateStatus(error.message));
    return true;
  }

  async function handleApiResponse(response, fallbackMessage) {
    if (response.status === 401) {
      clearStallRecovery();
      playbackRequestVersion += 1;
      resumeAfterRefresh = null;
      movieSelect.value = "";
      setAuthenticated(false);
      setPlayerVisibility(false);
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

    if (viewerStateClient && continueWatchingShelf) {
      try {
        viewerState = await viewerStateClient.load(activeProfile);
      } catch {
        viewerState = { movies: {}, queue: [], settings: {} };
      }
    }

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
      setPlayerVisibility(false);
      player.removeAttribute("src");
      player.load();
      updateNowPlaying(null);
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
      setPlayerVisibility(false);
      player.removeAttribute("src");
      player.load();
      updateNowPlaying(null);
      updateStatus("Movie files are listed, but they are still uploading to OneDrive.");
      return [];
    }

    const playableIds = new Set(playableMovies.map((movie) => movie.id));
    const preferredMovieId = selectedMovieId || storedMovieForProfile();
    movieSelect.value = preferredMovieId && playableIds.has(preferredMovieId)
      ? preferredMovieId
      : playableMovies[0].id;

    movieSelect.disabled = false;
    if (!playerVisible) {
      updateNowPlaying(null);
      updateStatus("Library ready. Choose a movie to start streaming.");
    } else {
      updateNowPlaying(selectedMovie());
      updateStatus("Library ready.");
    }
    renderLibrary();
    return playableMovies;
  }

  async function playSelectedMovie({ isRefresh = false, expectedMovieId = null, resumeState = null, scrollToPlayer = false } = {}) {
    const movieId = expectedMovieId || movieSelect.value;
    if (!isRefresh) {
      if (movieSelect.value && movieSelect.value !== movieId) {
        await savePlaybackProgress("movie-switch").catch(() => {});
      }
      clearStallRecovery();
      playbackRefreshAttempts = 0;
      resumeAfterRefresh = null;
      stableRefreshPosition = null;
      restoredMovieId = "";
    }

    if (!movieId || (expectedMovieId && movieSelect.value !== expectedMovieId)) {
      updateStatus("Select a movie to start streaming.");
      return false;
    }

    setPlayerVisibility(true, { scroll: scrollToPlayer });

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
    rememberMovieForProfile(movieId);
    updateNowPlaying(selectedMovie(), playback);
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
      isSeeking
      || stallRecoveryTimer !== null
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
    await approvePendingFireTvPairing().catch((error) => updateFireTvPairingStatus(error.message));
    if (!movies.length) {
      return;
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

    clearStallRecovery();
    playbackRequestVersion += 1;
    resumeAfterRefresh = null;
    setAuthenticated(false);
    setPlayerVisibility(false);
    movieSelect.innerHTML = "";
    movieSelect.value = "";
    movieSelect.disabled = true;
    allMovies = [];
    allFolders = [];
    activeFolder = "all";
    activeCategory = "recent";
    searchTerm = "";
    if (searchInput) {
      searchInput.value = "";
    }
    renderLibrary();
    await releaseWakeLock();
    updatePlaybackState("none");
    player.removeAttribute("src");
    player.load();
    updateNowPlaying(null);
    updateStatus("Signed out.");
  }

  function updateFireTvPairingStatus(message) {
    if (fireTvPairingStatus) {
      fireTvPairingStatus.textContent = message;
    }
  }

  function normalizeFireTvCode(value) {
    return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  }

  function readFireTvCodeFromUrl() {
    if (!windowRef || !windowRef.location || !windowRef.location.href) {
      return "";
    }
    try {
      return normalizeFireTvCode(new URL(windowRef.location.href).searchParams.get("firetv_code"));
    } catch {
      return "";
    }
  }

  function clearFireTvCodeFromUrl() {
    if (!windowRef || !windowRef.location || !windowRef.history || !hasMethod(windowRef.history, "replaceState")) {
      return;
    }
    try {
      const cleanUrl = new URL(windowRef.location.href);
      cleanUrl.searchParams.delete("firetv_code");
      windowRef.history.replaceState({}, "", cleanUrl.toString());
    } catch {
      return;
    }
  }

  async function approveFireTvPairing(event) {
    event.preventDefault();
    const code = normalizeFireTvCode(fireTvCodeInput ? fireTvCodeInput.value : "");
    if (!code) {
      updateFireTvPairingStatus("Enter the code shown on your Fire TV.");
      return false;
    }

    updateFireTvPairingStatus("Approving Fire TV...");
    const response = await handleApiResponse(
      await fetchImpl("/api/tv/pairings/approve", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      }),
      "Unable to approve this Fire TV.",
    );
    const approved = await response.json();
    const label = approved.deviceLabel || "Fire TV";
    updateFireTvPairingStatus(`${label} is approved. Open the Fire TV app to continue.`);
    if (fireTvCodeInput) {
      fireTvCodeInput.value = "";
    }
    return true;
  }

  async function approvePendingFireTvPairing() {
    if (!pendingFireTvCode || !fireTvCodeInput || !fireTvPairingForm) {
      return false;
    }

    fireTvPairingForm.hidden = false;
    fireTvCodeInput.value = pendingFireTvCode;
    const approved = await approveFireTvPairing({ preventDefault() {} });
    if (approved) {
      pendingFireTvCode = "";
      clearFireTvCodeFromUrl();
    }
    return approved;
  }

  function initialize() {
    initializeViewerProfile();
    pendingFireTvCode = readFireTvCodeFromUrl();

    movieSelect.addEventListener("change", () => {
      rememberMovieForProfile(movieSelect.value);
      updateNowPlaying(selectedMovie());
      playSelectedMovie({ scrollToPlayer: true }).catch((error) => {
        updateStatus(error.message);
      });
    });

    reloadButton.addEventListener("click", async () => {
      try {
        const previousSelection = movieSelect.value;
        const movies = await loadLibrary(previousSelection);

        if (movies.length && !playerVisible) {
          updateStatus("Library ready. Choose a movie to start streaming.");
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

    if (profileToggle && profileMenu) {
      profileToggle.addEventListener("click", () => {
        profileMenu.hidden = !profileMenu.hidden;
        if (typeof profileToggle.setAttribute === "function") {
          profileToggle.setAttribute("aria-expanded", profileMenu.hidden ? "false" : "true");
        }
      });
    }

    for (const button of profileButtons) {
      button.addEventListener("click", () => {
        const profileId = button.dataset ? button.dataset.viewerProfile : "home";
        setViewerProfile(profileId);
        if (!allMovies.length) {
          return;
        }
        const rememberedMovieId = storedMovieForProfile();
        const rememberedMovie = allMovies.find((movie) => movie.id === rememberedMovieId && (Number(movie.size) || 0) > 0);
        const fallbackMovie = allMovies.find((movie) => (Number(movie.size) || 0) > 0);
        const nextMovie = rememberedMovie || fallbackMovie;
        if (nextMovie) {
          movieSelect.value = nextMovie.id;
          updateNowPlaying(null);
          updateStatus("Choose a movie to start streaming.");
        }
        loadLibrary(movieSelect.value).catch(() => {});
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

    if (pairFireTvButton && fireTvPairingForm) {
      pairFireTvButton.addEventListener("click", () => {
        fireTvPairingForm.hidden = !fireTvPairingForm.hidden;
        if (!fireTvPairingForm.hidden) {
          updateFireTvPairingStatus("Enter the code shown on your Fire TV.");
        }
      });
    }

    if (pendingFireTvCode && fireTvPairingForm) {
      fireTvPairingForm.hidden = false;
      updateFireTvPairingStatus("QR pairing loaded. Sign in to approve this Fire TV automatically.");
    }

    if (fireTvPairingForm) {
      fireTvPairingForm.addEventListener("submit", (event) => {
        return approveFireTvPairing(event).catch((error) => {
          updateFireTvPairingStatus(error.message);
          return false;
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

    if (seekBackwardButton) {
      seekBackwardButton.addEventListener("click", () => seekPlayerBy(-10));
    }

    if (seekForwardButton) {
      seekForwardButton.addEventListener("click", () => seekPlayerBy(30));
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

    player.addEventListener("seeking", () => {
      isSeeking = true;
      clearStallRecovery();
      updateBufferStatus();
    });

    player.addEventListener("seeked", () => {
      isSeeking = false;
      updateStatus(statusWithBuffer("Seek complete."));
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
      scheduleProgressSave();
    });

    player.addEventListener("pause", () => {
      clearStallRecovery();
      updatePlaybackState("paused");
      savePlaybackProgress("pause").catch(() => {});
    });
    player.addEventListener("ended", () => {
      isSeeking = false;
      clearStallRecovery();
      updatePlaybackState("none");
      releaseWakeLock().catch(() => {});
      savePlaybackProgress("ended").catch(() => {});
      if (viewerState.settings && viewerState.settings.autoplayNext) playNextFromQueue();
    });

    player.addEventListener("loadedmetadata", () => {
      restorePlaybackProgress(movieSelect.value);
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
      isSeeking = false;
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

        await loadLibrary();
        await approvePendingFireTvPairing();
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
    playNextFromQueue,
    restorePlaybackProgress,
    savePlaybackProgress,
    setPlayerMode,
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
    playerFrame: document.querySelector(".player-frame"),
    status: document.getElementById("status"),
    bufferStatus: document.getElementById("buffer-status"),
    nowPlayingTitle: document.getElementById("now-playing-title"),
    nowPlayingDetail: document.getElementById("now-playing-detail"),
    loginStatus: document.getElementById("login-status"),
    librarySummary: document.getElementById("library-summary"),
    folderShelf: document.getElementById("folder-shelf"),
    categoryShelf: document.getElementById("category-shelf"),
    movieGrid: document.getElementById("movie-grid"),
    watchPlaceholder: document.getElementById("watch-placeholder"),
    watchStage: document.querySelector(".watch-stage"),
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
    seekBackwardButton: document.getElementById("seek-backward"),
    seekForwardButton: document.getElementById("seek-forward"),
    authPanel: document.getElementById("auth-panel"),
    libraryPanel: document.getElementById("library-panel"),
    pairFireTvButton: document.getElementById("pair-fire-tv"),
    fireTvPairingForm: document.getElementById("fire-tv-pairing-form"),
    fireTvCodeInput: document.getElementById("fire-tv-code"),
    fireTvPairingStatus: document.getElementById("fire-tv-pairing-status"),
    profileToggle: document.getElementById("profile-toggle"),
    profileMenu: document.getElementById("profile-menu"),
    profileLabel: document.getElementById("profile-label"),
    profileAvatar: document.getElementById("profile-avatar"),
    profileButtons: Array.from(document.querySelectorAll("[data-viewer-profile]")),
    heroMovie: document.getElementById("hero-movie"),
    heroBackdrop: document.getElementById("hero-backdrop"),
    heroTitle: document.getElementById("hero-title"),
    heroMeta: document.getElementById("hero-meta"),
    heroDescription: document.getElementById("hero-description"),
    heroPlay: document.getElementById("hero-play"),
    heroDetails: document.getElementById("hero-details"),
    continueWatchingShelf: document.getElementById("continue-watching-shelf"),
    continueSummary: document.getElementById("continue-summary"),
    recentlyAddedShelf: document.getElementById("recently-added-shelf"),
    picksShelf: document.getElementById("picks-shelf"),
    movieDetailsDialog: document.getElementById("movie-details-dialog"),
    detailsClose: document.getElementById("details-close"),
    detailsPoster: document.getElementById("details-poster"),
    detailsTitle: document.getElementById("details-title"),
    detailsMeta: document.getElementById("details-meta"),
    detailsDescription: document.getElementById("details-description"),
    detailsPlay: document.getElementById("details-play"),
    detailsWatchLater: document.getElementById("details-watch-later"),
    detailsQueue: document.getElementById("details-queue"),
    detailsStatus: document.getElementById("details-status"),
    theaterModeButton: document.getElementById("theater-mode"),
    miniplayerModeButton: document.getElementById("miniplayer-mode"),
    upNextPanel: document.getElementById("up-next-panel"),
    upNextTitle: document.getElementById("up-next-title"),
    upNextPlay: document.getElementById("up-next-play"),
    fetchImpl: fetch,
    locationOrigin: window.location.origin,
    createOption: () => document.createElement("option"),
  }).initialize();
}

if (typeof module !== "undefined") {
  module.exports = { classifyMovie, createApp, filterMovieFolders };
}
