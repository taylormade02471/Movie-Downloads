package com.movieroom.firetv;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
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

import androidx.media3.common.MediaItem;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;

import java.security.SecureRandom;
import java.util.Locale;

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
        stopKeepScreenOn();
        if (player != null) {
            player.release();
        }
        super.onDestroy();
    }

    private void setScreen() {
        stopKeepScreenOn();
        leavePlayerFullscreen();
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 40, 48, 40);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(0xff0f0f0f);
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

    private void showPairingScreen() {
        final int generation = ++pairingGeneration;
        setScreen();
        root.addView(text("Movie Room Fire TV", 34));
        TextView status = text("Creating a pairing code...", 24);
        root.addView(status);
        ProgressBar progress = new ProgressBar(this);
        root.addView(progress);
        Button retry = button("New Code");
        retry.setOnClickListener(view -> showPairingScreen());
        root.addView(retry);

        new Thread(() -> {
            try {
                String pollSecret = randomSecret();
                MovieRoomModels.Pairing pairing = api.createPairing("Fire TV", pollSecret);
                if (generation != pairingGeneration) {
                    return;
                }
                handler.post(() -> {
                    if (generation == pairingGeneration) {
                        status.setText("On your Mac, open Movie Room, choose Pair Fire TV, and enter: " + pairing.code);
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
        root.addView(text("Movie Room", 34));
        TextView status = text("Loading library...", 22);
        root.addView(status);
        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        Button refresh = button("Refresh Library");
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
        grid.setColumnCount(3);
        grid.setPadding(0, dp(12), 0, dp(24));
        scrollView.addView(grid);
        root.addView(scrollView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f));

        new Thread(() -> {
            try {
                MovieRoomModels.Library library = api.loadLibrary(tokenStore.getDeviceToken());
                handler.post(() -> {
                    status.setText(library.movies.size() + " movies found");
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
        card.setBackground(roundedBackground(0xff181818, 0xff333333, 1));

        GridLayout.LayoutParams params = new GridLayout.LayoutParams();
        params.width = dp(270);
        params.height = GridLayout.LayoutParams.WRAP_CONTENT;
        params.setMargins(dp(8), dp(8), dp(8), dp(12));
        card.setLayoutParams(params);

        TextView fallback = text(initials(movie.title), 42);
        fallback.setGravity(Gravity.CENTER);
        fallback.setBackground(roundedBackground(0xff9d1731, 0xffff335c, 1));
        card.addView(fallback, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(152)));

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
            view.setBackground(roundedBackground(hasFocus ? 0xff252525 : 0xff181818, hasFocus ? 0xffff335c : 0xff333333, 2));
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
                    poster.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
                    card.removeView(fallback);
                    card.addView(poster, index, new LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.MATCH_PARENT,
                            dp(152)));
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
                handler.post(() -> showPlayer(playback, movie));
            } catch (MovieRoomApi.MovieRoomApiException error) {
                handler.post(() -> status.setText(error.statusCode == 409
                        ? "Movie is still uploading."
                        : "This movie could not be played."));
            } catch (Exception error) {
                handler.post(() -> status.setText("Network problem. Try again."));
            }
        }).start();
    }

    private void showPlayer(MovieRoomModels.Playback playback, MovieRoomModels.Movie movie) {
        if (player != null) {
            player.release();
        }

        playerFullscreen = false;
        FrameLayout playerScreen = new FrameLayout(this);
        playerScreen.setBackgroundColor(0xff000000);
        PlayerView playerView = new PlayerView(this);
        playerView.setKeepScreenOn(true);
        startKeepScreenOn();
        player = new ExoPlayer.Builder(this).build();
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
        player.play();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && player != null) {
            if (playerFullscreen) {
                leavePlayerFullscreen();
                return true;
            }
            player.release();
            player = null;
            playerOverlay = null;
            showLibraryScreen();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
