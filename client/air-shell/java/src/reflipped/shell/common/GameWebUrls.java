package reflipped.shell.common;

import java.net.URI;

/** URL policy for the read-only server pages. No account tokens or arbitrary SDK URL arguments are used. */
public final class GameWebUrls {
    private GameWebUrls() { }

    public static String page(String server, String call) {
        String path;
        if ("KGSUPPORT_SHOWGACHAODDSVIEW".equals(call)) path = "/game/odds";
        else if ("KGSUPPORT_SHOWEVENTWALL".equals(call) || "KGSUPPORT_SHOWEVENTPROGRESSWALL".equals(call)) path = "/game/events";
        else if ("KGSUPPORT_SHOWCWVIEW".equals(call)) path = "/game/support";
        else if ("KGSUPPORT_SHOWDAUMCAFEVIEW".equals(call)) path = "/game/community";
        else return null;
        URI base = http(server);
        if (base == null || base.getRawQuery() != null || base.getRawFragment() != null) return null;
        return server.replaceAll("/+$", "") + path;
    }

    public static boolean sameOrigin(String base, String target) {
        URI a = http(base), b = http(target);
        return a != null && b != null && a.getScheme().equalsIgnoreCase(b.getScheme())
                && a.getHost().equalsIgnoreCase(b.getHost()) && port(a) == port(b);
    }

    public static boolean externalHttps(String target) {
        URI uri = http(target);
        return uri != null && "https".equalsIgnoreCase(uri.getScheme());
    }

    private static int port(URI uri) {
        return uri.getPort() >= 0 ? uri.getPort() : ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80);
    }

    private static URI http(String value) {
        try {
            URI uri = new URI(value);
            return ("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))
                    && uri.getHost() != null && !uri.getHost().isEmpty() && uri.getRawUserInfo() == null ? uri : null;
        } catch (Exception ignored) { return null; }
    }
}
