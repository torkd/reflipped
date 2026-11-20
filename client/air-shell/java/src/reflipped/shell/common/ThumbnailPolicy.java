package reflipped.shell.common;

import java.net.URI;
import java.util.Locale;

/** Public artwork is optional and never receives credentials or follows redirects. */
public final class ThumbnailPolicy {
    public static final int MAX_BYTES = 512 * 1024;
    private ThumbnailPolicy() { }
    public static String validate(String value) {
        if (value == null || value.trim().isEmpty()) return "";
        value = value.trim();
        if (value.length() > 2048 || value.matches(".*\\s.*")) return "";
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                    || uri.getHost() == null || uri.getRawUserInfo() != null
                    || uri.getRawFragment() != null || uri.getPort() == 0 || uri.getPort() < -1 || uri.getPort() > 65535) return "";
            return value;
        } catch (Exception invalid) { return ""; }
    }

    /**
     * {@link #validate} for a card image named by `server`. An image on a loopback, private or link-local address
     * (or `localhost`) is accepted only when it is on the server's own host: a server on the internet must not make
     * the device send requests into its local network. Numeric hosts in any other form than a dotted quad
     * (`127.1`, `2130706433`, `0x7f.1`) are refused outright, since the resolver would read them as IPv4 addresses.
     * A public host name that resolves to a local address is not caught here.
     */
    public static String validateFor(String server, String value) {
        String url = validate(value);
        if (url.isEmpty()) return url;
        try {
            String host = host(new URI(url).getHost());
            if (!local(host)) return url;
            String own = server == null ? null : new URI(server.trim()).getHost();
            return own != null && host.equals(host(own)) && !odd(host) ? url : "";
        } catch (Exception invalid) { return ""; }
    }

    private static String host(String value) {
        String host = value.toLowerCase(Locale.ROOT);
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        while (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        return host;
    }

    private static final String QUAD = "\\d{1,3}(\\.\\d{1,3}){3}";

    /** A host the resolver would read as an IPv4 address written other than as a dotted quad. */
    private static boolean odd(String host) {
        if (host.matches(QUAD)) return false;
        for (String part : host.split("\\.", -1)) if (!part.matches("\\d+|0x[0-9a-f]*")) return false;
        return true;
    }

    static boolean local(String host) {
        if (host.isEmpty() || host.equals("localhost") || host.endsWith(".localhost") || odd(host)) return true;
        if (host.matches(QUAD)) {
            String[] parts = host.split("\\.");
            int a = Integer.parseInt(parts[0]), b = Integer.parseInt(parts[1]);
            return a == 0 || a == 10 || a == 127 || (a == 169 && b == 254) || (a == 172 && b >= 16 && b <= 31)
                    || (a == 192 && b == 168) || (a == 100 && b >= 64 && b <= 127);
        }
        if (!host.contains(":")) return false;
        if (host.equals("::") || host.equals("::1")) return true;
        int mapped = host.lastIndexOf(':');
        if (host.startsWith("::ffff:") && host.substring(mapped + 1).contains(".")) return local(host.substring(mapped + 1));
        return host.startsWith("fc") || host.startsWith("fd") || host.matches("fe[89ab].*");
    }
}
