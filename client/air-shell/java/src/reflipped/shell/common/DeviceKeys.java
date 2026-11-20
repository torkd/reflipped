package reflipped.shell.common;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.UUID;

/** Keeps the legacy guest credential on its current origin; new origins get independent random secrets. */
public final class DeviceKeys {
    public interface Store { String get(String name); void put(String name, String value); }
    private DeviceKeys() { }

    public static synchronized void associateLegacy(Store store, String server) {
        if (store.get("legacyDeviceOrigin") == null && store.get("deviceKey") != null)
            store.put("legacyDeviceOrigin", ServerIdentity.origin(server));
    }

    public static synchronized String forServer(Store store, String server) {
        String origin = ServerIdentity.origin(server);
        String legacyOrigin = store.get("legacyDeviceOrigin");
        if (ServerIdentity.same(origin, legacyOrigin)) {
            String key = store.get("deviceKey");
            if (key == null) { key = UUID.randomUUID().toString(); store.put("deviceKey", key); }
            return key;
        }
        String name = "deviceKeyOrigin." + digest(origin);
        String key = store.get(name);
        if (key == null) { key = UUID.randomUUID().toString(); store.put(name, key); }
        return key;
    }

    private static String digest(String origin) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(origin.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
