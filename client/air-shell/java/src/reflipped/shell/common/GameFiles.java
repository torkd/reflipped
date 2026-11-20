package reflipped.shell.common;

import android.app.Activity;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import reflipped.shell.pinball.ArchiveExtractor;
import reflipped.shell.pinball.LayerRecord;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The game files the game downloaded (about 9 GB), and whether they can stay when the player moves to another server
 * (SH-13 step 5). Every Reflipped server lists the same base files ({@code /shell/config} {@code assets.base}); what
 * differs are the layers each server puts on top, extracted over the same files: its schedule layer (the date-bearing
 * and balance masters), translation overlays and mods. The game re-reads layers only when its recorded asset version
 * ({@code info.json}) differs from the server's, and that version is each server's own counter, so two servers can
 * name the same one. The files stay when nothing of the old server's can be left behind: the same base, no overlays or
 * mods on the old server, and a schedule layer on the new one whenever the old one had one (it rewrites the same
 * masters). Then {@link #relayer} resets the recorded version, so the game asks the new server for its layers, and
 * points it at the new server's CDN.
 *
 * SH-27: when the old server's layers would stay behind, the files can still stay if a server can put back what those
 * layers changed: the app records every path a layer archive wrote or deleted ({@link LayerRecord}), and
 * {@link #restore} asks the new server (for Local play, the online server it came from) for the base copies of exactly
 * those paths ({@code POST /shell/restore}, offered for the languages in its {@code assets.restore}). SH-29: files
 * whose record keeps the originals ({@link LayerRecord#keepsOriginals}) need no server: {@link #restoreLocally} puts
 * them back from the phone. Otherwise (other
 * base files, no record, no server that can restore, or a failed restore) the game deletes everything and downloads it
 * again, as before.
 */
public final class GameFiles {
    /** A version no server announces, so the game's next asset check takes the new server's layers. */
    static final String RELAYER_VERSION = "2.1.0";
    private static final Pattern BASE_PATH = Pattern.compile("/(en|ko|th)/entities/files/?$");

    private GameFiles() {}

    /** {@code <data>/<app id>/Local Store/asset_download/production---latest}, where the game keeps its files. */
    static File root(Activity activity) {
        String packageName = activity.getPackageName();
        String appId = packageName.startsWith("air.") ? packageName.substring(4) : packageName;
        return new File(activity.getApplicationInfo().dataDir,
                appId + "/Local Store/asset_download/production---latest");
    }

    /** The game's own record of its files, or null when there are none. */
    static JSONObject info(Activity activity) {
        File file = new File(root(activity), "info.json");
        if (!file.isFile() || file.length() > (1 << 20)) return null;
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
            return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception unreadable) {
            return null;
        }
    }

    /** Whether the game has downloaded its files (a full download recorded in info.json). */
    public static boolean present(Activity activity) {
        JSONObject info = info(activity);
        return info != null && !info.optString("version").isEmpty() && info.optLong("totalSize", 0) > 0;
    }

    /**
     * Whether files with the layers of a server reporting {@code from} can serve one reporting {@code to} (each the
     * {@code assets} object of {@code /shell/config}; null for a server from before it existed).
     */
    static boolean reusable(JSONObject from, JSONObject to) {
        if (from == null || to == null) return false;
        String base = from.optString("base");
        if (base.isEmpty() || !base.equals(to.optString("base"))) return false;
        if (from.optBoolean("layers", true)) return false; // overlays or mods would stay behind
        return to.optBoolean("schedule", false) || !from.optBoolean("schedule", true);
    }

    /**
     * SH-29: the base game files on the phone, for Local play's data pack ({@link reflipped.shell.service.DataPackBuilder}):
     * each path from the extraction folder, or its kept original where a layer changed it.
     */
    static reflipped.shell.service.DataPackBuilder.Files baseFiles(Activity activity) {
        File root = root(activity);
        File dir = downloadDir(activity);
        java.util.Set<String> changed = LayerRecord.read(root);
        return member -> LayerRecord.baseFile(root, dir, changed, member);
    }

    /** Where the game extracts its archives: {@code production---latest/download} (AssetDownloader's downloadDir). */
    public static File downloadDir(Activity activity) {
        return new File(root(activity), "download");
    }

    /**
     * SH-25: records the base files a game data pack installed as the game records a full download (its
     * startSaveVersionInfo: version, assetRecoveryInfo, totalSize, assetSizeKind "fulfill", baseUrl,
     * latestModifiedTimeOfArchive), with the version no server announces, so the game's next asset check asks the
     * server only for its layers. The download's leftover resume files go, as the game deletes them after a download.
     */
    public static void installedFromPack(Activity activity, String lang, long totalSize, String cdn) throws Exception {
        File dir = root(activity);
        new File(dir, "partial_downloaded.platform").delete();
        new File(downloadDir(activity), "partial_downloaded.platform").delete();
        JSONObject info = new JSONObject()
                .put("version", RELAYER_VERSION)
                .put("assetRecoveryInfo", new org.json.JSONArray())
                .put("totalSize", totalSize)
                .put("assetSizeKind", "fulfill")
                .put("baseUrl", (cdn == null ? "" : cdn.replaceAll("/+$", "")) + "/" + lang + "/entities/files/")
                .put("latestModifiedTimeOfArchive", "");
        write(new File(dir, "info.json"), info);
        LayerRecord.start(dir); // base files only: the server's layers are recorded as they come
        Log.i(StubContext.TAG, "game data pack installed (" + lang + ", " + totalSize + " bytes): the server's layers come at the next check");
    }

    private static void write(File file, JSONObject info) throws java.io.IOException {
        file.getParentFile().mkdirs();
        File temp = new File(file.getParentFile(), "info.json.tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(info.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!temp.renameTo(file)) throw new java.io.IOException("can't replace " + file);
    }

    /**
     * Keeps the files for another server: the game's next asset check asks it for its layers, and later downloads go
     * to `cdn`. False when there is nothing to change or the record can't be written (then the files are replaced).
     */
    static boolean relayer(Activity activity, String cdn) {
        File file = new File(root(activity), "info.json");
        JSONObject info = info(activity);
        if (info == null) return false;
        try {
            info.put("version", RELAYER_VERSION);
            String baseUrl = info.optString("baseUrl");
            Matcher path = BASE_PATH.matcher(baseUrl);
            if (path.find() && cdn != null && !cdn.isEmpty())
                info.put("baseUrl", cdn.replaceAll("/+$", "") + path.group());
            write(file, info);
            Log.i(StubContext.TAG, "keeping the game files for the new server: its layers come at the next check");
            return true;
        } catch (Exception e) {
            Log.w(StubContext.TAG, "can't keep the game files (" + e + "): they will be downloaded again");
            return false;
        }
    }

    /**
     * SH-29: whether files with the layers of a server reporting {@code from} can be brought back to the base files on
     * the phone itself for a server reporting {@code to}: the same base, and a record that kept the originals.
     */
    static boolean canRestoreLocally(Activity activity, JSONObject from, JSONObject to) {
        if (from == null || to == null) return false;
        String base = from.optString("base");
        return !base.isEmpty() && base.equals(to.optString("base")) && LayerRecord.keepsOriginals(root(activity));
    }

    /** SH-29: undoes every layer from the kept originals. False when it failed (the caller has the files replaced). */
    static boolean restoreLocally(Activity activity) {
        try {
            int paths = LayerRecord.read(root(activity)).size();
            if (!LayerRecord.restoreOriginals(root(activity), downloadDir(activity))) return false;
            Log.i(StubContext.TAG, "put back the originals of " + paths + " layer files from this phone");
            return true;
        } catch (Exception failure) {
            Log.w(StubContext.TAG, "putting back the original game files failed (" + failure + ")");
            return false;
        }
    }

    /** The language folder of the files ({@code en}, {@code ko}, {@code th}, from info.json's baseUrl), or null. */
    static String lang(Activity activity) {
        JSONObject info = info(activity);
        if (info == null) return null;
        Matcher path = BASE_PATH.matcher(info.optString("baseUrl"));
        return path.find() ? path.group(1) : null;
    }

    /**
     * SH-27: the server to ask for the base copies when files with the layers of a server reporting {@code from} move to
     * {@code server} (reporting {@code to}), or null when they can't be restored: other base files, no complete record
     * of the layers, or no server that offers the files' language. For the server on this phone, which has no CDN, the
     * online server Local play took its files from ({@code localSource}), if any.
     */
    static String restoreSource(Activity activity, String server, JSONObject from, JSONObject to) {
        if (from == null || to == null) return null;
        String base = from.optString("base");
        if (base.isEmpty() || !base.equals(to.optString("base"))) return null;
        String lang = lang(activity);
        if (lang == null || LayerRecord.read(root(activity)) == null) return null;
        if (reflipped.shell.service.LocalServer.isLocal(server)) {
            String source = ShellConfig.prefs(activity).getString("localSource", "");
            return source.isEmpty() || reflipped.shell.service.LocalServer.isLocal(source) ? null : source;
        }
        JSONArray langs = to.optJSONArray("restore");
        for (int i = 0; langs != null && i < langs.length(); i++) if (lang.equals(langs.optString(i))) return server;
        return null;
    }

    /**
     * Puts back the base copies of every path the recorded layers touched, from {@code source}'s
     * {@code POST /shell/restore}, and starts a new record. False when it failed: the files may be half restored, so the
     * caller has them downloaded again.
     */
    static boolean restore(Activity activity, String source, String base) {
        File dir = root(activity);
        Set<String> paths = LayerRecord.read(dir);
        String lang = lang(activity);
        if (paths == null || lang == null) return false;
        if (paths.isEmpty()) return true; // no layer ever came: nothing to put back
        HttpURLConnection connection = null;
        try {
            byte[] body = new JSONObject().put("lang", lang).put("base", base).put("paths", new JSONArray(paths))
                    .toString().getBytes(StandardCharsets.UTF_8);
            connection = (HttpURLConnection) new URL(source + "/shell/restore").openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(60000);
            connection.setInstanceFollowRedirects(false);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(body.length);
            connection.setRequestProperty("Content-Type", "application/json");
            ShellConfig.identifyApp(activity, connection);
            try (java.io.OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }
            int status = connection.getResponseCode();
            if (status != 200) {
                Log.w(StubContext.TAG, "restoring the game files failed: HTTP " + status + " from " + source);
                return false;
            }
            try (InputStream in = connection.getInputStream()) {
                ArchiveExtractor extractor = new ArchiveExtractor(downloadDir(activity));
                if (!extractor.extract(in, null)) return false;
            }
            LayerRecord.start(dir);
            Log.i(StubContext.TAG, "restored the base copies of " + paths.size() + " layer files from " + source);
            return true;
        } catch (Exception failure) {
            Log.w(StubContext.TAG, "restoring the game files failed (" + failure + ")");
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
