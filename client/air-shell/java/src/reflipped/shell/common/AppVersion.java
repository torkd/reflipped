package reflipped.shell.common;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SH-15: the app's side of the version handshake. build.py bakes the app version (client/air-shell/VERSION) and build
 * ID into the manifest ({@link ShellConfig#appVersion}); the shell sends both with /shell/config and at sign-in, and
 * the server answers with its shell protocol and the oldest app version it supports (src/lib/shellHandshake.ts).
 * Plain Java, so it is tested on the JVM (test/sh15-app-version-test.sh).
 */
public final class AppVersion {
    private AppVersion() {
    }

    /**
     * The shell protocols this app understands: the server's SHELL_PROTOCOL (src/lib/serverVersion.ts). A server that
     * reports none predates SH-15 and speaks protocol 1.
     */
    public static final int MIN_PROTOCOL = 1, MAX_PROTOCOL = 1;

    /** Request headers, read by src/lib/appVersion.ts. */
    public static final String VERSION_HEADER = "Reflipped-App-Version", BUILD_HEADER = "Reflipped-App-Build";

    private static final String NEWER_APP = "This server needs a newer Reflipped app";
    private static final String OLDER_SERVER = "This server runs an older Reflipped version that this app no longer supports.";
    /** The longest refusal, for reserving room in a status line: it names the longest version {@link #parse} accepts. */
    public static final String LONGEST_REFUSAL = NEWER_APP + " (version 999.99.99-alpha.29 or later).";

    /*
     * The app version scheme, defined by client/air-shell/build.py (app_version, version_code) and followed by the
     * server's src/lib/appVersion.ts: MAJOR.MINOR.PATCH with an optional pre-release -alpha, -beta or -pre, optionally
     * followed by .N (0.2.0, 0.2.0-alpha, 0.2.0-beta.3, 1.0.0-pre.1). Leading zeros are dropped; anything else is
     * refused. Each version maps to its Android version code, which also orders versions as semver does:
     *     code = MAJOR * 1000000 + MINOR * 10000 + PATCH * 100 + stage
     * with stage alpha.N = N, beta.N = 30 + N, pre.N = 60 + N (a missing N is 0; N is 0-29) and 99 for a final
     * release; MINOR and PATCH are 0-99 and MAJOR 0-999.
     */
    private static final Pattern VERSION =
            Pattern.compile("(\\d{1,6})\\.(\\d{1,6})\\.(\\d{1,6})(?:-(alpha|beta|pre)(?:\\.(\\d{1,6}))?)?");
    private static final int MAX_MAJOR = 999, MAX_MINOR = 99, MAX_PATCH = 99, MAX_STAGE_NUMBER = 29, FINAL_STAGE = 99;

    /** A parsed version: its normalized text and Android version code. */
    static final class Version {
        final String text;
        final int code;

        Version(String text, int code) {
            this.text = text;
            this.code = code;
        }
    }

    /** The version, or null when it isn't one the scheme above accepts. */
    static Version parse(String text) {
        if (text == null) return null;
        Matcher m = VERSION.matcher(text.trim());
        if (!m.matches()) return null;
        int major = Integer.parseInt(m.group(1)), minor = Integer.parseInt(m.group(2)), patch = Integer.parseInt(m.group(3));
        String stage = m.group(4);
        int number = m.group(5) == null ? 0 : Integer.parseInt(m.group(5));
        if (major > MAX_MAJOR || minor > MAX_MINOR || patch > MAX_PATCH || number > MAX_STAGE_NUMBER) return null;
        int stageCode = stage == null ? FINAL_STAGE
                : ("alpha".equals(stage) ? 0 : "beta".equals(stage) ? 30 : 60) + number;
        String normalized = major + "." + minor + "." + patch + (stage == null ? "" : "-" + stage)
                + (m.group(5) == null ? "" : "." + number);
        return new Version(normalized, major * 1000000 + minor * 10000 + patch * 100 + stageCode);
    }

    /** Negative when a is older than b, 0 when equal, positive when newer. */
    static int compare(Version a, Version b) {
        return a.code < b.code ? -1 : a.code == b.code ? 0 : 1;
    }

    /**
     * Why this app can't join a server whose /shell/config reported `protocol` (0 when absent) and `minimum` ("" or
     * null when absent), or null when it can. An app without a readable version skips the minimum check.
     */
    public static String refusal(String appVersion, int protocol, String minimum) {
        Version app = parse(appVersion), oldest = parse(minimum);
        int spoken = protocol <= 0 ? 1 : protocol;
        boolean tooOld = spoken > MAX_PROTOCOL || (app != null && oldest != null && compare(app, oldest) < 0);
        if (tooOld) {
            // the version the server named, when it is one this app doesn't meet
            boolean named = oldest != null && (app == null || compare(app, oldest) < 0);
            return named ? NEWER_APP + " (version " + oldest.text + " or later)."
                         : NEWER_APP + ".";
        }
        if (spoken < MIN_PROTOCOL) return OLDER_SERVER;
        return null;
    }

    /** Whether a status message is one of {@link #refusal}'s. */
    public static boolean isRefusal(String message) {
        return message != null && (message.startsWith(NEWER_APP) || message.equals(OLDER_SERVER));
    }

    /** "app 0.1.0" or "app 0.2.0-beta.1", or "" when the build carries no version. */
    public static String label(String appVersion) {
        Version app = parse(appVersion);
        return app == null ? "" : "app " + app.text;
    }
}
