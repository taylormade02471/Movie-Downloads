package com.movieroom.firetv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MovieRoomModelsTest {
    @Test
    public void parsesPairingStatusApprovedWithDeviceToken() throws Exception {
        MovieRoomModels.PairingStatus status = MovieRoomModels.PairingStatus.fromJson(
                "{\"status\":\"approved\",\"deviceId\":\"device-1\",\"deviceToken\":\"device-1.secret\"}");

        assertEquals("approved", status.status);
        assertEquals("device-1", status.deviceId);
        assertEquals("device-1.secret", status.deviceToken);
    }

    @Test
    public void parsesLibraryAndMarksStillUploadingMovieNotPlayable() throws Exception {
        MovieRoomModels.Library library = MovieRoomModels.Library.fromJson(
                "{\"movies\":[{\"id\":\"movie-1\",\"title\":\"Ready\",\"fileName\":\"Ready.mp4\",\"size\":10}," +
                        "{\"id\":\"movie-2\",\"title\":\"Uploading\",\"fileName\":\"Uploading.mp4\",\"size\":0}],\"folders\":[]}");

        assertEquals(2, library.movies.size());
        assertTrue(library.movies.get(0).isPlayable());
        assertFalse(library.movies.get(1).isPlayable());
    }

    @Test
    public void parsesPlaybackUrlAndTitle() throws Exception {
        MovieRoomModels.Playback playback = MovieRoomModels.Playback.fromJson(
                "{\"url\":\"https://movie.example/stream\",\"title\":\"Family Night\",\"contentType\":\"video/mp4\",\"expiresAt\":1000}");

        assertEquals("https://movie.example/stream", playback.url);
        assertEquals("Family Night", playback.title);
        assertEquals("video/mp4", playback.contentType);
        assertEquals(1000L, playback.expiresAt);
    }
}
