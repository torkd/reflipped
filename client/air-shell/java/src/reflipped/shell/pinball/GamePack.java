package reflipped.shell.pinball;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * A game data pack (SH-25, `npm run gamepack`, docs/game-data-pack.md): the game's CDN archives in download order in
 * one uncompressed tar, which the app installs from a file instead of downloading the base files from a server. The
 * first entry is the manifest ({@value #MANIFEST}); each archive follows at its CDN path.
 *
 * <p>Checks: the manifest's archive list must be one of the official asset lists (its digest is pinned below, so a
 * pack can't swap in other files); each archive must come in the list's order with the listed size, and is read into
 * memory (the largest is about 21 MB) and checked against its SHA-256 before anything of it is extracted. Extraction is
 * the downloader's own ({@link ArchiveExtractor}), so the files end up as a download from the CDN leaves them. Plain
 * Java (org.json aside): the desktop test runs it.
 *
 * <p>SH-29, format 2 ({@value #KIND_FILES}): a pack exported from a phone ({@link GameFilesExport}) holds the extracted
 * base files at their paths, then the list of them ({@value #FILE_LIST}: sorted {@code path\tsize\tsha256 hex\n}
 * lines) as its last entry. Each file is written while it is hashed; at the end the list's digest must be the pinned
 * one ({@link #OFFICIAL_FILES}, {@code npm run gamefiles -- --digest}) and the files must be exactly the listed ones,
 * else everything written is deleted again.
 */
public final class GamePack {
    public static final String MANIFEST = "reflipped-gamepack.json";
    static final String KIND_ARCHIVES = "reflipped-game-data";
    static final String KIND_FILES = "reflipped-game-files";
    /** The last entry of a format 2 pack: every file with its size and SHA-256. */
    public static final String FILE_LIST = "reflipped-gamefiles.tsv";
    private static final int MAX_FILE_LIST = 64 << 20;
    /** The largest archive accepted in memory; the official ones stay under 25 MB. */
    static final int MAX_ARCHIVE = 64 << 20;
    private static final int MAX_MANIFEST = 4 << 20;

    /**
     * sha256 of the official full asset lists (assets/asset_lists/{lang}-android-full.json, one
     * "path\tsize\tsha256\n" line per archive): `npm run gamepack -- --digests`; test/gamePack.test.ts compares them.
     */
    static final Map<String, String> OFFICIAL;
    static {
        Map<String, String> lists = new HashMap<>();
        lists.put("en", "c715aaeb00994871657e536706f7a528ea435bb49ad0e947fb362b5509ca78a3");
        lists.put("ko", "7bf683eda8efdb599686fa977f57f8f2eb822af9500164a1198f5190059761b4");
        lists.put("th", "243f5203d81ddf2ddeb7e2732e1fcc81db2dae68e9c3cea57e786d0296e89a1d");
        OFFICIAL = Collections.unmodifiableMap(lists);
    }

    /**
     * SH-29: sha256 of the list of every base file a fresh install leaves (src/gamepack/baseFiles.ts, `npm run gamefiles
     * -- --digest`), per language; test/gameFiles.test.ts compares them. Korean and Thai aren't pinned yet (no copy of
     * their CDN to compute them from), so their exported packs are refused.
     */
    static final Map<String, String> OFFICIAL_FILES;
    static {
        Map<String, String> lists = new HashMap<>();
        lists.put("en", "84624185862d199fa91c41370486d254a5f9f11acd504ec10fe5f1a4d79c1a8d");
        OFFICIAL_FILES = Collections.unmodifiableMap(lists);
    }

    /** Whether an exported pack (format 2) of this language can be checked, so made and installed. */
    public static boolean filesPinned(String lang) {
        return OFFICIAL_FILES.containsKey(lang);
    }

    /** Why a file can't be installed, in words for the player. */
    public static final class Refused extends IOException {
        public Refused(String message) { super(message); }
    }

    public static final class Archive {
        public final String path;
        public final long size;
        public final String sha256;
        Archive(String path, long size, String sha256) { this.path = path; this.size = size; this.sha256 = sha256; }
    }

    public static final class Manifest {
        public final String lang;
        public final String version;
        public final long totalSize;
        public final List<Archive> archives;
        /** 1: CDN archives; 2 (SH-29): extracted files, {@link #files} of them. */
        public final int format;
        public final int files;
        Manifest(String lang, String version, long totalSize, List<Archive> archives) {
            this(lang, version, totalSize, archives, 1, 0);
        }
        Manifest(String lang, String version, long totalSize, List<Archive> archives, int format, int files) {
            this.lang = lang; this.version = version; this.totalSize = totalSize; this.archives = archives;
            this.format = format; this.files = files;
        }
    }

    /**
     * An official archive list as the app carries it (build.py writes {@code gamedata-lists/<lang>.tsv} from
     * assets/asset_lists: one "path\tsize\tsha256\n" line per archive, in download order), checked against the pinned
     * digest: a copy of the {@code .cdn} folder is installed from it (SH-29, {@link CdnCopy}).
     */
    public static Manifest officialList(String lang, InputStream tsv) throws IOException {
        return list(lang, tsv, false);
    }

    /** {@code anyList}: accept a list that isn't an official one (the desktop test's short lists only). */
    static Manifest list(String lang, InputStream tsv, boolean anyList) throws IOException {
        java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(tsv, StandardCharsets.UTF_8));
        List<Archive> archives = new ArrayList<>();
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
        long total = 0;
        for (String line; (line = reader.readLine()) != null; ) {
            if (line.isEmpty()) continue;
            String[] cells = line.split("\t");
            if (cells.length != 3) throw new Refused("The app's list of game files is damaged. Reinstall the app.");
            Archive archive = new Archive(cells[0], Long.parseLong(cells[1]), cells[2]);
            digest.update((line + "\n").getBytes(StandardCharsets.UTF_8));
            archives.add(archive);
            total += archive.size;
        }
        if (!anyList && !hex(digest.digest()).equals(OFFICIAL.get(lang)))
            throw new Refused("The app's list of game files is damaged. Reinstall the app.");
        return new Manifest(lang, "", total, Collections.unmodifiableList(archives));
    }

    /** Told after each archive: bytes of archives installed so far, of {@link Manifest#totalSize}. */
    public interface Progress {
        void installed(long done, long total);
    }

    private final InputStream in;
    private final boolean anyList;
    private final byte[] header = new byte[512];
    private Manifest manifest;

    /** Reads a pack from {@code in} (not closed here). */
    public GamePack(InputStream in) {
        this(in, false);
    }

    /** {@code anyList}: accept a list that isn't an official one (the desktop test's small packs only). */
    GamePack(InputStream in, boolean anyList) {
        this.in = in;
        this.anyList = anyList;
    }

    /** Reads and checks the manifest, the pack's first entry; call before {@link #install}. */
    public Manifest manifest() throws IOException {
        if (manifest != null) return manifest;
        Entry entry;
        try {
            entry = next();
        } catch (Refused tooShort) {
            throw new Refused("This file isn't a game data pack for the Reflipped app.");
        }
        if (entry == null || !MANIFEST.equals(entry.name) || entry.size > MAX_MANIFEST)
            throw new Refused("This file isn't a game data pack for the Reflipped app.");
        byte[] data = readEntry(entry);
        try {
            JSONObject json = new JSONObject(new String(data, StandardCharsets.UTF_8));
            if (json.optInt("format") == 2 && KIND_FILES.equals(json.optString("kind"))) {
                String lang = json.optString("lang");
                if (!anyList && !OFFICIAL_FILES.containsKey(lang))
                    throw new Refused("Game data packs exported from a phone can't be checked for this language yet."
                            + " Use a pack made with the Reflipped tools, or download the game data.");
                long total = json.getLong("totalSize");
                int files = json.getInt("files");
                if (total < 0 || files < 0) throw new Refused("This game data pack is damaged.");
                manifest = new Manifest(lang, json.optString("version"), total, Collections.<Archive>emptyList(), 2, files);
                return manifest;
            }
            if (json.optInt("format") != 1 || !KIND_ARCHIVES.equals(json.optString("kind")))
                throw new Refused("This game data pack is from a newer Reflipped version. Update the app and try again.");
            String lang = json.optString("lang");
            JSONArray list = json.getJSONArray("archives");
            List<Archive> archives = new ArrayList<>(list.length());
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long total = 0;
            for (int i = 0; i < list.length(); i++) {
                JSONObject a = list.getJSONObject(i);
                Archive archive = new Archive(a.getString("path"), a.getLong("size"), a.getString("sha256"));
                if (archive.size < 0 || archive.size > MAX_ARCHIVE) throw new Refused("This game data pack is damaged.");
                digest.update((archive.path + "\t" + archive.size + "\t" + archive.sha256 + "\n").getBytes(StandardCharsets.UTF_8));
                archives.add(archive);
                total += archive.size;
            }
            String listDigest = hex(digest.digest());
            if (!anyList && !listDigest.equals(OFFICIAL.get(lang)))
                throw new Refused("This file doesn't hold the official game data. Make the pack again with the Reflipped tools.");
            manifest = new Manifest(lang, json.optString("version"), total, Collections.unmodifiableList(archives));
            return manifest;
        } catch (Refused refused) {
            throw refused;
        } catch (Exception damaged) {
            throw new Refused("This game data pack is damaged.");
        }
    }

    /**
     * Installs every archive into {@code assetDir} (the game's {@code production---latest/download}), in order. False
     * when {@code cancel} stopped it; then the files are incomplete and the game shouldn't be pointed at them.
     */
    public boolean install(File assetDir, Progress progress, ArchiveExtractor.Cancel cancel) throws IOException {
        Manifest m = manifest();
        if (m.format == 2) return installFiles(m, assetDir, progress, cancel);
        assetDir.mkdirs();
        ArchiveExtractor extractor = new ArchiveExtractor(assetDir);
        long done = 0;
        for (Archive archive : m.archives) {
            if (cancel != null && cancel.cancelled()) return false;
            Entry entry = next();
            if (entry == null) throw new Refused("This game data pack is incomplete (it ends before " + archive.path + ").");
            if (!archive.path.equals(entry.name) || entry.size != archive.size)
                throw new Refused("This game data pack is damaged (" + entry.name + " is out of place).");
            byte[] data = readEntry(entry);
            if (!sha256(data).equals(archive.sha256))
                throw new Refused("This game data pack is damaged (" + archive.path + " doesn't match).");
            if (!extractor.extract(new ByteArrayInputStream(data), cancel)) return false;
            done += archive.size;
            if (progress != null) progress.installed(done, m.totalSize);
        }
        return true;
    }

    /**
     * Format 2: every file is written (and hashed) as it comes; the list at the end decides. Anything refused, stopped
     * or failing deletes what this install wrote, so unchecked files never stay.
     */
    private boolean installFiles(Manifest m, File assetDir, Progress progress, ArchiveExtractor.Cancel cancel)
            throws IOException {
        assetDir.mkdirs();
        String root = assetDir.getCanonicalPath() + File.separator;
        Map<String, String> got = new HashMap<>();
        List<File> written = new ArrayList<>();
        boolean ok = false;
        try {
            byte[] list = null;
            long done = 0;
            byte[] buffer = new byte[1 << 16];
            for (Entry entry; (entry = next()) != null; ) {
                if (cancel != null && cancel.cancelled()) return false;
                if (FILE_LIST.equals(entry.name)) {
                    if (entry.size > MAX_FILE_LIST) throw new Refused("This game data pack is damaged.");
                    list = new byte[(int) entry.size];
                    if (!readFully(list, false)) throw new Refused("This game data pack is incomplete.");
                    skip(padded(entry.size) - entry.size);
                    break;
                }
                String name = entry.name;
                if (name.isEmpty() || name.startsWith("/") || name.contains("\\") || got.containsKey(name)
                        || got.size() >= m.files || name.indexOf('\t') >= 0 || name.indexOf('\n') >= 0)
                    throw new Refused("This game data pack is damaged (" + name + " is out of place).");
                File out = new File(assetDir, name);
                if (!out.getCanonicalPath().startsWith(root))
                    throw new Refused("This game data pack is damaged (" + name + " is out of place).");
                out.getParentFile().mkdirs();
                MessageDigest digest = newSha256();
                written.add(out);
                try (java.io.OutputStream os = new java.io.FileOutputStream(out)) {
                    long left = entry.size;
                    while (left > 0) {
                        int n = in.read(buffer, 0, (int) Math.min(buffer.length, left));
                        if (n < 0) throw new Refused("This game data pack is incomplete (the file ends early).");
                        digest.update(buffer, 0, n);
                        os.write(buffer, 0, n);
                        left -= n;
                    }
                }
                skip(padded(entry.size) - entry.size);
                got.put(name, entry.size + "\t" + hex(digest.digest()));
                done += entry.size;
                if (progress != null) progress.installed(Math.min(done, m.totalSize), m.totalSize);
            }
            if (list == null) throw new Refused("This game data pack is incomplete (its list of files is missing).");
            if (!anyList && !hex(newSha256().digest(list)).equals(OFFICIAL_FILES.get(m.lang)))
                throw new Refused("This file doesn't hold the official game data: the phone it was exported from had"
                        + " other files.");
            int listed = 0;
            for (String line : new String(list, StandardCharsets.UTF_8).split("\n")) {
                if (line.isEmpty()) continue;
                int tab = line.indexOf('\t');
                if (tab < 0) throw new Refused("This game data pack is damaged.");
                String path = line.substring(0, tab);
                String expected = line.substring(tab + 1);
                if (!expected.equals(got.get(path)))
                    throw new Refused(got.containsKey(path) ? "This game data pack is damaged (" + path + " doesn't match)."
                            : "This game data pack is incomplete (" + path + " is missing).");
                listed++;
            }
            if (listed != got.size()) throw new Refused("This game data pack holds files that aren't game data.");
            ok = true;
            return true;
        } finally {
            if (!ok) for (File f : written) f.delete();
        }
    }

    static MessageDigest newSha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    // ------------------------------------------------------------------ tar

    private static final class Entry {
        final String name;
        final long size;
        Entry(String name, long size) { this.name = name; this.size = size; }
    }

    /** The next regular file entry, or null at the end; GNU long names and pax `path` records are followed. */
    private Entry next() throws IOException {
        String longName = null;
        while (true) {
            if (!readFully(header, true)) return null;
            if (allZero(header)) return null;
            long size = octal(header, 124, 12);
            char type = (char) header[156];
            if (type == 'L' || type == 'x') {
                if (size > 1 << 20) throw new Refused("This game data pack is damaged.");
                String text = new String(readEntry(new Entry("", size)), StandardCharsets.UTF_8);
                if (type == 'L') longName = text.replace("\0", "");
                else {
                    String path = paxPath(text);
                    if (path != null) longName = path;
                }
                continue;
            }
            if (type == 'g') {
                skip(padded(size));
                continue;
            }
            String name = longName != null ? longName : name();
            longName = null;
            if (type == '0' || type == '\0') return new Entry(name, size);
            skip(padded(size)); // directories, links: not in a pack the tool makes
        }
    }

    private String name() {
        return headerName(header);
    }

    /** A ustar header's path: its prefix field, then its name. */
    static String headerName(byte[] header) {
        String name = text(header, 0, 100);
        String magic = text(header, 257, 6);
        String prefix = magic.startsWith("ustar") ? text(header, 345, 155) : "";
        return prefix.isEmpty() ? name : prefix + "/" + name;
    }

    static String paxPath(String records) {
        for (String record : records.split("\n")) {
            int space = record.indexOf(' ');
            if (space < 0) continue;
            String field = record.substring(space + 1);
            if (field.startsWith("path=")) return field.substring(5);
        }
        return null;
    }

    private byte[] readEntry(Entry entry) throws IOException {
        if (entry.size > MAX_ARCHIVE) throw new Refused("This game data pack is damaged.");
        byte[] data = new byte[(int) entry.size];
        if (!readFully(data, false)) throw new Refused("This game data pack is incomplete.");
        skip(padded(entry.size) - entry.size);
        return data;
    }

    static long padded(long size) {
        return (size + 511) / 512 * 512;
    }

    /** Fills {@code buffer}; false at a clean end of the stream before the first byte when {@code endOk}. */
    private boolean readFully(byte[] buffer, boolean endOk) throws IOException {
        int off = 0;
        while (off < buffer.length) {
            int n = in.read(buffer, off, buffer.length - off);
            if (n < 0) {
                if (off == 0 && endOk) return false;
                throw new Refused("This game data pack is incomplete (the file ends early).");
            }
            off += n;
        }
        return true;
    }

    private void skip(long count) throws IOException {
        byte[] scratch = new byte[8192];
        while (count > 0) {
            int n = in.read(scratch, 0, (int) Math.min(scratch.length, count));
            if (n < 0) throw new Refused("This game data pack is incomplete (the file ends early).");
            count -= n;
        }
    }

    static boolean allZero(byte[] block) {
        for (byte b : block) if (b != 0) return false;
        return true;
    }

    static long octal(byte[] block, int off, int len) throws Refused {
        int i = off;
        while (i < off + len && block[i] == ' ') i++;
        long value = 0;
        for (; i < off + len; i++) {
            int c = block[i] & 0xff;
            if (c == 0 || c == ' ') break;
            if (c < '0' || c > '7') throw new Refused("This file isn't a game data pack for the Reflipped app.");
            value = value * 8 + (c - '0');
        }
        return value;
    }

    static String text(byte[] block, int off, int len) {
        int end = off;
        while (end < off + len && block[end] != 0) end++;
        return new String(block, off, end - off, StandardCharsets.UTF_8);
    }

    static String sha256(byte[] data) {
        try {
            return base64(MessageDigest.getInstance("SHA-256").digest(data));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static final char[] BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    /** Standard base64 with padding, as the asset lists write SHA-256s (java.util.Base64 needs Android 8). */
    static String base64(byte[] data) {
        StringBuilder out = new StringBuilder((data.length + 2) / 3 * 4);
        for (int i = 0; i < data.length; i += 3) {
            int b0 = data[i] & 0xff;
            int b1 = i + 1 < data.length ? data[i + 1] & 0xff : 0;
            int b2 = i + 2 < data.length ? data[i + 2] & 0xff : 0;
            out.append(BASE64[b0 >> 2]).append(BASE64[((b0 & 3) << 4) | (b1 >> 4)]);
            out.append(i + 1 < data.length ? BASE64[((b1 & 15) << 2) | (b2 >> 6)] : '=');
            out.append(i + 2 < data.length ? BASE64[b2 & 63] : '=');
        }
        return out.toString();
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format("%02x", b & 0xff));
        return out.toString();
    }
}
