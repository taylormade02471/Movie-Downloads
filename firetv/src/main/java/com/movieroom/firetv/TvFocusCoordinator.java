package com.movieroom.firetv;

import java.util.List;

public final class TvFocusCoordinator {
    private final List<String> movieIds;
    private int index = 0;

    public TvFocusCoordinator(List<String> movieIds) { this.movieIds = movieIds; }
    public String restore(String movieId) { int found = movieIds.indexOf(movieId); if (found >= 0) index = found; return current(); }
    public String move(int direction) { if (!movieIds.isEmpty()) index = Math.max(0, Math.min(movieIds.size() - 1, index + direction)); return current(); }
    public String current() { return movieIds.isEmpty() ? "" : movieIds.get(index); }
}
