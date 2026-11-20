package reflipped.shell.common;

/** SH-15: the app's side of the version handshake with /shell/config. */
public final class AppVersionTest {
    private static void expect(String actual, String expected, String what) {
        if (expected == null ? actual != null : !expected.equals(actual))
            throw new AssertionError(what + ": expected <" + expected + "> but was <" + actual + ">");
    }

    public static void main(String[] args) {
        String newer = "This server needs a newer Reflipped app";
        // a server from before SH-15 reports neither field and accepts every app
        expect(AppVersion.refusal("0.1.0", 0, ""), null, "pre-handshake server");
        expect(AppVersion.refusal("0.1.0", 1, null), null, "no minimum");
        expect(AppVersion.refusal("0.1.0", 1, "0.1.0"), null, "exactly the minimum");
        expect(AppVersion.refusal("0.10.0", 1, "0.9.9"), null, "versions compare as numbers, not text");
        expect(AppVersion.refusal("0.1.0", 1, "0.2.0"), newer + " (version 0.2.0 or later).", "below the minimum");
        expect(AppVersion.refusal("0.1.0", 1, "00.02.000"), newer + " (version 0.2.0 or later).", "minimum is normalized");
        expect(AppVersion.refusal("0.1.0", 1, "soon"), null, "an unreadable minimum is ignored");
        expect(AppVersion.refusal("", 1, "0.2.0"), null, "a build without a version skips the minimum");
        // protocols
        expect(AppVersion.refusal("0.1.0", AppVersion.MAX_PROTOCOL + 1, ""), newer + ".", "newer protocol, no minimum");
        expect(AppVersion.refusal("0.1.0", AppVersion.MAX_PROTOCOL + 1, "0.1.0"), newer + ".",
                "newer protocol with a minimum this app meets names no version");
        expect(AppVersion.refusal("0.1.0", AppVersion.MAX_PROTOCOL + 1, "0.3.0"), newer + " (version 0.3.0 or later).",
                "newer protocol and a higher minimum");
        if (AppVersion.MIN_PROTOCOL > 1)
            expect(AppVersion.refusal("0.1.0", AppVersion.MIN_PROTOCOL - 1, ""),
                    "This server runs an older Reflipped version that this app no longer supports.", "older protocol");
        // refusals are recognised, other card messages aren't
        if (!AppVersion.isRefusal(AppVersion.refusal("0.1.0", 1, "0.2.0"))) throw new AssertionError("refusal not recognised");
        if (AppVersion.isRefusal("This server isn't ready right now. Tap to try again later."))
            throw new AssertionError("other message taken for a refusal");
        if (AppVersion.LONGEST_REFUSAL.length() < AppVersion.refusal("0.1.0", 1, "999.99.99-alpha.29").length())
            throw new AssertionError("reserved status text is shorter than a refusal");
        expect(AppVersion.label("0.1.0"), "app 0.1.0", "label");
        expect(AppVersion.label("00.2.0-beta.01"), "app 0.2.0-beta.1", "pre-release label");
        expect(AppVersion.label(""), "", "label without a version");
        preReleases(newer);
        System.out.println("App version handshake: minimum version and protocol checks give the expected messages");
    }

    /** Semver pre-releases (-alpha, -beta, -pre with an optional .N) and their Android version codes (build.py). */
    private static void preReleases(String newer) {
        String[][] codes = {{"0.1.0", "10099"}, {"0.2.0-beta.1", "20031"}, {"0.2.0-alpha", "20000"},
                {"0.2.0-alpha.29", "20029"}, {"0.2.0-beta", "20030"}, {"0.2.0-pre.1", "20061"}, {"1.2.3", "1020399"},
                {"999.99.99", "999999999"}, {"00.02.000-beta.03", "20033"}};
        for (String[] pair : codes) {
            AppVersion.Version v = AppVersion.parse(pair[0]);
            if (v == null || v.code != Integer.parseInt(pair[1]))
                throw new AssertionError(pair[0] + ": expected code " + pair[1] + " but was " + (v == null ? "null" : v.code));
        }
        expect(AppVersion.parse(" 00.02.000-beta.03 ").text, "0.2.0-beta.3", "normalized pre-release");
        expect(AppVersion.parse("0.2.0-pre").text, "0.2.0-pre", "pre-release without a number");
        String[] bad = {"1.2.3-rc.1", "1.2.3-beta.30", "1.100.0", "1.0.100", "1000.0.0", "1.2.3-BETA", "1.2.3-beta.",
                "1.2.3-", "1.2.3-alpha1", "1.2.3-alpha.1.2", "1.2.3+build", "1.2", "v1.2.3", ""};
        for (String text : bad)
            if (AppVersion.parse(text) != null) throw new AssertionError("accepted " + text);
        String[] ordered = {"0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.2", "0.2.0-beta", "0.2.0-beta.1", "0.2.0-pre.1",
                "0.2.0", "0.2.1-alpha", "0.2.1", "0.10.0-beta", "1.0.0"};
        for (int i = 1; i < ordered.length; i++)
            if (AppVersion.compare(AppVersion.parse(ordered[i - 1]), AppVersion.parse(ordered[i])) >= 0)
                throw new AssertionError(ordered[i - 1] + " should be older than " + ordered[i]);
        // a pre-release minimum
        expect(AppVersion.refusal("0.2.0-beta.2", 1, "0.2.0-beta.1"), null, "a later beta meets a beta minimum");
        expect(AppVersion.refusal("0.2.0-beta.1", 1, "0.2.0-beta.1"), null, "exactly a pre-release minimum");
        expect(AppVersion.refusal("0.2.0", 1, "0.2.0-beta.1"), null, "the release meets its pre-release minimum");
        expect(AppVersion.refusal("0.2.0-alpha.5", 1, "0.2.0-beta.1"), newer + " (version 0.2.0-beta.1 or later).",
                "an alpha is below a beta minimum");
        expect(AppVersion.refusal("0.2.0-pre.29", 1, "0.2.0"), newer + " (version 0.2.0 or later).",
                "a pre-release is below its release");
        expect(AppVersion.refusal("0.1.0", 1, "0.2.0-beta.01"), newer + " (version 0.2.0-beta.1 or later).",
                "the refusal names the normalized pre-release minimum");
    }
}
