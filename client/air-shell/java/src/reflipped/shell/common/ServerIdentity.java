package reflipped.shell.common;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Canonical origin identity for credentials; aliases do not create a second guest account. */
public final class ServerIdentity {
    private ServerIdentity() { }

    public static String selected(String baked, String stored, boolean explicitlySelected) {
        if (baked != null && !baked.isEmpty() && !explicitlySelected) return baked;
        return stored == null || stored.isEmpty() ? (baked == null ? "" : baked) : stored;
    }

    /** Only previously recorded addresses establish provenance; a new baked default is not historical evidence. */
    public static String recorded(String accountServer, String storedServer) {
        for (String value : new String[]{accountServer, storedServer}) {
            try { origin(value); return value; }
            catch (IllegalArgumentException invalid) { }
        }
        return "";
    }

    /** Typed connection addresses are host/port only; URL prefixes cannot share origin-scoped credentials. */
    public static String connectionAddress(String text) { return address(text, false); }

    /** CDN and administrator destinations may contain paths, unlike a game server's connection address. */
    public static String resourceAddress(String text) { return address(text, true); }

    private static String address(String text, boolean allowPath) {
        if (text == null || text.trim().isEmpty()) return null;
        String value = text.trim();
        if (!value.contains("://")) value = "https://" + value;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        try {
            URI uri = new URI(value);
            if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))
                    || uri.getHost() == null || uri.getHost().isEmpty() || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535 || uri.getRawAuthority().endsWith(":")) return null;
            if (!allowPath && uri.getRawPath() != null && !uri.getRawPath().isEmpty()) return null;
            return value;
        } catch (URISyntaxException invalid) { return null; }
    }

    public static String origin(String value) {
        // Historical provenance must already have an explicit scheme, never infer one from arbitrary old text.
        String valid = value != null && value.contains("://") ? connectionAddress(value) : null;
        if (valid == null) throw new IllegalArgumentException("Invalid server origin");
        try {
            URI uri = new URI(valid);
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            int port = uri.getPort();
            if ((port == 80 && "http".equals(scheme)) || (port == 443 && "https".equals(scheme))) port = -1;
            return new URI(scheme, null, uri.getHost().toLowerCase(Locale.ROOT), port, null, null, null).toString();
        } catch (URISyntaxException invalid) { throw new IllegalArgumentException("Invalid server origin", invalid); }
    }

    public static boolean same(String first, String second) {
        try { return origin(first).equals(origin(second)); }
        catch (IllegalArgumentException invalid) { return false; }
    }
}
