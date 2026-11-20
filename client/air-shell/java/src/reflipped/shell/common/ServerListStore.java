package reflipped.shell.common;

import android.app.Activity;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Saved public server bookmarks only. Removing one never changes origin credentials, saves or downloaded assets. */
public final class ServerListStore {
    private static final String KEY = "myServers.v1";
    private static final int MAX_STORAGE_CHARS = 512 * 1024;
    public static final int MAX_SERVERS = ServerListModel.MAX_SERVERS;
    public static final class Item {
        public final String address, nickname;
        public final ServerDirectory.Entry metadata;
        private Item(ServerListModel.Row<ServerDirectory.Entry> row) {
            address = row.address; nickname = row.nickname; metadata = row.metadata;
        }
    }
    public static final class Duplicate extends IllegalArgumentException {
        public final String address;
        private Duplicate(String address) { super("That server is already in My servers."); this.address = address; }
    }
    public static final class Full extends IllegalArgumentException {
        private Full() { super("My servers is full. You can still join without saving, or remove a saved server first (50 maximum)."); }
    }
    private ServerListStore() { }
    private static DeviceKeys.Store store(Activity activity) { return ShellConfig.keyStore(activity); }

    public static synchronized List<Item> load(Activity activity) { return load(store(activity)); }
    /** Upgrade only: call before load. Existing lists, including empty or corrupt ones, are never reseeded. */
    public static synchronized void seedLegacyCurrent(Activity activity, ServerDirectory.Entry initial) {
        seedLegacyCurrent(store(activity), initial);
    }
    public static synchronized Item save(Activity activity, String previousAddress, String nickname, ServerDirectory.Entry metadata) {
        return save(store(activity), previousAddress, nickname, metadata);
    }
    /** Offline Add/Edit: validity does not depend on the server being reachable. */
    public static synchronized Item save(Activity activity, String previousAddress, String nickname, String address) {
        return save(store(activity), previousAddress, nickname, address);
    }
    /** UI-supplied provided origins are trusted catalogue identities, never arbitrary remote configuration. */
    public static synchronized Item saveCustom(Activity activity, String previousAddress, String nickname, ServerDirectory.Entry metadata, Iterable<String> provided) {
        return saveCustom(store(activity), previousAddress, nickname, metadata, provided);
    }
    public static synchronized Item saveCustom(Activity activity, String previousAddress, String nickname, String address, Iterable<String> provided) {
        return saveCustom(store(activity), previousAddress, nickname, address, provided);
    }
    public static synchronized boolean remove(Activity activity, String address) { return remove(store(activity), address); }
    /** Only call after an explicit Join/Save. Background probes must remain in memory. */
    public static synchronized void updateMetadata(Activity activity, ServerDirectory.Entry metadata) { updateMetadata(store(activity), metadata); }

