package com.movieroom.firetv;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.widget.Button;
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
    private String pendingPairingId = "";
    private String pendingPollSecret = "";

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
        if (player != null) {
            player.release();
        }
        super.onDestroy();
    }

    private void setScreen() {
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 40, 48, 40);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(0xff0f0f0f);
        setContentView(root);
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
                pendingPollSecret = randomSecret();
                MovieRoomModels.Pairing pairing = api.createPairing("Fire TV", pendingPollSecret);
                pendingPairingId = pairing.pairingId;
                handler.post(() -> status.setText("On your Mac, open Movie Room, choose Pair Fire TV, and enter: " + pairing.code));
                pollPairing(status);
            } catch (Exception error) {
                handler.post(() -> status.setText("Could not create a code. Check Wi-Fi and try New Code."));
            }
        }).start();
    }

    private void pollPairing(TextView status) {
        handler.postDelayed(() -> new Thread(() -> {
            try {
                MovieRoomModels.PairingStatus pairingStatus = api.pollPairing(pendingPairingId, pendingPollSecret);
                if ("approved".equals(pairingStatus.status) && !pairingStatus.deviceToken.isEmpty()) {
                    tokenStore.saveDeviceToken(pairingStatus.deviceToken);
                    handler.post(this::showLibraryScreen);
                    return;
                }
                handler.post(() -> pollPairing(status));
            } catch (MovieRoomApi.MovieRoomApiException error) {
                handler.post(() -> status.setText(error.statusCode == 410
                        ? "Code expired. Choose New Code."
                        : "Waiting for approval. Keep this screen open."));
            } catch (Exception error) {
                handler.post(() -> status.setText("Network problem. Check Wi-Fi and keep this screen open."));
            }
        }).start(), 2500);
    }

    private void showLibraryScreen() {
        setScreen();
        root.addView(text("Movie Room", 34));
        TextView status = text("Loading library...", 22);
        root.addView(status);
        Button unpair = button("Unpair this Fire TV");
        unpair.setOnClickListener(view -> {
            tokenStore.clearDeviceToken();
            showPairingScreen();
        });
        root.addView(unpair);

        ScrollView scrollView = new ScrollView(this);
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        scrollView.addView(list);
        root.addView(scrollView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f));

        new Thread(() -> {
            try {
                MovieRoomModels.Library library = api.loadLibrary(tokenStore.getDeviceToken());
                handler.post(() -> {
                    status.setText(library.movies.size() + " movies found");
                    list.removeAllViews();
                    for (MovieRoomModels.Movie movie : library.movies) {
                        Button row = button(movie.title + (movie.isPlayable() ? "" : " (still uploading)"));
                        row.setEnabled(movie.isPlayable());
                        row.setOnClickListener(view -> startMovie(movie, status));
                        list.addView(row);
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

    private void startMovie(MovieRoomModels.Movie movie, TextView status) {
        status.setText("Starting " + movie.title + "...");
        new Thread(() -> {
            try {
                MovieRoomModels.Playback playback = api.startPlayback(tokenStore.getDeviceToken(), movie.id);
                handler.post(() -> showPlayer(playback));
            } catch (MovieRoomApi.MovieRoomApiException error) {
                handler.post(() -> status.setText(error.statusCode == 409
                        ? "Movie is still uploading."
                        : "This movie could not be played."));
            } catch (Exception error) {
                handler.post(() -> status.setText("Network problem. Try again."));
            }
        }).start();
    }

    private void showPlayer(MovieRoomModels.Playback playback) {
        if (player != null) {
            player.release();
        }
        setScreen();
        root.addView(text(playback.title, 28));
        PlayerView playerView = new PlayerView(this);
        player = new ExoPlayer.Builder(this).build();
        playerView.setPlayer(player);
        root.addView(playerView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f));
        Button back = button("Back to Library");
        back.setOnClickListener(view -> {
            if (player != null) {
                player.release();
                player = null;
            }
            showLibraryScreen();
        });
        root.addView(back);
        player.setMediaItem(MediaItem.fromUri(Uri.parse(playback.url)));
        player.prepare();
        player.play();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && player != null) {
            player.release();
            player = null;
            showLibraryScreen();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
