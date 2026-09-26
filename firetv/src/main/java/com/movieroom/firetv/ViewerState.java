package com.movieroom.firetv;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class ViewerState {
    public final String profileId;
    public final long revision;
    public final Map<String, MovieRecord> movies;
    public final List<String> queue;
    public final Settings settings;

    public ViewerState(String profileId, long revision, Map<String, MovieRecord> movies, List<String> queue, Settings settings) {
        this.profileId = profileId == null || profileId.isEmpty() ? "home" : profileId;
        this.revision = Math.max(0L, revision);
        this.movies = movies == null ? new HashMap<>() : movies;
        this.queue = queue == null ? new ArrayList<>() : queue;
        this.settings = settings == null ? new Settings() : settings;
    }

    public static ViewerState fromJson(String json) throws Exception {
        JSONObject object = new JSONObject(json);
        Map<String, MovieRecord> records = new HashMap<>();
        JSONObject movieObject = object.optJSONObject("movies");
        if (movieObject != null) {
            JSONArray names = movieObject.names();
            if (names != null) {
                for (int index = 0; index < names.length() && records.size() < 500; index++) {
                    String movieId = names.getString(index);
                    records.put(movieId, MovieRecord.fromJson(movieObject.optJSONObject(movieId)));
                }
            }
        }
        List<String> queue = new ArrayList<>();
        JSONArray queueArray = object.optJSONArray("queue");
        if (queueArray != null) {
            for (int index = 0; index < queueArray.length() && queue.size() < 100; index++) {
                String movieId = queueArray.optString(index, "");
                if (!movieId.isEmpty() && !queue.contains(movieId)) queue.add(movieId);
            }
        }
        return new ViewerState(object.optString("profileId", "home"), object.optLong("revision", 0L), records, queue, Settings.fromJson(object.optJSONObject("settings")));
    }

    public static final class MovieRecord {
        public final long positionSeconds;
        public final long durationSeconds;
        public final long lastWatchedAt;
        public final boolean completed;
        public final boolean favorite;
        public final boolean watchLater;

        public MovieRecord(long positionSeconds, long durationSeconds, long lastWatchedAt, boolean completed, boolean favorite, boolean watchLater) {
            this.durationSeconds = Math.max(0L, durationSeconds);
            this.positionSeconds = Math.min(Math.max(0L, positionSeconds), this.durationSeconds > 0 ? this.durationSeconds : Math.max(0L, positionSeconds));
            this.lastWatchedAt = Math.max(0L, lastWatchedAt);
            this.completed = completed;
            this.favorite = favorite;
            this.watchLater = watchLater;
        }

        private static MovieRecord fromJson(JSONObject object) {
            if (object == null) return new MovieRecord(0, 0, 0, false, false, false);
            return new MovieRecord(
                    object.optLong("positionSeconds", 0L),
                    object.optLong("durationSeconds", 0L),
                    object.optLong("lastWatchedAt", 0L),
                    object.optLong("completedAt", 0L) > 0L || object.optBoolean("completed", false),
                    object.optBoolean("favorite", false),
                    object.optBoolean("watchLater", false));
        }
    }

    public static final class Settings {
        public final boolean autoplayNext;
        public final boolean resumeEnabled;

        public Settings() { this(false, true); }
        public Settings(boolean autoplayNext, boolean resumeEnabled) { this.autoplayNext = autoplayNext; this.resumeEnabled = resumeEnabled; }
        private static Settings fromJson(JSONObject object) { return object == null ? new Settings() : new Settings(object.optBoolean("autoplayNext", false), object.optBoolean("resumeEnabled", true)); }
    }
}
