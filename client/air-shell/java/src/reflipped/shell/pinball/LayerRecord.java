package reflipped.shell.pinball;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * SH-27: the paths the server layers wrote or deleted over the base game files (translation overlays, mods, the schedule
 * layer, the Chinese CDN's files: every archive that isn't one of the base asset list's), so the ~9 GB can stay when the
 * player moves to another server.
 *
 * {@code reflipped-layers.txt} beside the game's {@code info.json}: a header line, then one archive path per line. It
 * is started when the files are known to be base only (a fresh full download, a game data pack, a restore) and only
 * appended to after that, so a record without its header, or none at all (files from an older app), means "unknown"
 * and the files are downloaded again. The game's asset deletion removes it with the rest of the folder.
 *
 * SH-29: a record of version 2 also keeps the originals. Before a layer overwrites or deletes a base file, the
 * {@link Keeper} moves it to {@code reflipped-base/<path>} (a rename, a few MB in all), so {@link #restoreOriginals}
 * puts the base files back without any server, and an export of the game data can include them. Version 1 records
 * (from before) only list the paths; their base copies come from a server ({@code POST /shell/restore}). Plain Java, for
 * the desktop test.
 */
public final class LayerRecord {
    static final String NAME = "reflipped-layers.txt";
    static final String HEADER_V1 = "reflipped-layer-paths 1";
    static final String HEADER = "reflipped-layer-paths 2";
    /** Where the originals of the files layers changed are kept, beside info.json. */
    static final String ORIGINALS = "reflipped-base";

    private LayerRecord() {}

    static File file(File root) {
        return new File(root, NAME);
    }

    /** The folder of kept originals: the same archive paths as under the extraction folder. */
    public static File originals(File root) {
        return new File(root, ORIGINALS);
    }

    /** Starts an empty record that keeps originals: the files under {@code root} are the base files only. */
    public static void start(File root) throws IOException {
        root.mkdirs();
        deleteTree(originals(root));
        File temp = new File(root, NAME + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write((HEADER + "\n").getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!temp.renameTo(file(root))) throw new IOException("can't replace " + file(root));
    }

    /** Adds paths a layer touched; does nothing without a started record (then the files are unknown anyway). */
    public static void append(File root, Collection<String> paths) throws IOException {
        append(root, paths, true);
    }

    private static void append(File root, Collection<String> paths, boolean sync) throws IOException {
        File file = file(root);
        if (paths.isEmpty() || !file.isFile()) return;
        StringBuilder text = new StringBuilder();
        for (String path : paths) {
            if (path.indexOf('\n') >= 0 || path.indexOf('\r') >= 0) continue;
            text.append(path).append('\n');
        }
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write(text.toString().getBytes(StandardCharsets.UTF_8));
            if (sync) out.getFD().sync();
        }
    }

    /** The record's version (1 or 2), or 0 when there is no complete record. */
    public static int version(File root) {
        File file = file(root);
        if (!file.isFile()) return 0;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String header = reader.readLine();
            return HEADER.equals(header) ? 2 : HEADER_V1.equals(header) ? 1 : 0;
        } catch (IOException unreadable) {
            return 0;
        }
    }

    /** Whether the record keeps the originals, so {@link #restoreOriginals} can undo every layer. */
    public static boolean keepsOriginals(File root) {
        return version(root) == 2;
    }

    /** The recorded paths, or null when there is no complete record. */
    public static Set<String> read(File root) {
        File file = file(root);
        if (!file.isFile()) return null;
        Set<String> paths = new LinkedHashSet<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String header = reader.readLine();
            if (!HEADER.equals(header) && !HEADER_V1.equals(header)) return null;
            for (String line; (line = reader.readLine()) != null; ) if (!line.isEmpty()) paths.add(line);
        } catch (IOException unreadable) {
            return null;
        }
        return paths;
    }

    /**
     * Keeps the originals of what one layer archive changes ({@link ArchiveExtractor#touch}); null when there is no
     * record. Call {@link Keeper#close} when the archive is done (or stopped).
     */
    public static Keeper keeper(File root) {
        Set<String> known = read(root);
        return known == null ? null : new Keeper(root, known, version(root) == 2);
    }

    /** Records each path before a layer changes it, and moves a base original aside first (version 2). */
    public static final class Keeper implements ArchiveExtractor.Touch {
        private final File root;
        private final File originals;
        private final Set<String> known;
        private final boolean keep;
        private final java.util.List<String> pending = new java.util.ArrayList<>();

        private Keeper(File root, Set<String> known, boolean keep) {
            this.root = root;
            this.originals = originals(root);
            this.known = known;
            this.keep = keep;
        }

        /**
         * Before a layer writes or deletes {@code path} (its file {@code file}, already checked to be inside the
         * extraction folder). A path seen before holds a layer's copy (or nothing of the base): it is left alone. The
         * original is moved before the path is recorded, so a stop in between leaves it kept, and a kept original is
         * never replaced.
         */
        @Override
        public void before(String path, File file) throws IOException {
            if (!known.add(path)) return;
            if (keep && file.isFile()) {
                File kept = new File(originals, path);
                if (!kept.exists()) {
                    kept.getParentFile().mkdirs();
                    if (!file.renameTo(kept)) throw new IOException("can't keep the original of " + path);
                }
            }
            pending.add(path);
            if (pending.size() >= 256) flush(false);
        }

        private void flush(boolean sync) throws IOException {
            append(root, pending, sync);
            pending.clear();
        }

        /** Writes what is left of the record and syncs it. */
        public void close() throws IOException {
            flush(true);
        }
    }

    /**
     * SH-29: undoes every layer from the kept originals: each recorded path (and each kept original, even one a stop
     * left unrecorded) gets its original back, or is deleted when the base had none; then a new record starts. False,
     * changing nothing, when the record doesn't keep originals.
     */
    public static boolean restoreOriginals(File root, File assetDir) throws IOException {
        Set<String> paths = read(root);
        if (paths == null || version(root) != 2) return false;
        File originals = originals(root);
        String assetRoot = assetDir.getCanonicalPath() + File.separator;
        String keptRoot = originals.getCanonicalPath() + File.separator;
        Set<String> all = new LinkedHashSet<>(paths);
        all.addAll(listFiles(originals));
        for (String path : all) {
            File target = new File(assetDir, path);
            File kept = new File(originals, path);
            if (!target.getCanonicalPath().startsWith(assetRoot) || !kept.getCanonicalPath().startsWith(keptRoot))
                throw new IOException("recorded path outside the game files: " + path);
            if (kept.isFile()) {
                target.getParentFile().mkdirs();
                if (target.exists() && !target.delete()) throw new IOException("can't replace " + path);
                if (!kept.renameTo(target)) throw new IOException("can't put back " + path);
            } else if (target.exists() && !target.delete()) {
                throw new IOException("can't delete " + path);
            }
        }
        start(root);
        return true;
    }

    /**
     * SH-29: the base game's copy of the archive path {@code path} (a CDN member name, {@code production/upload/…}),
     * under either of its names (the game may keep it as its shortened twin): the file in {@code assetDir}, or the kept
     * original when a layer changed it. Null when the base files hold none, or when a layer changed it and its original
     * wasn't kept (a version 1 record). {@code changed} is {@link #read}'s answer; with null (no record) the files
     * are taken as they are, and the caller's checks must tell a layer's copy from the base one.
     */
    public static File baseFile(File root, File assetDir, Set<String> changed, String path) {
        String twin = ArchiveExtractor.isShortened(path) ? ArchiveExtractor.shortenedToActual(path)
                : ArchiveExtractor.actualToShortened(path);
        for (String name : twin == null ? new String[]{path} : new String[]{path, twin}) {
            File file;
            if (changed != null && changed.contains(name)) file = new File(originals(root), name);
            else file = new File(assetDir, name);
            if (file.isFile()) return file;
        }
        return null;
    }

    /** The files under {@code dir}, as paths relative to it. */
    static Set<String> listFiles(File dir) {
        Set<String> out = new LinkedHashSet<>();
        Deque<File> todo = new ArrayDeque<>();
        if (dir.isDirectory()) todo.add(dir);
        int prefix = dir.getPath().length() + 1;
        while (!todo.isEmpty()) {
            File[] children = todo.pop().listFiles();
            if (children == null) continue;
            for (File child : children) {
                if (child.isDirectory()) todo.push(child);
                else out.add(child.getPath().substring(prefix).replace(File.separatorChar, '/'));
            }
        }
        return out;
    }

    static void deleteTree(File dir) throws IOException {
        if (!dir.exists()) return;
        Deque<File> todo = new ArrayDeque<>();
        Deque<File> dirs = new ArrayDeque<>();
        todo.add(dir);
        while (!todo.isEmpty()) {
            File f = todo.pop();
            File[] children = f.isDirectory() ? f.listFiles() : null;
            if (children != null) {
                dirs.push(f);
                for (File c : children) todo.push(c);
            } else if (!f.delete()) {
                throw new IOException("can't delete " + f);
            }
        }
        while (!dirs.isEmpty()) if (!dirs.pop().delete()) throw new IOException("can't delete a folder of " + dir);
    }

    /** Whether an archive of a download list is one of the base files' (`<lang>/archive-<kind>/asset-…zip` on a CDN). */
    static boolean isBase(String location) {
        return location.matches("^.*/archive-[^/]+/(?:s?_?asset|pinball)-\\d+\\.\\d+\\.\\d+-(?:\\d+\\.\\d+\\.\\d+-)?\\d+-[0-9a-f]+\\.zip$");
    }

    /** Whether a download list starts the files from scratch: it holds a base full archive. */
    static boolean isFullBase(String location) {
        return isBase(location) && location.matches("^.*/archive-[^/]+-full/[^/]+$");
    }
}
