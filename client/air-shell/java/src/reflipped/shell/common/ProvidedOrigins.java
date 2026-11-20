package reflipped.shell.common;

import java.util.LinkedHashSet;
import java.util.Set;

/** Read-only membership comes exclusively from the bundled catalogue, never a server's reply. */
public final class ProvidedOrigins {
    private final Set<String> origins = new LinkedHashSet<>();

    public ProvidedOrigins(Iterable<String> addresses) {
        for (String address : addresses) origins.add(ServerIdentity.origin(address));
    }

    public boolean contains(String address) {
        try {
            return origins.contains(ServerIdentity.origin(address));
        } catch (IllegalArgumentException invalid) {
            return false;
        }
    }
}
