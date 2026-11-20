package reflipped.shell.common;

import java.util.HashMap;
import java.util.Map;

/** Regression for unknown-origin upgrades: a current baked default must never establish old credential provenance. */
public final class OriginReviewTest {
    public static void main(String[] args) {
        check(ServerIdentity.recorded(null, null).isEmpty(), "unrecorded baked installs remain unknown");
        check(ServerIdentity.recorded("", "").isEmpty(), "empty history remains unknown");
        check(ServerIdentity.recorded(null, "https://old.example").equals("https://old.example"), "recorded address survives changed baked default");
        check(ServerIdentity.recorded("https://bound.example", "https://old.example").equals("https://bound.example"), "account binding takes precedence");
        check(ServerIdentity.recorded("not an address", "https://old.example").equals("https://old.example"), "invalid account marker does not establish provenance");
        final Map<String, String> values = new HashMap<>();
        values.put("deviceKey", "legacy-guest-secret");
        DeviceKeys.Store store = new DeviceKeys.Store() {
            public String get(String key) { return values.get(key); }
            public void put(String key, String value) { values.put(key, value); }
        };
        String recorded = ServerIdentity.recorded(null, null);
        if (!recorded.isEmpty()) DeviceKeys.associateLegacy(store, recorded);
        String newKey = DeviceKeys.forServer(store, "https://new-baked.example");
        check(!newKey.equals("legacy-guest-secret"), "new baked origin never receives unknown old key");
        check(!values.containsKey("legacyDeviceOrigin"), "legacy remains explicitly recoverable");
        check(values.get("deviceKey").equals("legacy-guest-secret"), "legacy proof retained locally");
        DeviceKeys.associateLegacy(store, "https://original.example");
        check(DeviceKeys.forServer(store, "https://original.example").equals("legacy-guest-secret"), "explicit recovery preserves original guest");
        check(DeviceKeys.forServer(store, "https://new-baked.example").equals(newKey), "new scoped guest unaffected by recovery elsewhere");
        System.out.println("SH-14 origin migration review regressions passed");
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
