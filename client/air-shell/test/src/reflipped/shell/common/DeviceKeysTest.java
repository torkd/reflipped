package reflipped.shell.common;

import java.util.HashMap;
import java.util.Map;

public final class DeviceKeysTest {
    public static void main(String[] args) {
        check(ServerIdentity.selected("https://baked.example", "https://stale.example", false).equals("https://baked.example"), "old stale prefs cannot override baked default");
        check(ServerIdentity.selected("https://baked.example", "https://chosen.example", true).equals("https://chosen.example"), "new explicit choice overrides baked default");
        check(ServerIdentity.selected("https://baked.example", null, true).equals("https://baked.example"), "missing selected value uses baked fallback");
        final Map<String, String> values = new HashMap<>();
        values.put("deviceKey", "legacy-secret");
        DeviceKeys.Store store = new DeviceKeys.Store() {
            public String get(String key) { return values.get(key); }
            public void put(String key, String value) { values.put(key, value); }
        };
        DeviceKeys.associateLegacy(store, "HTTPS://Example.COM:443/");
        check(DeviceKeys.forServer(store, "HTTPS://Example.COM:443/").equals("legacy-secret"), "legacy current origin");
        check(DeviceKeys.forServer(store, "https://example.com").equals("legacy-secret"), "origin aliases");
        String other = DeviceKeys.forServer(store, "https://other.example");
        check(!other.equals("legacy-secret"), "new origin must not receive legacy secret");
        check(DeviceKeys.forServer(store, "https://OTHER.example:443/").equals(other), "return to selected origin");
        check(DeviceKeys.forServer(store, "https://example.com/").equals("legacy-secret"), "return to original guest save");
        check(!DeviceKeys.forServer(store, "http://example.com").equals("legacy-secret"), "scheme isolation");
        check(!DeviceKeys.forServer(store, "https://example.com:8443").equals("legacy-secret"), "port isolation");
        check(ServerIdentity.same("http://host:80/", "HTTP://HOST"), "default HTTP port");
        check(ServerIdentity.same("http://[::1]:80/", "http://[::1]"), "IPv6 identity");
        check(!ServerIdentity.same("https://user:pass@host", "https://host"), "credential URLs refused");
        final Map<String, String> unassigned = new HashMap<>();
        unassigned.put("deviceKey", "unassigned-old-key");
        DeviceKeys.Store unknown = new DeviceKeys.Store() {
            public String get(String key) { return unassigned.get(key); }
            public void put(String key, String value) { unassigned.put(key, value); }
        };
        String fresh = DeviceKeys.forServer(unknown, "https://new.example");
        check(!fresh.equals("unassigned-old-key"), "unknown provenance must not expose old key");
        check(unassigned.get("deviceKey").equals("unassigned-old-key"), "unassigned legacy remains recoverable");
        check(!unassigned.containsKey("legacyDeviceOrigin"), "no guessed legacy association");
        DeviceKeys.associateLegacy(unknown, "https://original.example");
        check(DeviceKeys.forServer(unknown, "https://original.example").equals("unassigned-old-key"), "explicit original recovery");
        check(DeviceKeys.forServer(unknown, "https://new.example").equals(fresh), "fresh origin retained after legacy recovery");
        System.out.println("Device key isolation and legacy migration checks passed");
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
