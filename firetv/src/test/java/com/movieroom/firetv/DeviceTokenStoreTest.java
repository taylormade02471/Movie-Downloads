package com.movieroom.firetv;

import static org.junit.Assert.assertEquals;

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
        DeviceTokenStore store = new DeviceTokenStore(context);

        store.clearDeviceToken();
        assertEquals("", store.getDeviceToken());

        store.saveDeviceToken("device-1.secret");
        DeviceTokenStore reloaded = new DeviceTokenStore(context);
        assertEquals("device-1.secret", reloaded.getDeviceToken());

        reloaded.clearDeviceToken();
        assertEquals("", store.getDeviceToken());
    }
}
