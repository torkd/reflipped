package reflipped.shell.content;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Properties;

/**
 * What the import build takes from the player's game app, and how it patches the SWF: `manifest.properties` in the
 * APK's assets (folder {@link #ASSET_DIR}), written by build.py --content import. It holds only names, sizes and
 * SHA-256 hashes, and the name of the op list; no game content.
 */
public final class ImportManifest {
    public static final String ASSET_DIR = "reflipped-import";
    public static final String FILE = "manifest.properties";

    /** A file the app takes from the game's APK, with its size and SHA-256 as the game version 0.0.81 has it. */
    public static final class Entry {
        public final String name;
        public final long size;
        public final String sha256;

        Entry(String name, long size, String sha256) {
            this.name = name;
            this.size = size;
            this.sha256 = sha256;
        }

        /** The file name without the APK folder (assets/bundle.zip -> bundle.zip). */
        public String fileName() {
            return name.substring(name.lastIndexOf('/') + 1);
        }
    }

    public final String gamePackage;
    public final String gameVersion;
    public final List<Entry> entries;
    public final String swfEntry;
    public final String opsName;
    public final String opsSha256;
    public final long inputSize;
    public final String inputSha256;
    public final long outputSize;
    public final String outputSha256;

    private ImportManifest(Properties p) throws IOException {
        if (!"1".equals(p.getProperty("format"))) throw new IOException("unknown import manifest format");
        gamePackage = required(p, "game.package");
        gameVersion = required(p, "game.version");
        List<Entry> list = new ArrayList<>();
        for (int i = 0; p.getProperty("entry." + i + ".name") != null; i++) {
            list.add(new Entry(required(p, "entry." + i + ".name"), number(p, "entry." + i + ".size"),
                    hash(p, "entry." + i + ".sha256")));
        }
        if (list.isEmpty()) throw new IOException("import manifest lists no files");
        entries = Collections.unmodifiableList(list);
        swfEntry = required(p, "swf.entry");
        if (entry(swfEntry) == null) throw new IOException("import manifest doesn't list " + swfEntry);
        opsName = required(p, "swf.ops");
        opsSha256 = hash(p, "swf.ops.sha256");
        inputSize = number(p, "swf.input.size");
        inputSha256 = hash(p, "swf.input.sha256");
        outputSize = number(p, "swf.output.size");
        outputSha256 = hash(p, "swf.output.sha256");
    }

    public static ImportManifest read(InputStream input) throws IOException {
        Properties p = new Properties();
        p.load(input);
        return new ImportManifest(p);
    }

    public Entry entry(String name) {
        for (Entry e : entries) if (e.name.equals(name)) return e;
        return null;
    }

    /** Bytes of all the files taken from the game app. */
    public long importBytes() {
        long total = 0;
        for (Entry e : entries) total += e.size;
        return total;
    }

    private static String required(Properties p, String key) throws IOException {
        String value = p.getProperty(key);
        if (value == null || value.trim().isEmpty()) throw new IOException("import manifest lacks " + key);
        return value.trim();
    }

    private static long number(Properties p, String key) throws IOException {
        try {
            long value = Long.parseLong(required(p, key));
            if (value < 0) throw new NumberFormatException();
            return value;
        } catch (NumberFormatException e) {
            throw new IOException("import manifest: bad " + key);
        }
    }

    private static String hash(Properties p, String key) throws IOException {
        String value = required(p, key).toLowerCase(Locale.ROOT);
        if (!value.matches("[0-9a-f]{64}")) throw new IOException("import manifest: bad " + key);
        return value;
    }
}
