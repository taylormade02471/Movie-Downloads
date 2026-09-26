package com.movieroom.firetv;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PlaybackProgressStoreTest {
    @Test
    public void boundsCheckpointsAndDrainsThem() {
        PlaybackProgressStore store = new PlaybackProgressStore();
        store.checkpoint("m", 90_000L, 60_000L);
        assertEquals(60_000L, store.get("m").positionMs);
        assertEquals("m", store.getFocusedMovieId());
        assertEquals(1, store.drain().size());
        assertEquals(0, store.drain().size());
    }
}
