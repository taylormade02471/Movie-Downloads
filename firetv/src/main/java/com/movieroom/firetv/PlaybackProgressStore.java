package com.movieroom.firetv;

import java.util.HashMap;
import java.util.Map;

public final class PlaybackProgressStore {
    private final Map<String, Checkpoint> checkpoints = new HashMap<>();
    private String focusedMovieId = "";

    public synchronized void checkpoint(String movieId, long positionMs, long durationMs) {
        if (movieId == null || movieId.isEmpty()) return;
        long duration = Math.max(0L, durationMs);
        long position = Math.max(0L, positionMs);
        if (duration > 0L) position = Math.min(position, duration);
        checkpoints.put(movieId, new Checkpoint(position, duration));
        focusedMovieId = movieId;
    }

    public synchronized Checkpoint get(String movieId) { return checkpoints.get(movieId); }
    public synchronized String getFocusedMovieId() { return focusedMovieId; }
    public synchronized Checkpoint remove(String movieId) { return checkpoints.remove(movieId); }
    public synchronized Map<String, Checkpoint> drain() { Map<String, Checkpoint> copy = new HashMap<>(checkpoints); checkpoints.clear(); return copy; }

    public static final class Checkpoint {
        public final long positionMs;
        public final long durationMs;
        public Checkpoint(long positionMs, long durationMs) { this.positionMs = positionMs; this.durationMs = durationMs; }
    }
}
