package reflipped.shell.common;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Run with Android app_process for real org.json, but only an in-memory Store. No app, preferences or networking. */
public final class ServerListCodecRuntimeTest {
    private static final String KEY = "myServers.v1";
    private static int checks;
    private static final class Memory implements DeviceKeys.Store {
        final Map<String, String> values = new HashMap<>();
        final List<String> writes = new ArrayList<>();
        public String get(String key) { return values.get(key); }
        public void put(String key, String value) { writes.add(key); values.put(key, value); }
    }
    public static void main(String[] args) throws Exception {
        roundTripAndOfflineEdits();
        migrateAndRemove();
        limitsAndUntrustedMetadata();
        seedLegacyCurrentOnlyOnce();
        reclaimOnlyRedundantProvidedBookmark();
        System.out.println("SERVER_LIST_CODEC_OK checks=" + checks + " storage=in-memory json=Android");
    }
    private static ServerDirectory.Entry entry(String address, String name) {
        return new ServerDirectory.Entry(name, address, "Owner's public description", "Classic progression",
                "https://images.example.org/thumbnail.png?width=320&v=2", "online", Progression.of("accelerated", 7));
    }
    private static Memory guarded() {
        Memory store = new Memory();
        for (String key : new String[]{"deviceKey", "portalToken", "playerId", "server", "accountServer", "assetServer", "serverAssetReset", "legacyDeviceOrigin"})
            store.values.put(key, "UNRELATED_SYNTHETIC_VALUE_" + key);
        return store;
    }
    private static void unchanged(Memory store, Map<String, String> original) {
        for (Map.Entry<String, String> item : original.entrySet())
            check(item.getValue().equals(store.values.get(item.getKey())), "unrelated key was changed: " + item.getKey());
        for (String key : store.writes) check(key.equals(KEY), "non-bookmark write attempted: " + key);
    }
    private static void roundTripAndOfflineEdits() throws Exception {
        Memory store = guarded();
        Map<String, String> original = new HashMap<>(store.values);
        ServerListStore.Item added = ServerListStore.save(store, null, "  My private nickname  ", entry("HTTPS://Example.COM:443/", "Reported \"name\" & <text>"));
        check(added.address.equals("https://example.com"), "canonical add");
        List<ServerListStore.Item> rows = ServerListStore.load(store);
        check(rows.size() == 1 && rows.get(0).nickname.equals("My private nickname"), "nickname round trip");
        ServerDirectory.Entry metadata = rows.get(0).metadata;
        check(metadata.name.equals("Reported \"name\" & <text>"), "actual name is separate");
        check(metadata.description.equals("Owner's public description"), "description round trip");
        check(metadata.type.equals("Classic progression"), "type round trip");
        check(metadata.thumbnail.equals("https://images.example.org/thumbnail.png?width=320&v=2"), "public thumbnail query round trip");
        check(metadata.mode.equals("online") && metadata.progression.mode.equals("accelerated") && metadata.progression.acceleration == 7, "mode/progression round trip");
        JSONObject encoded = new JSONArray(store.values.get(KEY)).getJSONObject(0);
        Set<String> keys = new HashSet<>();
        for (Iterator<String> i = encoded.keys(); i.hasNext();) keys.add(i.next());
        check(keys.equals(new HashSet<>(Arrays.asList("address", "nickname", "name", "description", "type", "thumbnail", "mode", "progression"))), "only public bookmark fields serialized");
        ServerListStore.save(store, null, "Offline", "https://unreachable.example:8443");
        check(ServerListStore.load(store).size() == 2, "offline save requires no connection");
        check(ServerListStore.load(store).get(1).metadata.progression.mode.equals(""), "offline metadata remains unknown");
        ServerListStore.save(store, "https://example.com", "New nickname", "HTTPS://EXAMPLE.COM:443/");
        check(ServerListStore.load(store).get(0).metadata.name.equals(metadata.name), "same-origin offline edit retains real metadata");
        String before = store.values.get(KEY);
        try { ServerListStore.save(store, null, "Overwrite", entry("https://example.com", "Changed")); throw new AssertionError("duplicate add accepted"); }
        catch (ServerListStore.Duplicate expected) { check(expected.address.equals("https://example.com"), "duplicate points to saved origin"); }
        check(before.equals(store.values.get(KEY)), "duplicate add writes nothing");
        try { ServerListStore.save(store, "https://unreachable.example:8443", "Collision", "https://example.com"); throw new AssertionError("duplicate edit accepted"); }
        catch (ServerListStore.Duplicate expected) { }
        check(before.equals(store.values.get(KEY)), "duplicate edit leaves both profiles unchanged");
        try { ServerListStore.save(store, "https://example.com", "Bad\nNickname", "https://example.com"); throw new AssertionError("invalid nickname accepted"); }
        catch (IllegalArgumentException expected) { }
        check(before.equals(store.values.get(KEY)), "invalid edit is atomic");
        ServerListStore.updateMetadata(store, entry("https://example.com", "New reported name"));
        check(ServerListStore.load(store).get(0).nickname.equals("New nickname"), "Join metadata update preserves nickname");
        ServerListStore.updateMetadata(store, entry("https://not-saved.example", "Must not add"));
        check(ServerListStore.load(store).size() == 2, "metadata probe cannot add a bookmark");
        ServerListStore.save(store, "https://unreachable.example:8443", "Moved address", "https://different.example");
        check(ServerListStore.load(store).get(1).address.equals("https://different.example"), "edit retains stable row index");
        check(ServerListStore.load(store).get(1).metadata.name.equals("Server"), "address change does not copy other origin metadata");
        check(ServerListStore.remove(store, "HTTPS://EXAMPLE.COM:443/"), "canonical removal");
        check(!ServerListStore.remove(store, "https://example.com"), "repeat removal harmless");
        unchanged(store, original);
    }
    private static void migrateAndRemove() throws Exception {
        Memory store = guarded();
        JSONArray history = new JSONArray();
        history.put(new JSONObject().put("address", "HTTPS://Legacy.EXAMPLE:443/").put("name", "Legacy reported name")
                .put("description", "Wrapped\nowner description").put("type", "Classic").put("nickname", "Ignore unknown legacy nickname")
                .put("portalToken", "MUST_NOT_COPY").put("deviceKey", "MUST_NOT_COPY")
                .put("progression", new JSONObject().put("mode", "classic").put("acceleration", 9)));
        history.put(new JSONObject().put("address", "https://legacy.example").put("name", "Duplicate must not replace first"));
        history.put(true);
        history.put(new JSONObject().put("address", "https://invalid.example/prefix").put("name", "Invalid row"));
        history.put(new JSONObject().put("address", "https://second.example").put("name", "Second history row"));
        store.values.put("serverHistory", history.toString());
        Map<String, String> original = new HashMap<>(store.values);
        List<ServerListStore.Item> rows = ServerListStore.load(store);
        check(rows.size() == 2, "malformed individual history rows skipped, canonical duplicates deduped");
        check(rows.get(0).metadata.name.equals("Legacy reported name") && rows.get(0).nickname.equals(""), "migration retains first metadata and adds no guessed nickname");
        check(rows.get(0).metadata.description.equals("Wrapped owner description"), "legacy wrapped metadata safely normalized");
        check(rows.get(0).metadata.progression.acceleration == 1, "inactive acceleration not misreported");
        check(!store.values.get(KEY).contains("MUST_NOT_COPY") && !store.values.get(KEY).contains("portalToken") && !store.values.get(KEY).contains("deviceKey"), "unknown/auth named history fields excluded");
        int writes = store.writes.size();
        ServerListStore.load(store);
        check(store.writes.size() == writes, "migration is one-time");
        ServerListStore.remove(store, "https://legacy.example");
        ServerListStore.remove(store, "https://second.example");
        check(new JSONArray(store.values.get(KEY)).length() == 0 && ServerListStore.load(store).isEmpty(), "empty current list never resurrects deleted history");
        store.values.put(KEY, "not-json");
        check(ServerListStore.load(store).isEmpty(), "corrupt current list does not reactivate legacy history");
        store.values.put(KEY, new JSONArray().put("bad row").put(new JSONObject().put("address", "https://survivor.example").put("name", "Survivor")).toString());
        check(ServerListStore.load(store).size() == 1, "one bad saved row does not discard later valid rows");
        unchanged(store, original);
    }
    private static void limitsAndUntrustedMetadata() {
        Memory store = guarded();
        Map<String, String> original = new HashMap<>(store.values);
        StringBuilder oversized = new StringBuilder(); for (int i = 0; i < 700; i++) oversized.append('a');
        ServerDirectory.Entry untrusted = new ServerDirectory.Entry(oversized.toString(), "https://large.example", "Line1\nLine2" + oversized,
                oversized.toString(), "javascript:alert(1)", "local", null);
        ServerListStore.save(store, null, "", untrusted);
        ServerDirectory.Entry clean = ServerListStore.load(store).get(0).metadata;
        check(clean.name.length() == 64 && clean.description.length() == 500 && clean.type.length() == 40, "untrusted display metadata capped instead of blocking Join");
        check(!clean.description.contains("\n") && clean.thumbnail.isEmpty() && clean.mode.equals("online"), "display controls/unsafe thumbnail/local masquerade normalized");
        for (int i = 1; i < 50; i++) ServerListStore.save(store, null, "", "https://host" + i + ".example");
        String before = store.values.get(KEY);
        try { ServerListStore.save(store, null, "", "https://overflow.example"); throw new AssertionError("full list accepted addition"); }
        catch (ServerListStore.Full expected) { }
        check(before.equals(store.values.get(KEY)) && ServerListStore.load(store).size() == 50, "full list is atomic and does not evict saved servers");
        ServerListStore.remove(store, "https://large.example");
        ServerListStore.save(store, null, "New last", "https://new-last.example");
        check(ServerListStore.load(store).get(49).nickname.equals("New last"), "new rows append after removal");
        unchanged(store, original);
    }
    private static void seedLegacyCurrentOnlyOnce() throws Exception {
        Memory store = guarded();
        Map<String, String> original = new HashMap<>(store.values);
        ServerDirectory.Entry current = entry("HTTPS://Current.EXAMPLE:443/", "Current server");
        ServerListStore.seedLegacyCurrent(store, current);
        List<ServerListStore.Item> rows = ServerListStore.load(store);
        check(rows.size() == 1 && rows.get(0).address.equals("https://current.example"), "first upgrade may seed its public known origin");
        check(rows.get(0).nickname.isEmpty() && rows.get(0).metadata.name.equals("Current server"), "initial seed adds no guessed nickname");
        String seeded = store.values.get(KEY);
        int writes = store.writes.size();
        ServerListStore.seedLegacyCurrent(store, entry("https://different.example", "Must not replace"));
        check(seeded.equals(store.values.get(KEY)) && store.writes.size() == writes, "later initial contexts never replace an existing list");
        ServerListStore.remove(store, "https://current.example");
        writes = store.writes.size();
        ServerListStore.seedLegacyCurrent(store, current);
        check(ServerListStore.load(store).isEmpty() && store.writes.size() == writes, "deleting all bookmarks permanently defeats initial-origin reseeding");
        store.values.put(KEY, "not-json");
        ServerListStore.seedLegacyCurrent(store, current);
        check(store.values.get(KEY).equals("not-json") && ServerListStore.load(store).isEmpty(), "corrupt present list does not allow initial reseeding");
        unchanged(store, original);

        Memory history = guarded();
        history.values.put("serverHistory", new JSONArray().put(new JSONObject().put("address", "https://history.example").put("name", "Recorded history")).toString());
        Map<String, String> historyOriginal = new HashMap<>(history.values);
        ServerListStore.seedLegacyCurrent(history, entry("https://history.example", "Duplicate current"));
        check(ServerListStore.load(history).size() == 1 && ServerListStore.load(history).get(0).metadata.name.equals("Recorded history"), "normal history migration wins over duplicate current metadata");
        unchanged(history, historyOriginal);

        Memory otherHistory = guarded();
        otherHistory.values.put("serverHistory", historyOriginal.get("serverHistory"));
        ServerListStore.seedLegacyCurrent(otherHistory, current);
        check(ServerListStore.load(otherHistory).size() == 1 && ServerListStore.load(otherHistory).get(0).address.equals("https://history.example"), "a legitimate history list is not augmented with an unlisted current origin");
        unchanged(otherHistory, new HashMap<>(historyOriginal));

        Memory invalid = guarded();
        Map<String, String> invalidOriginal = new HashMap<>(invalid.values);
        ServerListStore.seedLegacyCurrent(invalid, entry("https://invalid.example/path", "Bad address"));
        check(ServerListStore.load(invalid).isEmpty() && invalid.values.get(KEY).equals("[]"), "invalid initial origin is ignored and normal empty migration retained");
        ServerListStore.seedLegacyCurrent(invalid, current);
        check(ServerListStore.load(invalid).isEmpty(), "failed or absent initial provenance does not defer hidden reseeding until later");
        unchanged(invalid, invalidOriginal);
    }
    private static JSONArray capacityRows(boolean customFirst) throws Exception {
        JSONArray rows = new JSONArray();
        for (int i = 0; i < 50; i++) rows.put(new JSONObject().put("address", "https://" + (customFirst && i == 0 ? "custom" : "provided") + i + ".example")
                .put("name", "Public metadata " + i).put("nickname", "Name " + i));
        return rows;
    }
    private static void reclaimOnlyRedundantProvidedBookmark() throws Exception {
        Memory store = guarded();
        Map<String, String> original = new HashMap<>(store.values);
        store.values.put(KEY, capacityRows(false).toString());
        List<String> provided = new ArrayList<>();
        for (int i = 0; i < 50; i++) provided.add("HTTPS://PROVIDED" + i + ".EXAMPLE:443/");
        String before = store.values.get(KEY);
        for (String badAddress : new String[]{"https://invalid.example/path", "file:///tmp/server"}) {
            try { ServerListStore.saveCustom(store, null, "", badAddress, provided); throw new AssertionError("invalid custom accepted"); }
            catch (IllegalArgumentException expected) { }
            check(before.equals(store.values.get(KEY)) && store.writes.isEmpty(), "invalid custom address neither prunes nor writes");
        }
        try { ServerListStore.saveCustom(store, null, "Bad\nName", "https://new-custom.example", provided); throw new AssertionError("bad nickname accepted"); }
        catch (IllegalArgumentException expected) { }
        check(before.equals(store.values.get(KEY)) && store.writes.isEmpty(), "invalid nickname neither prunes nor writes");
        try { ServerListStore.saveCustom(store, null, "Duplicate", "https://provided0.example", provided); throw new AssertionError("duplicate custom accepted"); }
        catch (ServerListStore.Duplicate expected) { }
        check(before.equals(store.values.get(KEY)) && store.writes.isEmpty(), "duplicate add neither prunes nor writes");
        ServerListStore.saveCustom(store, null, "My custom", entry("https://new-custom.example", "New reported name"), provided);
        List<ServerListStore.Item> rows = ServerListStore.load(store);
        check(rows.size() == 50 && rows.get(49).address.equals("https://new-custom.example"), "fifty provided bookmarks permit a custom row without exceeding cap");
        check(rows.get(0).address.equals("https://provided1.example") && store.writes.size() == 1, "only one redundant row removed and one atomic public-key write");
        for (int i = 1; i < 50; i++) check(rows.get(i - 1).address.equals("https://provided" + i + ".example"), "all other origins survive in order");
        before = store.values.get(KEY); int writes = store.writes.size();
        try { ServerListStore.saveCustom(store, "https://new-custom.example", "Collision", "https://provided1.example", provided); throw new AssertionError("edit collision accepted"); }
        catch (ServerListStore.Duplicate expected) { }
        check(before.equals(store.values.get(KEY)) && writes == store.writes.size(), "edit collision is atomic even with provided duplicate capacity");
        ServerListStore.saveCustom(store, "https://new-custom.example", "Renamed", "https://edited-custom.example", provided);
        check(ServerListStore.load(store).get(49).address.equals("https://edited-custom.example") && store.writes.size() == writes + 1, "normal full-list edit does not prune and retains index");
        unchanged(store, original);

        Memory mixed = guarded(); Map<String, String> mixedOriginal = new HashMap<>(mixed.values);
        mixed.values.put(KEY, capacityRows(true).toString());
        ServerListStore.saveCustom(mixed, null, "New", "https://new.example", Arrays.asList("HTTPS://PROVIDED1.EXAMPLE:443/"));
        rows = ServerListStore.load(mixed);
        check(rows.size() == 50 && rows.get(0).address.equals("https://custom0.example") && rows.get(0).nickname.equals("Name 0"), "unpinned custom row is never pruned");
        check(rows.get(1).address.equals("https://provided2.example") && mixed.writes.size() == 1, "trusted provided alias is the only reclaimed row");
        before = mixed.values.get(KEY); writes = mixed.writes.size();
        try { ServerListStore.saveCustom(mixed, null, "", "https://full.example", Arrays.asList("https://not-saved.example", "invalid")); throw new AssertionError("full list without matching provided row accepted"); }
        catch (ServerListStore.Full expected) { }
        check(before.equals(mixed.values.get(KEY)) && writes == mixed.writes.size(), "no redundant provided bookmark means ordinary Full with no writes");
        unchanged(mixed, mixedOriginal);

        Memory legacy = guarded(); Map<String, String> legacyOriginal = new HashMap<>(legacy.values);
        legacy.values.put("serverHistory", capacityRows(false).toString());
        try { ServerListStore.saveCustom(legacy, null, "bad\nname", "https://valid.example", provided); throw new AssertionError("bad legacy custom accepted"); }
        catch (IllegalArgumentException expected) { }
        check(!legacy.values.containsKey(KEY) && legacy.writes.isEmpty(), "invalid SaveCustom does not even publish a partial migration");
        ServerListStore.saveCustom(legacy, null, "", "https://new-legacy.example", provided);
        check(ServerListStore.load(legacy).size() == 50 && legacy.writes.size() == 1, "history migration plus capacity reclamation publishes a single final snapshot");
        unchanged(legacy, legacyOriginal);
    }
    private static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
}
