package reflipped.shell.pinball;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Extracts one of the game's asset archives into its asset dir, as the original downloader did: entries go to their
 * archive path (entry names like {@code production/upload/08/1563…}), a {@code .removed.csv} entry ({@code rowid,path})
 * lists files to delete, and writing {@code a/b/c} deletes its shortened twin {@code a/hash/b/c.hash} and vice versa.
 * Shared by {@link AssetDownloader} (archives from the CDN) and the game data pack installer (SH-25), so both leave the
 * same files. Plain Java: the downloader's desktop test compiles it without Android.
 */
public final class ArchiveExtractor {
    /** Asked between entries; true stops the extraction. */
    public interface Cancel {
        boolean cancelled();
    }

    private final File assetDir;
    private final String root;
    private final byte[] buffer = new byte[64 * 1024];
    /** Files the last archive's {@code .removed.csv} deleted. */
    public int removed;
    /** Told before a layer archive changes a path (SH-27, SH-29: {@link LayerRecord.Keeper}). */
    public interface Touch {
        /** Before {@code path} (its file {@code file}, inside the asset dir) is written over or deleted. */
        void before(String path, File file) throws IOException;
    }

    /** Asked before each write, shortened-twin deletion and {@code .removed.csv} deletion; null for base archives. */
    public Touch touch;

    public ArchiveExtractor(File assetDir) throws IOException {
        this.assetDir = assetDir;
        this.root = assetDir.getCanonicalPath() + File.separator;
    }

    /** Extracts the zip read from {@code body} (left open); false when {@code cancel} stopped it. */
    public boolean extract(InputStream body, Cancel cancel) throws IOException {
        removed = 0;
        ZipInputStream zip = new ZipInputStream(body);
        for (ZipEntry entry; (entry = zip.getNextEntry()) != null; ) {
            if (cancel != null && cancel.cancelled()) return false;
            String name = entry.getName();
            if (name.equals(".removed.csv")) {
                removeFiles(zip);
            } else if (entry.isDirectory()) {
                resolve(name).mkdirs();
            } else {
                File out = resolve(name);
                String twin = isShortened(name) ? shortenedToActual(name) : actualToShortened(name);
                File twinFile = twin == null ? null : resolve(twin);
                if (touch != null) {
                    touch.before(name, out);
                    if (twinFile != null && twinFile.isFile()) touch.before(twin, twinFile);
                }
                out.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    for (int n; (n = zip.read(buffer)) > 0; ) os.write(buffer, 0, n);
                }
                if (twinFile != null) twinFile.delete();
            }
            zip.closeEntry();
        }
        return true;
    }

    /** `.removed.csv`: a `rowid,path` header, then one asset path per row. */
    private void removeFiles(InputStream entry) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(entry, StandardCharsets.UTF_8));
        for (String line; (line = reader.readLine()) != null; ) {
            int comma = line.indexOf(',');
            String path = (comma >= 0 ? line.substring(comma + 1) : line).trim();
            if (path.isEmpty() || line.startsWith("rowid,")) continue;
            File file = resolve(path);
            if (touch != null) touch.before(path, file);
            if (file.delete()) removed++;
        }
    }

    /** Resolves an archive path inside the asset dir, refusing anything that escapes it. */
    File resolve(String name) throws IOException {
        File file = new File(assetDir, name);
        if (!file.getCanonicalPath().startsWith(root)) throw new IOException("archive entry outside asset dir: " + name);
        return file;
    }

    // Same rules as the game's own (AS3) and the original ANE's AssetShortenedTools.
    static boolean isShortened(String path) {
        return path.endsWith(".hash");
    }

    static String shortenedToActual(String path) {
        String r = path.replaceFirst("^(.*)/hash/([^/]+/[^/]+)\\.hash$", "$1/$2");
        return r.equals(path) ? null : r;
    }

    static String actualToShortened(String path) {
        String r = path.replaceFirst("^(.*)/([^/]+/[^/]+)$", "$1/hash/$2.hash");
        return r.equals(path) ? null : r;
    }
}
