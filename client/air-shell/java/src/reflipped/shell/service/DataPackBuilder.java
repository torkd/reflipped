package reflipped.shell.service;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * SH-29: builds the server data pack (src/lib/dataPack.ts) on the phone, from the game files installed there, so Local
 * play needs nothing game-derived from a server. The server bundle in the APK carries {@value #SOURCE_DIR}
 * (scripts/bundle.mjs --no-assets): {@code source.json}, the list of files the pack takes from the game's files with
 * their CDN member names (src/datapack/source.ts), and {@code assets/}, the converted game data. This writes the pack
 * folder `npm run datapack` would write from the same CDN: the listed files at their pack paths, the converted data,
 * and {@code manifest.json}. It doesn't judge the result: the caller checks the pins (assetsDigest, SEC-19's
 * mastersDigest) as for any pack, so game files changed by a server's layers or of another language are refused there.
 * Plain Java (org.json aside): the desktop test runs it.
 */
public final class DataPackBuilder {
    /** The folder of the server bundle that holds what the pack is built from. */
    public static final String SOURCE_DIR = "datapack-source/";
    static final String SOURCE = SOURCE_DIR + "source.json";
    static final String ASSETS = SOURCE_DIR + "assets/";
    private static final Pattern PACK_PATH = Pattern.compile("(master|assets|files)/[\\w./-]+");
    private static final Pattern MEMBER = Pattern.compile("production/upload/[0-9a-f]{2}/[0-9a-f]{38}");
    private static final int MAX_SOURCE = 1 << 20;
    private static final long MAX_FILE = 64L << 20;

    /** Finds the base game's copy of a CDN member name, or null when the game files hold none. */
    public interface Files {
        File find(String member);
    }

    /** Bytes written so far, of about {@code total} (-1 when unknown). */
    public interface Progress {
        void at(long done, long total);
    }

    /** The pack can't be built; the message is for the player. */
    public static final class Refused extends Exception {
        public Refused(String message) { super(message); }
    }

    /** What was built. */
    public static final class Built {
        public final JSONObject manifest;
        /** Optional files the game files lacked (left out, as `npm run datapack` leaves them out). */
        public final List<String> missingOptional;
        Built(JSONObject manifest, List<String> missingOptional) {
            this.manifest = manifest;
            this.missingOptional = missingOptional;
        }
    }

    private DataPackBuilder() {}

