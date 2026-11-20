package reflipped.shell.common;

import java.util.HashMap;
import java.util.Map;

/** Independent regression for build-time and reported CDN isolation while switching servers. */
public final class CdnSelectionTest {
    private static final String A = "https://a.example", B = "https://b.example";
    private static final String OVERRIDE = "https://cdn-a.example/assets", REPORTED_B = "https://cdn-b.example/assets";

    public static void main(String[] args) {
        DeviceKeys.Store store = store();
        check(CdnSelection.select(store, A, A, OVERRIDE, null, null).equals(OVERRIDE), "baked A override");
        check(CdnSelection.select(store, B, A, OVERRIDE, REPORTED_B, B).equals(REPORTED_B), "B uses its reported CDN");
        check(CdnSelection.select(store, B, A, OVERRIDE, null, null).equals(B + "/patch/Live/2.0.0"), "B defaults to its own patch");
        check(CdnSelection.select(store, A, A, OVERRIDE, null, null).equals(OVERRIDE), "return A reuses override");
        check(CdnSelection.select(store, "HTTPS://A.EXAMPLE:443/", A, OVERRIDE, null, null).equals(OVERRIDE), "same-origin aliases");
        check(CdnSelection.select(store, B, A, OVERRIDE, OVERRIDE, A).equals(B + "/patch/Live/2.0.0"), "stale reported A metadata is not a fallback for B");

        DeviceKeys.Store fresh = store();
        CdnSelection.initialize(fresh, "", OVERRIDE, "", false);
        CdnSelection.accepted(fresh, "", OVERRIDE, A);
        check(CdnSelection.select(fresh, A, "", OVERRIDE, null, null).equals(OVERRIDE), "CDN-only fresh initial address");
        CdnSelection.accepted(fresh, "", OVERRIDE, B);
        check(CdnSelection.select(fresh, B, "", OVERRIDE, REPORTED_B, B).equals(REPORTED_B), "CDN-only binding cannot move to B");
        check(CdnSelection.select(fresh, A, "", OVERRIDE, null, null).equals(OVERRIDE), "CDN-only binding survives return A");
        CdnSelection.initialize(fresh, "", "https://replacement.example", B, true);
        check(CdnSelection.select(fresh, B, "", "https://replacement.example", REPORTED_B, B).equals(REPORTED_B), "changed override cannot silently rebind to current B");

        DeviceKeys.Store known = store();
        CdnSelection.initialize(known, "", OVERRIDE, A, true);
        CdnSelection.accepted(known, "", OVERRIDE, B);
        check(CdnSelection.select(known, A, "", OVERRIDE, null, null).equals(OVERRIDE), "known legacy origin preserved before selection");
        check(CdnSelection.select(known, B, "", OVERRIDE, null, null).equals(B + "/patch/Live/2.0.0"), "known legacy override never leaks to B");

        DeviceKeys.Store unknown = store();
        CdnSelection.initialize(unknown, "", OVERRIDE, "", true);
        CdnSelection.accepted(unknown, "", OVERRIDE, B);
        check(CdnSelection.select(unknown, B, "", OVERRIDE, REPORTED_B, B).equals(REPORTED_B), "unknown legacy override stays unassigned");
        check(CdnSelection.select(unknown, A, A, OVERRIDE, null, null).equals(OVERRIDE), "explicit baked origin establishes new build intent");
        System.out.println("CDN origin selection and legacy binding checks passed");
    }

    private static DeviceKeys.Store store() {
        final Map<String, String> values = new HashMap<>();
        return new DeviceKeys.Store() {
            public String get(String key) { return values.get(key); }
            public void put(String key, String value) { values.put(key, value); }
        };
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
