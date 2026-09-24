package com.movieroom.firetv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class DeviceTokenStoreTest {
    @Test
    public void storesReloadsAndClearsDeviceToken() {
        Context context = ApplicationProvider.getApplicationContext();
        DeviceTokenStore store = new DeviceTokenStore(
                context.getSharedPreferences("movie_room_fire_tv_test", Context.MODE_PRIVATE),
                new ReversingTokenCipher());

        store.clearDeviceToken();
        assertEquals("", store.getDeviceToken());

        store.saveDeviceToken("device-1.secret");
        assertFalse(context
                .getSharedPreferences("movie_room_fire_tv_test", Context.MODE_PRIVATE)
                .getAll()
                .containsValue("device-1.secret"));

        DeviceTokenStore reloaded = new DeviceTokenStore(
                context.getSharedPreferences("movie_room_fire_tv_test", Context.MODE_PRIVATE),
                new ReversingTokenCipher());
        assertEquals("device-1.secret", reloaded.getDeviceToken());

        reloaded.clearDeviceToken();
        assertEquals("", store.getDeviceToken());
    }

    private static final class ReversingTokenCipher implements DeviceTokenStore.TokenCipher {
        @Override
        public String encrypt(String plaintext) {
            return new StringBuilder(plaintext).reverse().toString();
        }

        @Override
        public String decrypt(String encodedPayload) {
            return new StringBuilder(encodedPayload).reverse().toString();
        }
    }
}