    // Store overloads keep the codec/migration independently testable without Android preferences.
    public static synchronized List<Item> load(DeviceKeys.Store store) {
        List<Item> result = new ArrayList<>();
        for (ServerListModel.Row<ServerDirectory.Entry> row : read(store).rows()) result.add(new Item(row));
        return result;
    }
    public static synchronized void seedLegacyCurrent(DeviceKeys.Store store, ServerDirectory.Entry initial) {
        if (store.get(KEY) != null) return;
        ServerListModel<ServerDirectory.Entry> model = read(store); // normal one-time public history migration
        if (!model.rows().isEmpty()) return;
        final ServerDirectory.Entry clean;
        try { clean = sanitize(initial); }
        catch (IllegalArgumentException invalidInitial) { return; }
        model.save(null, "", clean.address, clean);
        write(store, model);
    }
    public static synchronized Item save(DeviceKeys.Store store, String previousAddress, String nickname, ServerDirectory.Entry metadata) {
        ServerListModel<ServerDirectory.Entry> model = read(store);
        ServerDirectory.Entry clean = sanitize(metadata);
        try {
            ServerListModel.Row<ServerDirectory.Entry> row = model.save(previousAddress, nickname, clean.address, clean);
            write(store, model);
            return new Item(row);
        } catch (ServerListModel.Duplicate duplicate) { throw new Duplicate(duplicate.address); }
        catch (ServerListModel.Full full) { throw new Full(); }
    }
    public static synchronized Item save(DeviceKeys.Store store, String previousAddress, String nickname, String address) {
        String canonical = ServerListModel.canonical(address);
        ServerDirectory.Entry metadata = null;
        for (ServerListModel.Row<ServerDirectory.Entry> row : read(store).rows())
            if (row.address.equals(canonical)) metadata = row.metadata;
        if (metadata == null) metadata = new ServerDirectory.Entry("Server", canonical, "", "", "", "online", Progression.of("", 1));
        return save(store, previousAddress, nickname, metadata);
    }
    public static synchronized Item saveCustom(DeviceKeys.Store store, String previousAddress, String nickname, ServerDirectory.Entry metadata, Iterable<String> provided) {
        ServerDirectory.Entry clean = sanitize(metadata);
        ServerListModel<ServerDirectory.Entry> model = read(store, false);
        try {
            ServerListModel.Row<ServerDirectory.Entry> row = model.saveCustom(previousAddress, nickname, clean.address, clean, provided);
            write(store, model);
            return new Item(row);
        } catch (ServerListModel.Duplicate duplicate) { throw new Duplicate(duplicate.address); }
        catch (ServerListModel.Full full) { throw new Full(); }
    }
    public static synchronized Item saveCustom(DeviceKeys.Store store, String previousAddress, String nickname, String address, Iterable<String> provided) {
        String canonical = ServerListModel.canonical(address);
        ServerDirectory.Entry metadata = null;
        for (ServerListModel.Row<ServerDirectory.Entry> row : read(store, false).rows())
            if (row.address.equals(canonical)) metadata = row.metadata;
        if (metadata == null) metadata = new ServerDirectory.Entry("Server", canonical, "", "", "", "online", Progression.of("", 1));
        return saveCustom(store, previousAddress, nickname, metadata, provided);
    }
    public static synchronized boolean remove(DeviceKeys.Store store, String address) {
        ServerListModel<ServerDirectory.Entry> model = read(store);
        boolean removed = model.remove(address);
        if (removed) write(store, model);
        return removed;
    }
    public static synchronized void updateMetadata(DeviceKeys.Store store, ServerDirectory.Entry metadata) {
        ServerListModel<ServerDirectory.Entry> model = read(store);
        ServerDirectory.Entry clean = sanitize(metadata);
        if (model.updateMetadata(clean.address, clean)) write(store, model);
    }
    private static ServerListModel<ServerDirectory.Entry> read(DeviceKeys.Store store) { return read(store, true); }
    private static ServerListModel<ServerDirectory.Entry> read(DeviceKeys.Store store, boolean persistMigration) {
        String current = store.get(KEY);
        // Presence of the new key, even an empty/corrupt list, prevents deleted legacy bookmarks resurrecting.
        boolean migrate = current == null;
        String text = migrate ? store.get("serverHistory") : current;
        List<ServerListModel.Row<ServerDirectory.Entry>> rows = new ArrayList<>();
        if (text != null && text.length() <= MAX_STORAGE_CHARS) {
            try {
                JSONArray entries = new JSONArray(text);
                for (int i = 0; i < Math.min(entries.length(), ServerListModel.MAX_SERVERS); i++) {
                    try {
                        JSONObject object = entries.getJSONObject(i);
                        JSONObject p = object.optJSONObject("progression");
                        Progression progression = p == null ? Progression.of("", 1)
                                : Progression.of(p.optString("mode", ""), p.optDouble("acceleration", Double.NaN));
                        ServerDirectory.Entry entry = sanitize(new ServerDirectory.Entry(object.optString("name", "Reflipped"),
                                object.optString("address", ""), object.optString("description", ""), object.optString("type", ""),
                                object.optString("thumbnail", ""), "online", progression));
                        // Old history never contained custom nicknames. Never reinterpret an unknown field as one.
                        rows.add(new ServerListModel.Row<>(entry.address, migrate ? "" : object.optString("nickname", ""), entry));
                    } catch (Exception invalidRow) { /* A malformed public row does not discard other saved servers. */ }
                }
            } catch (Exception invalidList) { /* Keep an invalid list empty; never fall back to old history. */ }
        }
        ServerListModel<ServerDirectory.Entry> model = new ServerListModel<>(rows);
        if (migrate && persistMigration) write(store, model);
        return model;
    }
    private static ServerDirectory.Entry sanitize(ServerDirectory.Entry entry) {
        if (entry == null) throw new IllegalArgumentException("Missing server information.");
        String address = ServerListModel.canonical(entry.address);
        String name = text(entry.name, 64);
        return new ServerDirectory.Entry(name.isEmpty() ? "Reflipped" : name, address, text(entry.description, 500),
                text(entry.type, 40), ThumbnailPolicy.validate(entry.thumbnail), "online",
                entry.progression == null ? Progression.of("", 1) : Progression.of(entry.progression.mode, entry.progression.acceleration));
    }
    private static String text(String value, int max) { return ServerListModel.publicText(value, max); }
    private static void write(DeviceKeys.Store store, ServerListModel<ServerDirectory.Entry> model) {
        try {
            JSONArray array = new JSONArray();
            for (ServerListModel.Row<ServerDirectory.Entry> row : model.rows()) {
                ServerDirectory.Entry entry = row.metadata;
                array.put(new JSONObject().put("address", row.address).put("nickname", row.nickname).put("name", entry.name)
                        .put("description", entry.description).put("type", entry.type).put("thumbnail", entry.thumbnail)
                        .put("mode", "online").put("progression", new JSONObject().put("mode", entry.progression.mode)
                                .put("acceleration", entry.progression.acceleration)));
            }
            String encoded = array.toString();
            if (encoded.length() > MAX_STORAGE_CHARS) throw new IllegalArgumentException("Saved server information is too large.");
            store.put(KEY, encoded);
        } catch (Exception invalid) { throw new IllegalArgumentException("Could not save the server list.", invalid); }
    }
}
