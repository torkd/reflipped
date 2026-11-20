package reflipped.shell.common;

import java.net.URI;

/**
 * SH-15: the non-blocking "update available" notice. A server announces a newer Reflipped app in /shell/config
 * (`latestAppVersion`, `updateAvailable`, `updateUrl`, `updateNotes`; src/lib/shellHandshake.ts). Unlike
 * {@link AppVersion#refusal} this never stops anyone from joining. Plain Java, so it is tested on the JVM
 * (test/sh15-update-notice-test.sh); {@link UpdateNoticeDialog} shows it.
 */
public final class UpdateNotice {
    /** The public build guide, used when the server names no usable page. */
    public static final String DEFAULT_URL = "https://github.com/torkd/reflipped/blob/main/docs/connecting-air-shell.md";
    private static final int MAX_NOTES = 280;

    /** The newest version (normalized), the page to open, the notes ("" for none) and the dialog text. */
    public final String latest, url, notes, message;

    private UpdateNotice(String latest, String url, String notes) {
        this.latest = latest;
        this.url = url;
        this.notes = notes;
        this.message = "Update available: Reflipped app " + latest + ".\nRebuild your app with version " + latest
                + " (or newer). You can keep playing meanwhile." + (notes.isEmpty() ? "" : "\n\n" + notes);
    }

    /**
     * The notice for this app, or null when the server announced none or this app is current. `latest` is the
     * server's `latestAppVersion`, `available` its `updateAvailable` verdict (null when absent); the verdict is used
     * only when this app has no readable version, otherwise the app compares on its own.
     */
    public static UpdateNotice of(String appVersion, String latest, Boolean available, String url, String notes) {
        AppVersion.Version newest = AppVersion.parse(latest), app = AppVersion.parse(appVersion);
        if (newest == null) return null;
        boolean older = app != null ? AppVersion.compare(app, newest) < 0 : Boolean.TRUE.equals(available);
        return older ? new UpdateNotice(newest.text, page(url), plain(notes)) : null;
    }

    /** The server's page when it is an http(s) address with a host and no credentials, else the default guide. */
    static String page(String url) {
        if (url == null || url.trim().length() > 2048) return DEFAULT_URL;
        try {
            URI uri = new URI(url.trim());
            String scheme = uri.getScheme();
            boolean web = "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
            return web && uri.getHost() != null && uri.getUserInfo() == null && uri.getFragment() == null
                    ? uri.toString() : DEFAULT_URL;
        } catch (java.net.URISyntaxException invalid) {
            return DEFAULT_URL;
        }
    }

    /** Notes as one line of plain text of at most 280 characters (they are shown, never interpreted). */
    static String plain(String notes) {
        if (notes == null) return "";
        String line = notes.replaceAll("[\\p{Cntrl}\\u2028\\u2029]+", " ").trim();
        return line.length() > MAX_NOTES ? line.substring(0, MAX_NOTES) : line;
    }

    /** What is remembered once the notice was shown: it changes with the announced version. */
    public String seenKey() {
        return latest;
    }
}
