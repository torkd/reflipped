package reflipped.shell.common;

/** SH-15: the app's "update available" notice from /shell/config. */
public final class UpdateNoticeTest {
    private static void expect(Object actual, Object expected, String what) {
        if (expected == null ? actual != null : !expected.equals(actual))
            throw new AssertionError(what + ": expected <" + expected + "> but was <" + actual + ">");
    }

    public static void main(String[] args) {
        // nothing announced, or this app is current or newer
        expect(UpdateNotice.of("0.2.0", null, null, null, null), null, "no announcement (older server)");
        expect(UpdateNotice.of("0.2.0", "", null, null, null), null, "blank announcement");
        expect(UpdateNotice.of("0.2.0", "soon", Boolean.TRUE, null, null), null, "unreadable version");
        expect(UpdateNotice.of("0.2.0", "0.2.0", Boolean.FALSE, null, null), null, "current");
        expect(UpdateNotice.of("0.10.0", "0.9.9", Boolean.FALSE, null, null), null, "numeric comparison");
        expect(UpdateNotice.of("0.3.0", "0.2.0", Boolean.TRUE, null, null), null, "the app's own comparison wins");

        UpdateNotice notice = UpdateNotice.of("0.2.0", "00.3.0", Boolean.TRUE, "https://example.org/get", " Fixes\nthe lobby. ");
        expect(notice.latest, "0.3.0", "normalized version");
        expect(notice.url, "https://example.org/get", "server page");
        expect(notice.notes, "Fixes the lobby.", "notes on one line");
        expect(notice.message, "Update available: Reflipped app 0.3.0.\nRebuild your app with version 0.3.0 (or newer)."
                + " You can keep playing meanwhile.\n\nFixes the lobby.", "message with notes");
        expect(UpdateNotice.of("0.2.0", "0.3.0", null, null, null).message,
                "Update available: Reflipped app 0.3.0.\nRebuild your app with version 0.3.0 (or newer)."
                        + " You can keep playing meanwhile.", "message without notes");
        expect(UpdateNotice.of("0.3.0-beta.2", "0.3.0", null, null, null) != null, true, "a pre-release is older than its release");
        // a build without a readable version relies on the server's verdict
        expect(UpdateNotice.of("", "0.3.0", Boolean.TRUE, null, null) != null, true, "verdict true");
        expect(UpdateNotice.of("", "0.3.0", Boolean.FALSE, null, null), null, "verdict false");
        expect(UpdateNotice.of("", "0.3.0", null, null, null), null, "no verdict");

        // the page: only http(s) addresses with a host and no credentials; otherwise the public guide
        for (String bad : new String[] {null, "", "javascript:alert(1)", "intent://x#Intent;end", "file:///sdcard/x",
                "https://user:pw@example.org/", "https://example.org/#x", "example.org", "https://exa mple.org/"})
            expect(UpdateNotice.of("0.2.0", "0.3.0", null, bad, null).url, UpdateNotice.DEFAULT_URL, "page " + bad);
        expect(UpdateNotice.of("0.2.0", "0.3.0", null, "http://192.168.1.10:8000/app", null).url,
                "http://192.168.1.10:8000/app", "http page");
        // notes are plain, one line, at most 280 characters
        StringBuilder longNotes = new StringBuilder();
        for (int i = 0; i < 400; i++) longNotes.append('x');
        expect(UpdateNotice.of("0.2.0", "0.3.0", null, null, longNotes.toString()).notes.length(), 280, "notes length");
        expect(UpdateNotice.of("0.2.0", "0.3.0", null, null, "\n\t ").notes, "", "blank notes");
        expect(UpdateNotice.of("0.2.0", "0.3.0", null, null, "a\u0000b c").notes, "a b c", "control characters");
        expect(UpdateNotice.of("0.2.0", "0.3.1", null, null, null).seenKey().equals(notice.seenKey()), false, "seen key follows the version");
        System.out.println("Update notice: version comparison, page and notes checks give the expected notice");
    }
}
