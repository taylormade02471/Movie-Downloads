package com.movieroom.firetv;

final class PairingQrUrl {
    private PairingQrUrl() {
    }

    static String build(String baseUrl, String code) {
        String normalizedBaseUrl = baseUrl == null ? "" : baseUrl.trim();
        while (normalizedBaseUrl.endsWith("/")) {
            normalizedBaseUrl = normalizedBaseUrl.substring(0, normalizedBaseUrl.length() - 1);
        }
        String normalizedCode = code == null ? "" : code.trim().toUpperCase(java.util.Locale.US);
        if (normalizedBaseUrl.isEmpty() || normalizedCode.isEmpty()) {
            throw new IllegalArgumentException("A Movie Room URL and pairing code are required.");
        }
        return normalizedBaseUrl + "/?firetv_code=" + normalizedCode;
    }
}