    /** Whether the server bundle (a zip read from {@code bundle}, closed here) carries what a pack is built from. */
    public static boolean available(InputStream bundle) throws IOException {
        try (ZipInputStream zip = new ZipInputStream(bundle)) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null; ) if (entry.getName().equals(SOURCE)) return true;
        }
        return false;
    }

    /**
     * Builds the pack into {@code out} (created empty first) from the server bundle read from {@code bundle} (closed
     * here) and the game files. On a refusal or an error {@code out} is left half written: the caller deletes it.
     */
    public static Built build(InputStream bundle, Files files, File out, Progress progress) throws Refused, IOException {
        if (out.exists()) throw new IOException(out + " already exists");
        if (!out.mkdirs()) throw new IOException("can't create " + out);
        String outPath = out.getCanonicalPath() + File.separator;
        List<JSONObject> entries = new ArrayList<>();
        byte[] sourceText = null;
        long done = 0;
        // the converted game data first: it comes from the bundle, which is read once, front to back
        try (ZipInputStream zip = new ZipInputStream(bundle)) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null; ) {
                String name = entry.getName();
                if (name.equals(SOURCE)) {
                    sourceText = readAll(zip, MAX_SOURCE);
                } else if (name.startsWith(ASSETS) && !entry.isDirectory()) {
                    String path = "assets/" + name.substring(ASSETS.length());
                    entries.add(copy(zip, target(out, outPath, path), path));
                    done += entries.get(entries.size() - 1).optLong("size");
                    if (progress != null) progress.at(done, -1);
                }
            }
        }
        if (sourceText == null)
            throw new Refused("This version of the Reflipped app can't make the game data for Local play itself.");
        JSONObject source;
        JSONArray listed;
        try {
            source = new JSONObject(new String(sourceText, StandardCharsets.UTF_8));
            listed = source.getJSONArray("files");
        } catch (JSONException damaged) {
            throw new IOException("the server bundle's " + SOURCE + " can't be read: " + damaged.getMessage());
        }
        if (source.optInt("format") != 1 || source.optString("cdnVersion").isEmpty())
            throw new IOException("the server bundle's " + SOURCE + " is of an unknown format");
        List<String> missingOptional = new ArrayList<>();
        List<String> missingRequired = new ArrayList<>();
        for (int i = 0; i < listed.length(); i++) {
            JSONObject file = listed.optJSONObject(i);
            String path = file == null ? "" : file.optString("path");
            String member = file == null ? "" : file.optString("member");
            if (!path.matches("(master|files)/.*") || !MEMBER.matcher(member).matches())
                throw new IOException("the server bundle's " + SOURCE + " has a bad entry: " + file);
            File from = files.find(member);
            if (from == null || from.length() > MAX_FILE) {
                (file.optBoolean("required") ? missingRequired : missingOptional).add(path);
                continue;
            }
            try (InputStream in = new FileInputStream(from)) {
                entries.add(copy(in, target(out, outPath, path), path));
            }
            done += entries.get(entries.size() - 1).optLong("size");
            if (progress != null) progress.at(done, -1);
        }
        if (!missingRequired.isEmpty())
            throw new Refused("The game files on this phone are incomplete: " + missingRequired.size() + " of the"
                    + " data tables Local play needs are missing (" + missingRequired.get(0) + " first).");

        Collections.sort(entries, (a, b) -> a.optString("path").compareTo(b.optString("path")));
        JSONArray manifestFiles = new JSONArray();
        for (JSONObject entry : entries) manifestFiles.put(entry);
        JSONObject manifest = new JSONObject();
        try {
            manifest.put("format", 1)
                    .put("cdnVersion", source.getString("cdnVersion"))
                    .put("region", source.optString("region", "en"))
                    .put("assetsDigest", assetsDigest(manifestFiles))
                    .put("files", manifestFiles);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        try (OutputStream os = new FileOutputStream(new File(out, "manifest.json"))) {
            os.write((manifest.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        }
        return new Built(manifest, missingOptional);
    }

    /** As src/lib/dataPack.ts assetsDigest: SHA-256 over the sorted {@code path sha256\n} lines of the assets/ files. */
    public static String assetsDigest(JSONArray files) {
        return digestOf(files, "assets/");
    }

    /** As src/lib/dataPack.ts mastersDigest: the same over the master/ and (since FT-74) files/ files. */
    public static String mastersDigest(JSONArray files) {
        return digestOf(files, "master/", "files/");
    }

    private static String digestOf(JSONArray files, String... prefixes) {
        List<String> lines = new ArrayList<>();
        for (int i = 0; i < files.length(); i++) {
            JSONObject file = files.optJSONObject(i);
            String path = file == null ? "" : file.optString("path");
            for (String prefix : prefixes)
                if (path.startsWith(prefix)) lines.add(path + " " + file.optString("sha256") + "\n");
        }
        Collections.sort(lines);
        MessageDigest digest = sha256();
        for (String line : lines) digest.update(line.getBytes(StandardCharsets.UTF_8));
        return hex(digest.digest());
    }

    /** The file for pack path {@code path} in {@code out}, refusing a path the server wouldn't accept. */
    private static File target(File out, String outPath, String path) throws IOException {
        File file = new File(out, path);
        if (!PACK_PATH.matcher(path).matches() || path.contains("//") || path.endsWith("/")
                || ("/" + path + "/").contains("/./") || ("/" + path + "/").contains("/../")
                || !file.getCanonicalPath().startsWith(outPath))
            throw new IOException("bad data pack path: " + path);
        File parent = file.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("can't create " + parent);
        return file;
    }

    /** Copies {@code in} (left open) to {@code file}; returns its manifest entry (path, size, sha256). */
    private static JSONObject copy(InputStream in, File file, String path) throws IOException {
        MessageDigest digest = sha256();
        long size = 0;
        try (OutputStream out = new FileOutputStream(file)) {
            byte[] buffer = new byte[65536];
            for (int n; (n = in.read(buffer)) > 0; ) {
                size += n;
                if (size > MAX_FILE) throw new IOException(path + " is too big for a data pack file");
                out.write(buffer, 0, n);
                digest.update(buffer, 0, n);
            }
        }
        try {
            return new JSONObject().put("path", path).put("size", size).put("sha256", hex(digest.digest()));
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
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
}
