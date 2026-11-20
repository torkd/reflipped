package reflipped.shell.common;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * The addresses to try for what a player typed. With a scheme, exactly that address. Without one, a public name is
 * tried over HTTPS only, but a host on the player's own network (private or loopback IP, `localhost`, a single-label
 * or `.local`/`.lan`/`.home.arpa`/`.internal` name) is tried over HTTP first and then HTTPS: home servers rarely have
 * certificates, and players shouldn't have to know to type `http://`.
 */
public final class AddressCandidates {
    private AddressCandidates() {}

    public static List<String> of(String typed) {
        String https = ServerIdentity.connectionAddress(typed);
        if (https == null) return Collections.emptyList();
        if (typed.trim().contains("://")) return Collections.singletonList(https);
        List<String> result = new ArrayList<>();
        if (homeNetwork(https)) result.add("http://" + https.substring("https://".length()));
        result.add(https);
        return result;
    }

    static boolean homeNetwork(String address) {
        try {
            String host = new URI(address).getHost().toLowerCase(Locale.ROOT);
            if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
            while (host.endsWith(".")) host = host.substring(0, host.length() - 1);
            return ThumbnailPolicy.local(host) || !host.contains(".") && !host.contains(":") || host.endsWith(".local")
                    || host.endsWith(".lan") || host.endsWith(".home.arpa") || host.endsWith(".internal");
        } catch (Exception invalid) {
            return false;
        }
    }
}
