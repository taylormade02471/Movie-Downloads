package com.movieroom.firetv;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;

import org.junit.Test;

public class TvFocusCoordinatorTest {
    @Test
    public void restoresAndMovesWithinShelfBounds() {
        TvFocusCoordinator coordinator = new TvFocusCoordinator(Arrays.asList("a", "b", "c"));
        assertEquals("b", coordinator.restore("b"));
        assertEquals("c", coordinator.move(1));
        assertEquals("c", coordinator.move(1));
        assertEquals("b", coordinator.move(-1));
    }
}
