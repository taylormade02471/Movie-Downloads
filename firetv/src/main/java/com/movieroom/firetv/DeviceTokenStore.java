package com.movieroom.firetv;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class DeviceTokenStore {
    private static final String PREFS = "movie_room_fire_tv";
    private static final String KEY_DEVICE_TOKEN = "device_token";
    private static final String KEY_DEVICE_TOKEN_ENCRYPTED = "device_token_encrypted";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEYSTORE_ALIAS = "movie_room_fire_tv_device_token";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;

    private final SharedPreferences preferences;
    private final TokenCipher cipher;

    public DeviceTokenStore(Context context) {
        this(
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE),
                new AesGcmKeystoreTokenCipher());
    }

    DeviceTokenStore(SharedPreferences preferences, TokenCipher cipher) {
        this.preferences = preferences;
        this.cipher = cipher;
    }

    public String getDeviceToken() {
        String encrypted = preferences.getString(KEY_DEVICE_TOKEN_ENCRYPTED, "");
        if (!encrypted.isEmpty()) {
            try {
                return cipher.decrypt(encrypted);
            } catch (Exception error) {
                clearDeviceToken();
                return "";
            }
        }

        String legacyPlaintext = preferences.getString(KEY_DEVICE_TOKEN, "");
        if (!legacyPlaintext.isEmpty()) {
            saveDeviceToken(legacyPlaintext);
            return legacyPlaintext;
        }

        return "";
    }

    public void saveDeviceToken(String token) {
        if (token == null || token.isEmpty()) {
            clearDeviceToken();
            return;
        }

        try {
            preferences.edit()
                    .putString(KEY_DEVICE_TOKEN_ENCRYPTED, cipher.encrypt(token))
                    .remove(KEY_DEVICE_TOKEN)
                    .apply();
        } catch (Exception error) {
            throw new IllegalStateException("Could not secure the Fire TV device token.", error);
        }
    }

    public void clearDeviceToken() {
        preferences.edit()
                .remove(KEY_DEVICE_TOKEN)
                .remove(KEY_DEVICE_TOKEN_ENCRYPTED)
                .apply();
    }

    interface TokenCipher {
        String encrypt(String plaintext) throws Exception;

        String decrypt(String encodedPayload) throws Exception;
    }

    static final class AesGcmKeystoreTokenCipher implements TokenCipher {
        @Override
        public String encrypt(String plaintext) throws Exception {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(iv, Base64.NO_WRAP)
                    + "."
                    + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
        }

        @Override
        public String decrypt(String encodedPayload) throws Exception {
            String[] parts = encodedPayload.split("\\.", 2);
            if (parts.length != 2) {
                throw new IllegalArgumentException("Encrypted token payload is malformed.");
            }

            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        }

        private SecretKey getOrCreateKey() throws Exception {
            KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
            keyStore.load(null);
            if (keyStore.containsAlias(KEYSTORE_ALIAS)) {
                return (SecretKey) keyStore.getKey(KEYSTORE_ALIAS, null);
            }

            KeyGenerator keyGenerator = KeyGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_AES,
                    KEYSTORE_PROVIDER);
            keyGenerator.init(new KeyGenParameterSpec.Builder(
                    KEYSTORE_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return keyGenerator.generateKey();
        }
    }
}
