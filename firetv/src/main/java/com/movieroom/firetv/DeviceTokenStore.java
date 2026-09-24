package com.movieroom.firetv;

import android.content.Context;
import android.content.SharedPreferences;

public final class DeviceTokenStore {
    private static final String PREFS = "movie_room_fire_tv";
    private static final String KEY_DEVICE_TOKEN = "device_token";

    private final SharedPreferences preferences;

    public DeviceTokenStore(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public String getDeviceToken() {
        return preferences.getString(KEY_DEVICE_TOKEN, "");
    }

    public void saveDeviceToken(String token) {
        preferences.edit().putString(KEY_DEVICE_TOKEN, token).apply();
    }

    public void clearDeviceToken() {
        preferences.edit().remove(KEY_DEVICE_TOKEN).apply();
    }
}
