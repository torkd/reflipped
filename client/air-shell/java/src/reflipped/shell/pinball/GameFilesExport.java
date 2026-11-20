package reflipped.shell.pinball;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;

/**
 * SH-29: writes the game data a phone holds as a game data pack of format 2 (see {@link GamePack}), so a player can
 * install it on another phone without a computer: the base files at their paths, then their list. The base files are
 * the extracted ones, except where a server layer changed a path: those come from the originals the
 * {@link LayerRecord} kept, and paths only a layer added are left out. So only files whose record keeps originals
 * (version 2: downloaded or installed with an app from SH-29 on) can be exported.
 *
 * <p>The list's digest is checked against the pinned one before the pack is finished; a phone with other files (a
 * damaged one, or files from another source) gets {@link GamePack.Refused} and the caller deletes the half-written
 * file. Plain Java (org.json aside), for the desktop test.
 */
public final class GameFilesExport {
    /** Told as the files are written: bytes so far, of the total. */
    public interface Progress {
        void written(long done, long total);
    }

    /** What would be exported: each pack path and the file its bytes come from, sorted by path. */
    public static final class Plan {
        public final String lang;
        public final TreeMap<String, File> files;
        public final long totalSize;
        Plan(String lang, TreeMap<String, File> files, long totalSize) {
            this.lang = lang; this.files = files; this.totalSize = totalSize;
        }
    }

    private GameFilesExport() {}

    /**
     * The files to export from {@code assetDir} (the game's {@code production---latest/download}) with the record in
     * {@code root}; refused when the record doesn't keep originals or the language can't be checked.
     */
    public static Plan plan(File root, File assetDir, String lang, boolean anyList) throws IOException {
        if (!anyList && !GamePack.filesPinned(lang))
            throw new GamePack.Refused("Game data in this language can't be exported yet.");
        if (!LayerRecord.keepsOriginals(root))
            throw new GamePack.Refused("These game files were downloaded by an older version of the app, so they can't"
                    + " be exported. Clear the cache on the title screen and download or install them again with this"
                    + " version, then export.");
        Set<String> changed = LayerRecord.read(root);
        TreeMap<String, File> files = new TreeMap<>();
        for (String path : LayerRecord.listFiles(assetDir)) {
            if (changed.contains(path) || path.equals("partial_downloaded.platform")) continue;
            files.put(path, new File(assetDir, path));
        }
        File originals = LayerRecord.originals(root);
        for (String path : LayerRecord.listFiles(originals)) files.put(path, new File(originals, path));
        long total = 0;
        for (File f : files.values()) total += f.length();
        return new Plan(lang, files, total);
    }

    /**
     * Writes the pack to {@code out} (not closed here). False when {@code cancel} stopped it; refused when the files
     * aren't the official ones.
     */
    public static boolean write(Plan plan, OutputStream out, Progress progress, ArchiveExtractor.Cancel cancel,
                                boolean anyList) throws IOException {
        JSONObject manifest = new JSONObject();
        try {
            manifest.put("format", 2).put("kind", GamePack.KIND_FILES).put("lang", plan.lang)
                    .put("files", plan.files.size()).put("totalSize", plan.totalSize).put("list", GamePack.FILE_LIST);
        } catch (org.json.JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        entry(out, GamePack.MANIFEST, manifest.toString().getBytes(StandardCharsets.UTF_8));
        List<String> lines = new ArrayList<>(plan.files.size());
        byte[] buffer = new byte[1 << 16];
        long done = 0;
        for (java.util.Map.Entry<String, File> e : plan.files.entrySet()) {
            if (cancel != null && cancel.cancelled()) return false;
            File file = e.getValue();
            long size = file.length();
            out.write(header(e.getKey(), size));
            MessageDigest digest = GamePack.newSha256();
            long left = size;
            try (InputStream in = new FileInputStream(file)) {
                while (left > 0) {
                    int n = in.read(buffer, 0, (int) Math.min(buffer.length, left));
                    if (n < 0) throw new IOException(e.getKey() + " changed while it was exported");
                    digest.update(buffer, 0, n);
                    out.write(buffer, 0, n);
                    left -= n;
                }
            }
            pad(out, size);
            lines.add(e.getKey() + "\t" + size + "\t" + GamePack.hex(digest.digest()) + "\n");
            done += size;
            if (progress != null) progress.written(done, plan.totalSize);
        }
        Collections.sort(lines);
        StringBuilder text = new StringBuilder();
        for (String line : lines) text.append(line);
        byte[] list = text.toString().getBytes(StandardCharsets.UTF_8);
        if (!anyList && !GamePack.hex(GamePack.newSha256().digest(list)).equals(GamePack.OFFICIAL_FILES.get(plan.lang)))
            throw new GamePack.Refused("The game files on this phone aren't exactly the official ones, so they can't be"
                    + " exported. Clear the cache on the title screen and download or install them again, then export.");
        entry(out, GamePack.FILE_LIST, list);
        out.write(new byte[1024]); // the tar's end
        out.flush();
        return true;
    }

    private static void entry(OutputStream out, String name, byte[] data) throws IOException {
        out.write(header(name, data.length));
        out.write(data);
        pad(out, data.length);
    }

    private static void pad(OutputStream out, long size) throws IOException {
        int rest = (int) (GamePack.padded(size) - size);
        if (rest > 0) out.write(new byte[rest]);
    }

    /** A ustar header for a regular file (names over 100 bytes go into the prefix field). */
    static byte[] header(String name, long size) throws IOException {
        byte[] h = new byte[512];
        byte[] bytes = name.getBytes(StandardCharsets.UTF_8);
        String prefix = "";
        String rest = name;
        if (bytes.length > 100) {
            int cut = name.lastIndexOf('/', Math.min(name.length() - 1, 155));
            while (cut > 0 && (name.substring(cut + 1).getBytes(StandardCharsets.UTF_8).length > 100
                    || name.substring(0, cut).getBytes(StandardCharsets.UTF_8).length > 155))
                cut = name.lastIndexOf('/', cut - 1);
            if (cut <= 0) throw new IOException("path too long for the pack: " + name);
            prefix = name.substring(0, cut);
            rest = name.substring(cut + 1);
        }
        put(h, 0, rest.getBytes(StandardCharsets.UTF_8));
        put(h, 100, "0000644\0".getBytes(StandardCharsets.US_ASCII));
        put(h, 108, "0000000\0".getBytes(StandardCharsets.US_ASCII));
        put(h, 116, "0000000\0".getBytes(StandardCharsets.US_ASCII));
        put(h, 124, String.format("%011o\0", size).getBytes(StandardCharsets.US_ASCII));
        put(h, 136, "00000000000\0".getBytes(StandardCharsets.US_ASCII));
        for (int i = 148; i < 156; i++) h[i] = ' ';
        h[156] = '0';
        put(h, 257, "ustar\0".getBytes(StandardCharsets.US_ASCII));
        put(h, 263, "00".getBytes(StandardCharsets.US_ASCII));
        put(h, 345, prefix.getBytes(StandardCharsets.UTF_8));
        int sum = 0;
        for (byte b : h) sum += b & 0xff;
        put(h, 148, String.format("%06o\0 ", sum).getBytes(StandardCharsets.US_ASCII));
        return h;
    }

    private static void put(byte[] h, int at, byte[] value) {
        System.arraycopy(value, 0, h, at, value.length);
    }
}
