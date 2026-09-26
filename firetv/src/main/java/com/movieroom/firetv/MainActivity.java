package com.movieroom.firetv;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.security.SecureRandom;
import java.util.Locale;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final SecureRandom random = new SecureRandom();
    private DeviceTokenStore tokenStore;
    private MovieRoomApi api;
    private LinearLayout root;
    private ExoPlayer player;
    private View playerOverlay;
    private boolean playerFullscreen = false;
    private int pairingGeneration = 0;
    private final PlaybackProgressStore progressStore = new PlaybackProgressStore();
    private ViewerState viewerState;
    private MovieRoomModels.Movie activeMovie;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        tokenStore = new DeviceTokenStore(this);
        api = new MovieRoomApi(BuildConfig.MOVIE_ROOM_BASE_URL);
        if (tokenStore.getDeviceToken().isEmpty()) {
            showPairingScreen();
        } else {
            showLibraryScreen();
        }
    }

    @Override
    protected void onDestroy() {
        flushProgress(activeMovie, false);
        stopKeepScreenOn();
        if (player != null) {
            player.release();
        }
        super.onDestroy();
    }

    @Override
    protected void onPause() {
        flushProgress(activeMovie, false);
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (player != null) startKeepScreenOn();
    }

    private void setScreen() {
        stopKeepScreenOn();
        leavePlayerFullscreen();
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pagePadding = isTelevision() ? 42 : 18;
        root.setPadding(dp(pagePadding), dp(isTelevision() ? 30 : 18), dp(pagePadding), dp(isTelevision() ? 30 : 18));
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(0xff090a0b);
        setContentView(root);
    }

    private void startKeepScreenOn() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void stopKeepScreenOn() {
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void enterPlayerFullscreen() {
        playerFullscreen = true;
        if (playerOverlay != null) {
            playerOverlay.setVisibility(View.GONE);
        }
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    private void leavePlayerFullscreen() {
        playerFullscreen = false;
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        if (playerOverlay != null) {
            playerOverlay.setVisibility(View.VISIBLE);
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private boolean isTelevision() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_TYPE_MASK)
                == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    private GradientDrawable roundedBackground(int color, int strokeColor, int strokeWidthDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(12));
        drawable.setStroke(dp(strokeWidthDp), strokeColor);
        return drawable;
    }

    private TextView text(String value, int sizeSp) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(0xfff5f5f5);
        view.setTextSize(sizeSp);
        view.setPadding(0, 12, 0, 12);
        return view;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(22);
        button.setAllCaps(false);
        button.setPadding(28, 18, 28, 18);
        return button;
    }

    private String initials(String title) {
        String[] words = title.trim().split("\\s+");
        StringBuilder builder = new StringBuilder();
        for (String word : words) {
            if (!word.isEmpty()) {
                builder.append(word.substring(0, 1).toUpperCase(Locale.US));
            }
            if (builder.length() >= 2) {
                break;
            }
        }
        return builder.length() == 0 ? "M" : builder.toString();
    }

    private String formatSize(long size) {
        if (size >= 1024L * 1024L * 1024L) {
            return String.format(Locale.US, "%.2f GB", size / (1024d * 1024d * 1024d));
        }
        if (size >= 1024L * 1024L) {
            return String.format(Locale.US, "%.0f MB", size / (1024d * 1024d));
        }
        return size > 0L ? String.format(Locale.US, "%.0f KB", size / 1024d) : "Still uploading";
    }

    private String displayFolder(MovieRoomModels.Movie movie) {
        String folder = movie.folder == null ? "" : movie.folder;
        if (folder.isEmpty()) {
            return "Main Folder";
        }
        String[] parts = folder.split("[/\\\\]");
        String cleaned = parts.length == 0 ? folder : parts[parts.length - 1];
        cleaned = cleaned
                .replaceAll("\\[[^\\]]*\\]", " ")
                .replaceAll("\\([^)]*(?:19|20)\\d{2}[^)]*\\)", " ")
                .replaceAll("[._-]+", " ")
                .replaceAll("\\s*[\\[(]?\\b(?:19|20)\\d{2}\\b.*$", " ")
                .replaceAll("\\s+", " ")
                .trim();
        if (cleaned.matches("(?i)^home alone 1,?\\s*2,?\\s*3,?\\s*4,?\\s*5.*")) {
            cleaned = "Home Alone Collection";
        }
        if (cleaned.isEmpty() || cleaned.equalsIgnoreCase(movie.title)) {
            return "Movie Room";
        }
        return cleaned.length() > 36 ? cleaned.substring(0, 33).trim() + "…" : cleaned;
    }

    private String randomSecret() {
        byte[] bytes = new byte[24];
        random.nextBytes(bytes);
        StringBuilder builder = new StringBuilder();
        for (byte value : bytes) {
            builder.append(String.format(Locale.US, "%02x", value));
        }
        return builder.toString();
    }

    private Bitmap createPairingQrBitmap(String pairingUrl, int size) throws WriterException {
        BitMatrix matrix = new QRCodeWriter().encode(pairingUrl, BarcodeFormat.QR_CODE, size, size);
        int[] pixels = new int[size * size];
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                pixels[y * size + x] = matrix.get(x, y) ? Color.BLACK : Color.WHITE;
            }
        }
        return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888);
    }

    private void showPairingScreen() {
        final int generation = ++pairingGeneration;
        setScreen();
        root.addView(text("Movie Room Fire TV", 34));
        TextView status = text("Creating a pairing code...", 24);
        root.addView(status);
        ProgressBar progress = new ProgressBar(this);
        root.addView(progress);
        ImageView qrCode = new ImageView(this);
        qrCode.setBackgroundColor(Color.WHITE);
        qrCode.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams qrParams = new LinearLayout.LayoutParams(dp(300), dp(300));
        qrParams.setMargins(0, dp(16), 0, dp(8));
        root.addView(qrCode, qrParams);
        TextView qrInstructions = text("Scan this code with your phone to sign in and approve this TV.", 18);
        qrInstructions.setGravity(Gravity.CENTER);
        root.addView(qrInstructions);
        Button retry = button("New Code");
        retry.setOnClickListener(view -> showPairingScreen());
        root.addView(retry);

        new Thread(() -> {
            try {
                String pollSecret = randomSecret();
                MovieRoomModels.Pairing pairing = api.createPairing("Fire TV", pollSecret);
                String pairingUrl = PairingQrUrl.build(BuildConfig.MOVIE_ROOM_BASE_URL, pairing.code);
                Bitmap pairingQr = createPairingQrBitmap(pairingUrl, 600);
                if (generation != pairingGeneration) {
                    return;
                }
                handler.post(() -> {
                    if (generation == pairingGeneration) {
                        progress.setVisibility(View.GONE);
                        qrCode.setImageBitmap(pairingQr);
                        status.setText("Scan the QR code with your phone, or enter code: " + pairing.code);
                    }
                });
                pollPairing(pairing.pairingId, pollSecret, status, generation);
            } catch (Exception error) {
                handler.post(() -> {
                    if (generation == pairingGeneration) {
                        status.setText("Could not create a code. Check Wi-Fi and try New Code.");
                    }
                });
            }
        }).start();
    }

    private void pollPairing(String pairingId, String pollSecret, TextView status, int generation) {
        if (generation != pairingGeneration) {
            return;
        }
        handler.postDelayed(() -> new Thread(() -> {
            if (generation != pairingGeneration) {
                return;
            }
            try {
                MovieRoomModels.PairingStatus pairingStatus = api.pollPairing(pairingId, pollSecret);
                if (generation != pairingGeneration) {
                    return;
                }
                if ("approved".equals(pairingStatus.status) && !pairingStatus.deviceToken.isEmpty()) {
                    tokenStore.saveDeviceToken(pairingStatus.deviceToken);
                    handler.post(() -> {
                        if (generation == pairingGeneration) {
                            showLibraryScreen();
                        }
                    });
                    return;
                }
                handler.post(() -> pollPairing(pairingId, pollSecret, status, generation));
            } catch (MovieRoomApi.MovieRoomApiException error) {
                handler.post(() -> {
                    if (generation != pairingGeneration) {
                        return;
                    }
                    if (error.statusCode == 410 || error.statusCode == 401) {
                        status.setText("Code expired. Choose New Code.");
                        return;
                    }
                    status.setText("Waiting for approval. Keep this screen open.");
                    pollPairing(pairingId, pollSecret, status, generation);
                });
            } catch (Exception error) {
                handler.post(() -> {
                    if (generation == pairingGeneration) {
                        status.setText("Network problem. Check Wi-Fi and keep this screen open.");
                        pollPairing(pairingId, pollSecret, status, generation);
                    }
                });
            }
        }).start(), 2500);
    }

    private void showLibraryScreen() {
        pairingGeneration += 1;
        setScreen();
        TextView brand = text("TAYLOR-MADE MOVIES", 32);
        brand.setTextColor(0xffffd166);
        brand.setTypeface(null, android.graphics.Typeface.BOLD);
        root.addView(brand);
        TextView subtitle = text("MOVIE ROOM  •  YOUR PRIVATE CINEMA", 16);
        subtitle.setTextColor(0xffbdb5a2);
        root.addView(subtitle);
        TextView hero = text("Recently downloaded\nContinue watching from where you left off.", 24);
        hero.setTextColor(0xfff5f5f5);
        hero.setPadding(0, dp(16), 0, dp(14));
        root.addView(hero);
        TextView status = text("Loading library...", 22);
        root.addView(status);
        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        Button refresh = button("Refresh Library");
        refresh.setTextColor(0xff17120a);
        refresh.setBackground(roundedBackground(0xffffd166, 0xffffd166, 1));
        refresh.setOnClickListener(view -> showLibraryScreen());
        Button unpair = button("Unpair");
        unpair.setOnClickListener(view -> {
            tokenStore.clearDeviceToken();
            showPairingScreen();
        });
        actions.addView(refresh);
        actions.addView(unpair);
        root.addView(actions);

        ScrollView scrollView = new ScrollView(this);
        GridLayout grid = new GridLayout(this);
        grid.setColumnCount(isTelevision() ? 3 : 2);
        grid.setPadding(0, dp(12), 0, dp(24));
        scrollView.addView(grid);
        root.addView(scrollView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f));

        new Thread(() -> {
            try {
                MovieRoomModels.Library library = api.loadLibrary(tokenStore.getDeviceToken());
                ViewerState state = null;
                try {
                    state = api.getViewerState(tokenStore.getDeviceToken());
                    viewerState = state;
                } catch (Exception ignored) {
                    // A viewer-state outage should not hide the movie library.
                }
                final ViewerState loadedState = state;
                handler.post(() -> {
                    int inProgress = 0;
                    if (loadedState != null) {
                        for (ViewerState.MovieRecord record : loadedState.movies.values()) {
                            if (record.positionSeconds > 0 && !record.completed) inProgress++;
                        }
                    }
                    status.setText(library.movies.size() + " movies found" + (inProgress > 0 ? "  •  " + inProgress + " continue watching" : ""));
                    grid.removeAllViews();
                    for (MovieRoomModels.Movie movie : library.movies) {
                        grid.addView(movieCard(movie, status));
                    }
                });
            } catch (MovieRoomApi.MovieRoomApiException error) {
                handler.post(() -> {
                    if (error.statusCode == 401) {
                        tokenStore.clearDeviceToken();
                        showPairingScreen();
                    } else {
                        status.setText("Could not load library. Try again.");
                    }
                });
            } catch (Exception error) {
                handler.post(() -> status.setText("Network problem. Check Wi-Fi and try again."));
            }
        }).start();
    }

    private View movieCard(MovieRoomModels.Movie movie, TextView status) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setFocusable(true);
        card.setClickable(movie.isPlayable());
        card.setEnabled(movie.isPlayable());
        card.setPadding(dp(10), dp(10), dp(10), dp(10));
        card.setBackground(roundedBackground(0xff141414, 0xff3b3424, 1));

        GridLayout.LayoutParams params = new GridLayout.LayoutParams();
        params.width = dp(isTelevision() ? 270 : 160);
        params.height = GridLayout.LayoutParams.WRAP_CONTENT;
        params.setMargins(dp(8), dp(8), dp(8), dp(12));
        card.setLayoutParams(params);

        TextView fallback = text(initials(movie.title), 42);
        fallback.setGravity(Gravity.CENTER);
        fallback.setBackground(roundedBackground(0xff352b16, 0xffffd166, 1));
        fallback.setTextColor(0xffffd166);
        card.addView(fallback, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(isTelevision() ? 152 : 112)));

        TextView title = text(movie.title, 18);
        title.setGravity(Gravity.LEFT);
        title.setMaxLines(2);
        title.setEllipsize(TextUtils.TruncateAt.END);
        card.addView(title);

        TextView meta = text(displayFolder(movie) + "  •  " + formatSize(movie.size), 14);
        meta.setMaxLines(2);
        meta.setEllipsize(TextUtils.TruncateAt.END);
        meta.setTextColor(movie.isPlayable() ? 0xffa7f3c6 : 0xffffd88a);
        card.addView(meta);

        card.setOnFocusChangeListener((view, hasFocus) -> {
            view.setScaleX(hasFocus ? 1.04f : 1.0f);
            view.setScaleY(hasFocus ? 1.04f : 1.0f);
            view.setBackground(roundedBackground(hasFocus ? 0xff282218 : 0xff141414, hasFocus ? 0xffffd166 : 0xff3b3424, 2));
        });
        card.setOnClickListener(view -> {
            if (movie.isPlayable()) {
                startMovie(movie, status);
            }
        });

        loadPosterIntoCard(movie, card, fallback);
        return card;
    }

    private void loadPosterIntoCard(MovieRoomModels.Movie movie, LinearLayout card, TextView fallback) {
        if (movie.posterUrl == null || movie.posterUrl.isEmpty()) {
            return;
        }

        new Thread(() -> {
            try {
                byte[] bytes = api.downloadPoster(movie.posterUrl);
                if (bytes.length == 0) {
                    return;
                }
                Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bitmap == null) {
                    return;
                }
                handler.post(() -> {
                    int index = card.indexOfChild(fallback);
                    if (index < 0) {
                        return;
                    }
                    ImageView poster = new ImageView(this);
                    poster.setImageBitmap(bitmap);
                    poster.setBackgroundColor(0xff050505);
                    poster.setScaleType(ImageView.ScaleType.CENTER_CROP);
                    card.removeView(fallback);
                    card.addView(poster, index, new LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.MATCH_PARENT,
                            dp(isTelevision() ? 152 : 112)));
                });
            } catch (Exception ignored) {
                // Keep the clean initials fallback when no poster is available yet.
            }
        }).start();
    }

    private void startMovie(MovieRoomModels.Movie movie, TextView status) {
        status.setText("Starting " + movie.title + "...");
        new Thread(() -> {
            try {
                MovieRoomModels.Playback playback = api.startPlayback(tokenStore.getDeviceToken(), movie.id);
                try {
                    ViewerState state = api.getViewerState(tokenStore.getDeviceToken());
                    handler.post(() -> showPlayer(playback, movie, state));
                } catch (Exception ignored) {
                    handler.post(() -> showPlayer(playback, movie, null));
                }
            } catch (MovieRoomApi.MovieRoomApiException error) {
                handler.post(() -> status.setText(error.statusCode == 409
                        ? "Movie is still uploading."
                        : "This movie could not be played."));
            } catch (Exception error) {
                handler.post(() -> status.setText("Network problem. Try again."));
            }
        }).start();
    }

    private void showPlayer(MovieRoomModels.Playback playback, MovieRoomModels.Movie movie, ViewerState state) {
        if (player != null) {
            player.release();
        }

        playerFullscreen = false;
        activeMovie = movie;
        viewerState = state;
        FrameLayout playerScreen = new FrameLayout(this);
        playerScreen.setBackgroundColor(0xff000000);
        PlayerView playerView = new PlayerView(this);
        playerView.setKeepScreenOn(true);
        startKeepScreenOn();
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(60_000, 300_000, 5_000, 10_000)
                .setPrioritizeTimeOverSizeThresholds(true)
                .build();
        player = new ExoPlayer.Builder(this)
                .setLoadControl(loadControl)
                .build();
        playerView.setShowRewindButton(true);
        playerView.setShowFastForwardButton(true);
        playerView.setPlayer(player);
        playerScreen.addView(playerView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        LinearLayout overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.HORIZONTAL);
        overlay.setGravity(Gravity.CENTER_VERTICAL);
        overlay.setPadding(dp(18), dp(10), dp(18), dp(10));
        overlay.setBackgroundColor(0xcc111111);

        LinearLayout details = new LinearLayout(this);
        details.setOrientation(LinearLayout.VERTICAL);
        TextView title = text(playback.title, 24);
        title.setMaxLines(1);
        title.setEllipsize(TextUtils.TruncateAt.END);
        details.addView(title);
        TextView meta = text(displayFolder(movie) + "  •  " + formatSize(movie.size) + "  •  " + playback.contentType, 15);
        meta.setTextColor(0xffc8c8c8);
        details.addView(meta);
        overlay.addView(details, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        Button fullScreen = button("Full Screen");
        fullScreen.setTextSize(18);
        fullScreen.setOnClickListener(view -> enterPlayerFullscreen());
        overlay.addView(fullScreen);

        Button back = button("Library");
        back.setTextSize(18);
        back.setOnClickListener(view -> {
            if (player != null) {
                player.release();
                player = null;
            }
            playerOverlay = null;
            showLibraryScreen();
        });
        overlay.addView(back);

        FrameLayout.LayoutParams overlayParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP);
        playerScreen.addView(overlay, overlayParams);
        playerOverlay = overlay;
        setContentView(playerScreen);

        player.setMediaItem(MediaItem.fromUri(Uri.parse(playback.url)));
        player.prepare();
        if (state != null && state.movies.containsKey(movie.id) && state.settings.resumeEnabled) {
            ViewerState.MovieRecord record = state.movies.get(movie.id);
            player.addListener(new Player.Listener() {
                private boolean restored;
                @Override public void onPlaybackStateChanged(int playbackState) {
                    if (!restored && playbackState == Player.STATE_READY && record.positionSeconds > 0) {
                        player.seekTo(record.positionSeconds * 1000L);
                        restored = true;
                    }
                    if (playbackState == Player.STATE_ENDED) flushProgress(movie, true);
                }
            });
        }
        player.addListener(new Player.Listener() {
            @Override public void onIsPlayingChanged(boolean isPlaying) {
                if (!isPlaying) flushProgress(movie, false);
            }

            @Override public void onPlayerError(androidx.media3.common.PlaybackException error) {
                Toast.makeText(MainActivity.this, "This movie could not play. Try again or choose an MP4 copy.", Toast.LENGTH_LONG).show();
            }
        });
        player.play();
    }

    private void flushProgress(MovieRoomModels.Movie movie, boolean completed) {
        if (player == null || movie == null) return;
        long position = Math.max(0L, player.getCurrentPosition());
        long duration = Math.max(0L, player.getDuration());
        if (duration <= 0L) return;
        progressStore.checkpoint(movie.id, position, duration);
        new Thread(() -> {
            try {
                JSONObject progress = new JSONObject();
                progress.put("type", "progress");
                progress.put("movieId", movie.id);
                progress.put("positionSeconds", position / 1000d);
                progress.put("durationSeconds", duration / 1000d);
                List<JSONObject> operations = new ArrayList<>();
                operations.add(progress);
                if (completed || position >= duration * 0.9d) {
                    JSONObject done = new JSONObject();
                    done.put("type", "setCompleted");
                    done.put("movieId", movie.id);
                    done.put("value", true);
                    operations.add(done);
                }
                viewerState = api.applyViewerOperations(tokenStore.getDeviceToken(), operations);
            } catch (Exception ignored) {
                // Keep the local checkpoint for the next lifecycle flush.
            }
        }).start();
    }

    private boolean seekBy(long offsetMs) {
        if (player == null || !player.isCurrentMediaItemSeekable()) {
            return false;
        }
        long duration = player.getDuration();
        long target = Math.max(0L, player.getCurrentPosition() + offsetMs);
        if (duration != androidx.media3.common.C.TIME_UNSET) {
            target = Math.min(target, duration);
        }
        player.seekTo(target);
        return true;
    }

    @Override
        public boolean onKeyDown(int keyCode, KeyEvent event) {
            if (keyCode == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD && seekBy(30_000L)) {
                return true;
            }
            if (keyCode == KeyEvent.KEYCODE_MEDIA_REWIND && seekBy(-10_000L)) {
                return true;
            }
            if (keyCode == KeyEvent.KEYCODE_BACK && player != null) {
            if (playerFullscreen) {
                leavePlayerFullscreen();
                return true;
            }
            player.release();
            flushProgress(activeMovie, false);
            player = null;
            playerOverlay = null;
            showLibraryScreen();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
