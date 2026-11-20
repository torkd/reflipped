package reflipped.shell.common;

/** A build-time CDN is an override for one server origin, never a global replacement after switching servers. */
public final class CdnSelection {
    private static final String VALUE = "bakedCdnValue";
    private static final String ORIGIN = "bakedCdnOrigin";
    private static final String UNKNOWN = "bakedCdnUnassigned";

    private CdnSelection() { }

    /** Establish provenance before setup can overwrite a previously recorded server. */
    public static void initialize(DeviceKeys.Store store, String bakedServer, String bakedCdn,
                                  String recordedServer, boolean legacyState) {
        if (empty(bakedCdn) || !empty(bakedServer) || store.get(VALUE) != null) return;
        store.put(VALUE, bakedCdn);
        if (!empty(recordedServer)) store.put(ORIGIN, ServerIdentity.origin(recordedServer));
        else if (legacyState) store.put(UNKNOWN, "true");
        // A fresh install without a server waits for its first explicitly accepted address.
    }

    public static void accepted(DeviceKeys.Store store, String bakedServer, String bakedCdn, String server) {
        if (empty(bakedServer) && !empty(bakedCdn) && bakedCdn.equals(store.get(VALUE))
                && store.get(ORIGIN) == null && !"true".equals(store.get(UNKNOWN)))
            store.put(ORIGIN, ServerIdentity.origin(server));
    }

    public static String select(DeviceKeys.Store store, String currentServer, String bakedServer, String bakedCdn,
                                String reportedCdn, String reportedFor) {
        if (!empty(bakedCdn)) {
            String owner = !empty(bakedServer) ? bakedServer
                    : bakedCdn.equals(store.get(VALUE)) && !"true".equals(store.get(UNKNOWN)) ? store.get(ORIGIN) : null;
            if (ServerIdentity.same(currentServer, owner)) return bakedCdn;
        }
        if (!empty(reportedCdn) && ServerIdentity.same(currentServer, reportedFor)) return reportedCdn;
        String base = currentServer;
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        return base + "/patch/Live/2.0.0";
    }

    private static boolean empty(String value) { return value == null || value.isEmpty(); }
}
