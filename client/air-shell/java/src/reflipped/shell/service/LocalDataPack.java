package reflipped.shell.service;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

/**
 * The server data pack on the phone (SH-13 step 5): the game-derived tables the server reads (src/lib/dataPack.ts),
 * kept in {@code <files>/server/datapack} and never in the APK. Local play setup gets it from an online Reflipped
 * server that offers it ({@code GET /shell/datapack}) or from a zip file the player picks. A pack fits when its
 * manifest's {@code assetsDigest} is the one this app's server bundle names ({@code datapack-assets-digest.txt}); an
 * app update with another server bundle may need another pack. The server checks every file again when it starts.
 */
public final class LocalDataPack {
    /** Progress of a download or an unpack: bytes so far, and the total (-1 when unknown). */
    public interface Progress { void at(long done, long total); }

    /** A pack that can't be used; the message is for the player. */
    public static final class Problem extends Exception {
        public Problem(String message) { super(message); }
    }

    private static final String DIGEST_ENTRY = "datapack-assets-digest.txt";
    /** SEC-19: the master tables' digest of the official pack, which the bundle names too. */
    private static final String MASTERS_ENTRY = "datapack-masters-digest.txt";
    private static volatile String expectedMasters;
    /** Far above the 6.6 MB zip and 40 MB unpacked of 2026 (CDN 2.1.125), far below what would fill a phone. */
    private static final long MAX_ZIP = 64L << 20, MAX_UNPACKED = 256L << 20;
    private static final int MAX_ENTRIES = 4000;
    private static volatile String expected;
    private static volatile boolean expectedRead;

    private LocalDataPack() {}

    static File dir(Context context) {
        return new File(ServerBundle.root(context), "datapack");
    }

    /**
     * The assetsDigest of the pack this app's server accepts, or null when it needs none (a build without the server,
     * or one built with --server-game-data, whose server carries its own tables).
     */
    public static String expectedDigest(Context context) {
        readExpected(context);
        return expected;
    }

    /** The digest of the master tables the bundle pins (SEC-19), or null when it pins none. */
    static String expectedMastersDigest(Context context) {
        readExpected(context);
        return expectedMasters;
    }

