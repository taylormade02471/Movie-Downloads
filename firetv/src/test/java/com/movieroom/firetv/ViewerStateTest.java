package com.movieroom.firetv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ViewerStateTest {
    @Test
    public void clampsProgressAndReadsSettings() throws Exception {
        ViewerState state = ViewerState.fromJson("{\"profileId\":\"family\",\"movies\":{\"m\":{\"positionSeconds\":99,\"durationSeconds\":60,\"completed\":true}},\"settings\":{\"autoplayNext\":true}}");
        assertEquals("family", state.profileId);
        assertEquals(60L, state.movies.get("m").positionSeconds);
        assertTrue(state.movies.get("m").completed);
        assertTrue(state.settings.autoplayNext);
    }
}
