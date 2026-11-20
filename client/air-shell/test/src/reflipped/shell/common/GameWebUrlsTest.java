package reflipped.shell.common;

public final class GameWebUrlsTest {
    private static void check(boolean ok) { if (!ok) throw new AssertionError("URL policy"); }
    public static void main(String[] args) {
        check("https://server.test/game/odds".equals(GameWebUrls.page("https://server.test/", "KGSUPPORT_SHOWGACHAODDSVIEW")));
        check("https://server.test/game/community".equals(GameWebUrls.page("https://server.test", "KGSUPPORT_SHOWDAUMCAFEVIEW")));
        check("https://server.test/game/support".equals(GameWebUrls.page("https://server.test", "KGSUPPORT_SHOWCWVIEW")));
        for (String call : new String[]{"KGSUPPORT_SHOWEVENTWALL", "KGSUPPORT_SHOWEVENTPROGRESSWALL"})
            check("http://localhost:8000/game/events".equals(GameWebUrls.page("http://localhost:8000", call)));
        check(GameWebUrls.sameOrigin("https://SERVER.test", "https://server.test:443/game/odds/184"));
        for (String bad : new String[]{"https://server.test.evil/game", "https://server.test@evil.test/", "https://user:secret@server.test/", "http://server.test/", "https://server.test:444/", "javascript:alert(1)", "file:///tmp/x", "content://server.test/x", "intent://server.test/", "https://server.test\\@evil.test/", "//server.test/game"})
            check(!GameWebUrls.sameOrigin("https://server.test", bad));
        check(GameWebUrls.externalHttps("https://community.test/invite"));
        check(!GameWebUrls.externalHttps("http://community.test/"));
        check(!GameWebUrls.externalHttps("https://user:secret@community.test/"));
        check(GameWebUrls.page("https://server.test/?token=secret", "KGSUPPORT_SHOWGACHAODDSVIEW") == null);
        check(GameWebUrls.page("file:///tmp", "KGSUPPORT_SHOWGACHAODDSVIEW") == null);
        check(GameWebUrls.page("https://server.test", "UNKNOWN") == null);
        System.out.println("GameWebUrls tests passed");
    }
}
