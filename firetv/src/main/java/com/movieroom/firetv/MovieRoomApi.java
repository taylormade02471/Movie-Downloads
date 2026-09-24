package com.movieroom.firetv;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class MovieRoomApi {
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 30_000;

    private final String baseUrl;

    public MovieRoomApi(String baseUrl) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }

    public MovieRoomModels.Pairing createPairing(String deviceLabel, String pollSecret) throws Exception {
        JSONObject body = new JSONObject();
        body.put("deviceLabel", deviceLabel);
        body.put("pollSecret", pollSecret);
        return MovieRoomModels.Pairing.fromJson(request("POST", "/api/tv/pairings", "", body.toString()));
    }

    public MovieRoomModels.PairingStatus pollPairing(String pairingId, String pollSecret) throws Exception {
        return MovieRoomModels.PairingStatus.fromJson(request("GET", "/api/tv/pairings/" + pairingId, pollSecret, ""));
    }

    public MovieRoomModels.Library loadLibrary(String deviceToken) throws Exception {
        return MovieRoomModels.Library.fromJson(request("GET", "/api/tv/library", deviceToken, ""));
    }

    public MovieRoomModels.Playback startPlayback(String deviceToken, String movieId) throws Exception {
        JSONObject body = new JSONObject();
        body.put("movieId", movieId);
        return MovieRoomModels.Playback.fromJson(request("POST", "/api/tv/playback", deviceToken, body.toString()));
    }

    private String request(String method, String path, String bearerToken, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        if (!bearerToken.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + bearerToken);
        }
        if (!body.isEmpty()) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }

        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String payload = readAll(stream);
        if (status < 200 || status >= 300) {
            throw new MovieRoomApiException(status, payload);
        }
        return payload;
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
        }
        return builder.toString();
    }

    public static final class MovieRoomApiException extends Exception {
        public final int statusCode;

        public MovieRoomApiException(int statusCode, String body) {
            super(body.isEmpty() ? "Movie Room request failed with status " + statusCode : body);
            this.statusCode = statusCode;
        }
    }
}