    private static synchronized void readExpected(Context context) {
        if (expectedRead) return;
        String assets = null, masters = null;
        try (ZipInputStream zip = new ZipInputStream(context.getAssets().open(ServerBundle.ASSET))) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null; ) {
                boolean isAssets = DIGEST_ENTRY.equals(entry.getName()), isMasters = MASTERS_ENTRY.equals(entry.getName());
                if (!isAssets && !isMasters) continue;
                String text = new String(readAll(zip, 1024), StandardCharsets.US_ASCII).trim();
                if (!text.matches("[0-9a-f]{64}")) continue;
                if (isAssets) assets = text;
                else masters = text;
            }
        } catch (IOException missing) {
            // no server in this build
        }
        expected = assets;
        expectedMasters = masters;
        expectedRead = true;
    }

    /** The installed pack's manifest, or null when there is none or it can't be read. */
    public static JSONObject installed(Context context) {
        File manifest = new File(dir(context), "manifest.json");
        if (!manifest.isFile() || manifest.length() > (16L << 20)) return null;
        try (InputStream in = new FileInputStream(manifest)) {
            return new JSONObject(new String(readAll(in, 16 << 20), StandardCharsets.UTF_8));
        } catch (Exception unreadable) {
            return null;
        }
    }

    /** Whether the installed pack is the one this app's server needs (or it needs none). */
    public static boolean ready(Context context) {
        String wanted = expectedDigest(context);
        if (wanted == null) return true;
        JSONObject manifest = installed(context);
        return manifest != null && wanted.equals(manifest.optString("assetsDigest"));
    }

    /**
     * Downloads and installs the pack `server` offers (an online Reflipped server's origin). Returns the pack's CDN
     * version. Call off the UI thread.
     */
    public static String download(Context context, String server, Progress progress) throws Problem, IOException {
        String wanted = expectedDigest(context);
        JSONObject descriptor;
        HttpURLConnection connection = open(server + "/shell/datapack");
        try {
            int status = connection.getResponseCode();
            if (status == 404) throw new Problem("This server doesn't offer the game data for Local play.");
            if (status != 200) throw new IOException("HTTP " + status);
            descriptor = new JSONObject(new String(readAll(connection.getInputStream(), 64 << 10), StandardCharsets.UTF_8));
        } catch (org.json.JSONException notJson) {
            throw new Problem("This server's answer about the game data couldn't be read.");
        } finally {
            connection.disconnect();
        }
        if (wanted != null && !wanted.equals(descriptor.optString("assetsDigest")))
            throw new Problem("This server's game data is for another version of the Reflipped app. Update the app,"
                    + " or ask the server's owner to offer the data for this version.");
        long size = descriptor.optLong("size", -1);
        String sha256 = descriptor.optString("sha256", "");
        String url = descriptor.optString("url", "");
        String base = server.replaceAll("/+$", "") + "/shell/datapack/";
        // only from the server the player chose, never sent elsewhere
        if (size <= 0 || size > MAX_ZIP || !sha256.matches("[0-9a-f]{64}") || !url.startsWith(base)
                || url.substring(base.length()).contains("/"))
            throw new Problem("This server's answer about the game data isn't usable.");
        File zip = new File(context.getCacheDir(), "datapack-download.zip");
        try {
            connection = open(url);
            try {
                if (connection.getResponseCode() != 200) throw new IOException("HTTP " + connection.getResponseCode());
                String got = copy(connection.getInputStream(), zip, size, progress);
                if (zip.length() != size || !got.equals(sha256))
                    throw new Problem("The game data didn't arrive whole. Try again.");
            } finally {
                connection.disconnect();
            }
            return install(context, zip, progress);
        } finally {
            if (!zip.delete() && zip.exists()) Log.w(ServerService.TAG, "can't delete " + zip);
        }
    }

    /** Installs a pack zip the player picked (read from `in`, which this closes). Call off the UI thread. */
    public static String installFile(Context context, InputStream in, Progress progress) throws Problem, IOException {
        File zip = new File(context.getCacheDir(), "datapack-picked.zip");
        try {
            try (InputStream source = in) {
                copy(source, zip, -1, progress);
            }
            return install(context, zip, progress);
        } finally {
            if (!zip.delete() && zip.exists()) Log.w(ServerService.TAG, "can't delete " + zip);
        }
    }

    /** Unpacks into a staging folder, checks the manifest and every file, then swaps it in. Returns the CDN version. */
    private static String install(Context context, File zip, Progress progress) throws Problem, IOException {
        File root = ServerBundle.root(context);
        File staging = new File(root, "datapack.new");
        deleteTree(staging);
        if (!staging.mkdirs()) throw new IOException("can't create " + staging);
        String stagingPath = staging.getCanonicalPath() + File.separator;
        long unpacked = 0;
        int entries = 0;
        try (ZipFile archive = new ZipFile(zip)) {
            long total = 0;
            for (Enumeration<? extends ZipEntry> e = archive.entries(); e.hasMoreElements(); ) total += Math.max(0, e.nextElement().getSize());
            for (Enumeration<? extends ZipEntry> e = archive.entries(); e.hasMoreElements(); ) {
                ZipEntry entry = e.nextElement();
                if (++entries > MAX_ENTRIES) throw new Problem("This file isn't the game data for Local play.");
                String name = entry.getName();
                File target = new File(staging, name);
                if (name.startsWith("/") || name.contains("\\") || !target.getCanonicalPath().startsWith(stagingPath))
                    throw new Problem("This file isn't the game data for Local play.");
                if (entry.isDirectory()) {
                    target.mkdirs();
                    continue;
                }
                target.getParentFile().mkdirs();
                try (InputStream in = archive.getInputStream(entry); OutputStream out = new FileOutputStream(target)) {
                    byte[] buffer = new byte[65536];
                    for (int n; (n = in.read(buffer)) > 0; ) {
                        unpacked += n;
                        if (unpacked > MAX_UNPACKED) throw new Problem("This file isn't the game data for Local play.");
                        out.write(buffer, 0, n);
                    }
                }
                if (progress != null) progress.at(unpacked, total);
            }
        } catch (java.util.zip.ZipException notZip) {
            deleteTree(staging);
            throw new Problem("This file isn't the game data for Local play.");
        } catch (Problem | IOException failed) {
            deleteTree(staging);
            throw failed;
        }
        String cdnVersion;
        try {
            cdnVersion = check(context, staging);
        } catch (Problem | IOException failed) {
            deleteTree(staging);
            throw failed;
        }
        File current = dir(context);
        File old = new File(root, "datapack.old");
        deleteTree(old);
        if (current.exists() && !current.renameTo(old)) throw new IOException("can't move the old game data aside");
        if (!staging.renameTo(current)) {
            old.renameTo(current);
            throw new IOException("can't put the new game data in place");
        }
        deleteTree(old);
        Log.i(ServerService.TAG, "installed the data pack for CDN " + cdnVersion + " (" + entries + " entries)");
        return cdnVersion;
    }

    /** The checks the server makes at start-up (src/lib/dataPack.ts), so a bad pack is refused here, not by Node. */
    private static String check(Context context, File pack) throws Problem, IOException {
        JSONObject manifest;
        try (InputStream in = new FileInputStream(new File(pack, "manifest.json"))) {
            manifest = new JSONObject(new String(readAll(in, 16 << 20), StandardCharsets.UTF_8));
        } catch (java.io.FileNotFoundException | org.json.JSONException notPack) {
            throw new Problem("This file isn't the game data for Local play.");
        }
        String wanted = expectedDigest(context);
        if (manifest.optInt("format") != 1 || manifest.optString("cdnVersion").isEmpty())
            throw new Problem("This file isn't the game data for Local play.");
        if (wanted != null && !wanted.equals(manifest.optString("assetsDigest")))
            throw new Problem("This game data is for another version of the Reflipped app.");
        JSONArray files = manifest.optJSONArray("files");
        if (files == null || files.length() == 0) throw new Problem("This file isn't the game data for Local play.");
        String pinned = expectedMastersDigest(context);
        if (pinned != null && !pinned.equals(mastersDigest(files)))
            throw new Problem("This game data isn't the official data for this version of the Reflipped app.");
        for (int i = 0; i < files.length(); i++) {
            JSONObject file = files.optJSONObject(i);
            File on = file == null ? null : new File(pack, file.optString("path"));
            if (on == null || !on.isFile() || on.length() != file.optLong("size", -1)
                    || !sha256(on).equals(file.optString("sha256")))
                throw new Problem("The game data is damaged. Get it again.");
        }
        return manifest.optString("cdnVersion");
    }

    /** As src/lib/dataPack.ts mastersDigest: SHA-256 over the sorted `path sha256\n` lines of the master/ and files/ files. */
    private static String mastersDigest(JSONArray files) {
        java.util.List<String> lines = new java.util.ArrayList<>();
        for (int i = 0; i < files.length(); i++) {
            JSONObject file = files.optJSONObject(i);
            String path = file == null ? "" : file.optString("path");
            // as src/lib/dataPack.ts mastersDigest: the master tables and, since FT-74, the battle scripts in files/
            if (path.startsWith("master/") || path.startsWith("files/"))
                lines.add(path + " " + file.optString("sha256") + "\n");
        }
        java.util.Collections.sort(lines);
        MessageDigest digest = sha256();
        for (String line : lines) digest.update(line.getBytes(StandardCharsets.UTF_8));
        return hex(digest.digest());
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(30000);
        connection.setInstanceFollowRedirects(false);
        return connection;
    }

    /** Copies to `file` (at most {@link #MAX_ZIP}), reporting progress; returns the SHA-256 of what was written. */
    private static String copy(InputStream in, File file, long total, Progress progress) throws Problem, IOException {
        MessageDigest digest = sha256();
        long done = 0;
        try (OutputStream out = new FileOutputStream(file)) {
            byte[] buffer = new byte[65536];
            for (int n; (n = in.read(buffer)) > 0; ) {
                done += n;
                if (done > MAX_ZIP) throw new Problem("This file is too big to be the game data for Local play.");
                out.write(buffer, 0, n);
                digest.update(buffer, 0, n);
                if (progress != null) progress.at(done, total);
            }
        }
        return hex(digest.digest());
    }

    private static String sha256(File file) throws IOException {
        MessageDigest digest = sha256();
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[65536];
            for (int n; (n = in.read(buffer)) > 0; ) digest.update(buffer, 0, n);
        }
        return hex(digest.digest());
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) text.append(String.format("%02x", b));
        return text.toString();
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int n; (n = in.read(buffer)) > 0; ) {
            if (out.size() + n > max) throw new IOException("too long");
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    static void deleteTree(File file) {
        File[] children = file.isDirectory() ? file.listFiles() : null;
        if (children != null) for (File child : children) deleteTree(child);
        if (file.exists() && !file.delete()) Log.w(ServerService.TAG, "can't delete " + file);
    }
}
