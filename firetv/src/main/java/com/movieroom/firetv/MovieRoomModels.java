package com.movieroom.firetv;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public final class MovieRoomModels {
    private MovieRoomModels() {
    }

    public static final class Pairing {
        public final String pairingId;
        public final String code;
        public final long expiresAt;

        public Pairing(String pairingId, String code, long expiresAt) {
            this.pairingId = pairingId;
            this.code = code;
            this.expiresAt = expiresAt;
        }

        public static Pairing fromJson(String json) throws Exception {
            JSONObject object = new JSONObject(json);
            return new Pairing(object.getString("pairingId"), object.getString("code"), object.getLong("expiresAt"));
        }
    }

    public static final class PairingStatus {
        public final String status;
        public final String deviceId;
        public final String deviceToken;
        public final long expiresAt;

        public PairingStatus(String status, String deviceId, String deviceToken, long expiresAt) {
            this.status = status;
            this.deviceId = deviceId;
            this.deviceToken = deviceToken;
            this.expiresAt = expiresAt;
        }

        public static PairingStatus fromJson(String json) throws Exception {
            JSONObject object = new JSONObject(json);
            return new PairingStatus(
                    object.getString("status"),
                    object.optString("deviceId", ""),
                    object.optString("deviceToken", ""),
                    object.optLong("expiresAt", 0L));
        }
    }

    public static final class Movie {
        public final String id;
        public final String title;
        public final String fileName;
        public final String folder;
        public final String posterUrl;
        public final long size;

        public Movie(String id, String title, String fileName, String folder, String posterUrl, long size) {
            this.id = id;
            this.title = title;
            this.fileName = fileName;
            this.folder = folder;
            this.posterUrl = posterUrl;
            this.size = size;
        }

        public boolean isPlayable() {
            return size > 0L;
        }
    }

    public static final class Library {
        public final List<Movie> movies;
        public final List<String> folders;

        public Library(List<Movie> movies) {
            this(movies, new ArrayList<>());
        }

        public Library(List<Movie> movies, List<String> folders) {
            this.movies = movies;
            this.folders = folders;
        }

        public static Library fromJson(String json) throws Exception {
            JSONObject object = new JSONObject(json);
            JSONArray moviesArray = object.optJSONArray("movies");
            List<Movie> movies = new ArrayList<>();
            if (moviesArray != null) {
                for (int index = 0; index < moviesArray.length(); index++) {
                    JSONObject movie = moviesArray.getJSONObject(index);
                    movies.add(new Movie(
                            movie.getString("id"),
                            movie.optString("title", movie.optString("fileName", "Untitled")),
                            movie.optString("fileName", ""),
                            movie.optString("folder", ""),
                            movie.optString("posterUrl", ""),
                            movie.optLong("size", 0L)));
                }
            }
            List<String> folders = new ArrayList<>();
            JSONArray foldersArray = object.optJSONArray("folders");
            if (foldersArray != null) {
                for (int index = 0; index < foldersArray.length(); index++) {
                    JSONObject folder = foldersArray.optJSONObject(index);
                    if (folder != null) folders.add(folder.optString("path", folder.optString("name", "")));
                }
            }
            return new Library(movies, folders);
        }
    }

    public static final class Playback {
        public final String url;
        public final String title;
        public final String contentType;
        public final long expiresAt;

        public Playback(String url, String title, String contentType, long expiresAt) {
            this.url = url;
            this.title = title;
            this.contentType = contentType;
            this.expiresAt = expiresAt;
        }

        public static Playback fromJson(String json) throws Exception {
            JSONObject object = new JSONObject(json);
            return new Playback(
                    object.getString("url"),
                    object.optString("title", "Movie Room"),
                    object.optString("contentType", "video/mp4"),
                    object.optLong("expiresAt", 0L));
        }
    }
}
