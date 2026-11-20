package reflipped.shell.common;

import android.app.Activity;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/** The bundled community catalogue (`servers.json`). Suggestions only: an entry never grants account privileges. */
public final class ServerDirectory {
    public static final class Entry {
        public final String name, address, description, type, thumbnail, mode;
        public final Progression progression;

        Entry(String name, String address, String description, String type, String thumbnail, String mode,
                Progression progression) {
            this.name = name;
            this.address = address;
            this.description = description;
            this.type = type;
            this.thumbnail = ThumbnailPolicy.validateFor(address, thumbnail);
            this.mode = "local".equals(mode) ? "local" : "online";
            this.progression = progression;
        }

        /**
         * True for the stand-in the app saves for an address it hasn't heard from yet (offline Add/Edit, an upgraded
         * install's current server), as opposed to what a server reported. The names are the stand-ins' own,
         * including ones stored by earlier builds.
         */
        public boolean placeholder() {
            return ("Server".equals(name) || "Saved server".equals(name) || "Selected server".equals(name))
                    && description.isEmpty() && type.isEmpty() && thumbnail.isEmpty() && progression.mode.isEmpty();
        }
    }

    private ServerDirectory() {}

    private static List<Entry> parse(String text) {
        List<Entry> result = new ArrayList<>();
        try {
            JSONArray rows = new JSONArray(text);
            for (int i = 0; i < Math.min(rows.length(), 50); i++) {
                JSONObject row = rows.getJSONObject(i);
                String address = ServerIdentity.connectionAddress(row.optString("address"));
                String name = row.optString("name").trim();
                String description = row.optString("description").trim();
                if (address != null && !name.isEmpty() && name.length() <= 64 && description.length() <= 500)
                    result.add(new Entry(name, address, description, limited(row.optString("type", ""), 40),
                            row.optString("thumbnail", ""), row.optString("mode", "online"), progression(row)));
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    private static String limited(String value, int max) {
        value = value.replaceAll("[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]", " ").trim();
        if (value.length() > max) {
            int end = max;
            if (Character.isHighSurrogate(value.charAt(end - 1))) end--;
            value = value.substring(0, end);
        }
        return value;
    }

    public static Entry reported(String address, JSONObject config) {
        String name = limited(config.optString("name", "Reflipped"), 64);
        return new Entry(name.isEmpty() ? "Reflipped" : name, address,
                limited(config.optString("description", ""), 500), limited(config.optString("type", ""), 40),
                config.optString("thumbnail", ""), "online", progression(config));
    }

    private static Progression progression(JSONObject row) {
        JSONObject value = row.optJSONObject("progression");
        return value == null ? Progression.of("", 1)
                             : Progression.of(value.optString("mode", ""), value.optDouble("acceleration", Double.NaN));
    }

    public static List<Entry> community(Activity activity) {
        List<Entry> entries = new ArrayList<>();
        try (InputStream input = activity.getAssets().open("servers.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                bytes.write(buffer, 0, count);
                if (bytes.size() > 256 * 1024) throw new IllegalStateException("Catalogue too large");
            }
            entries.addAll(parse(bytes.toString("UTF-8")));
        } catch (Exception ignored) {
        }
        return OriginRows.updated(entries, null, entry -> entry.address);
    }
}
