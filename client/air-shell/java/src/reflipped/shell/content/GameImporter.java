package reflipped.shell.content;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipException;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

/**
 * Imports the game from the player's own game app: copies the files the manifest lists out of its APK, checks each
 * one's size and SHA-256 (that is the version check: only 0.0.81 has these files), patches the SWF with the op list
 * and moves everything into place ({@link GameFiles}). No Android classes, so it also runs in a desktop test.
 *
 * Inputs: the installed app's APK files (base.apk plus any split APKs), or a file the player picked, read as a stream:
 * an APK, or a bundle of APKs (.xapk, .apks) whose APKs are searched one level deep.
 */
public final class GameImporter {
    public enum Problem {
        /** The input has none (or not all) of the game's files: it isn't the game app. */
        NOT_GAME,
        /** The game's files are there, but differ: another version of the game. */
        WRONG_VERSION,
        /** The input couldn't be read to the end. */
        UNREADABLE,
        /** The files were right, but patching them failed (a mismatch between this app's manifest and op list). */
        PATCH_FAILED,
        /** The files couldn't be written to the app's storage. */
        SAVE_FAILED,
        /** Not enough memory to patch the SWF (about 32 MB at once). */
        OUT_OF_MEMORY
    }

    public static final class Failure extends Exception {
        public final Problem problem;

        Failure(Problem problem, String detail, Throwable cause) {
            super(problem + ": " + detail, cause);
            this.problem = problem;
        }
    }

    public interface Progress {
        /** Bytes of the game's files copied so far, of `total`. */
        void reading(long done, long total);

        void patching();

        void saving();
    }

    private static final class Target {
        final ImportManifest.Entry entry;
        final File file;
        boolean found;
        boolean matches;

        Target(ImportManifest.Entry entry, File file) {
            this.entry = entry;
            this.file = file;
        }
    }

    private final GameFiles files;
    private final OpPatch ops;
    private final Progress progress;
    private final Map<String, Target> targets = new LinkedHashMap<>();
    private long copied;
    /** True when {@link #fromPickedFile} had to read a copy of the file (for the log). */
    public boolean readFromCopy;

    public GameImporter(GameFiles files, OpPatch ops, Progress progress) {
        this.files = files;
        this.ops = ops;
        this.progress = progress;
    }

    /** Imports from APK files on disk: an installed app's base.apk and split APKs. */
    public void fromApkFiles(List<File> apks, String source) throws Failure {
        try {
            fromApkFilesNow(apks, source);
        } catch (Failure | RuntimeException e) {
            GameFiles.deleteTree(files.staging());
            throw e;
        }
    }

    private void fromApkFilesNow(List<File> apks, String source) throws Failure {
        begin();
        for (File apk : apks) {
            if (complete()) break;
            try (ZipFile zip = new ZipFile(apk)) {
                readZip(zip);
            } catch (ZipException e) {
                // not a zip (or a damaged one): the found/missing check below tells what is missing
                if (anyFound()) throw new Failure(Problem.UNREADABLE, apk.getName() + " is damaged", e);
            } catch (IOException e) {
                throw new Failure(problemOf(e), apk.getName(), e);
            }
        }
        finish(source);
    }

    /** Imports from a stream of an APK or of a bundle of APKs (.xapk, .apks). */
    public void fromStream(InputStream input, String source) throws Failure {
        try {
            fromStreamNow(input, source);
        } catch (Failure | RuntimeException e) {
            GameFiles.deleteTree(files.staging());
            throw e;
        }
    }

    private void fromStreamNow(InputStream input, String source) throws Failure {
        begin();
        try {
            readStream(input, 0);
        } catch (ZipException e) {
            if (!anyFound()) throw new Failure(Problem.NOT_GAME, "not a zip file", e);
            throw new Failure(Problem.UNREADABLE, "damaged zip file", e);
        } catch (IOException e) {
            throw new Failure(problemOf(e), "copying the game's files", e);
        }
        finish(source);
    }

    /** The same as {@link #fromStream} for a file that ZipFile can open directly (faster: no full read). */
    public void fromZipFile(File file, String source) throws Failure {
        try {
            fromZipFileNow(file, source);
        } catch (Failure | RuntimeException e) {
            GameFiles.deleteTree(files.staging());
            throw e;
        }
    }

    private void fromZipFileNow(File file, String source) throws Failure {
        begin();
        try (ZipFile zip = new ZipFile(file)) {
            readZip(zip);
        } catch (ZipException e) {
            if (!anyFound()) throw new Failure(Problem.NOT_GAME, "not a zip file", e);
            throw new Failure(Problem.UNREADABLE, "damaged zip file", e);
        } catch (IOException e) {
            throw new Failure(problemOf(e), "copying the game's files", e);
        }
        finish(source);
    }

    /** Opens the picked file again from its start. */
    public interface Opener {
        InputStream open() throws IOException;
    }

    /**
     * Imports a picked file: as a stream first (no copy of the whole file). ZipInputStream can't read some valid
     * zips (a STORED entry with a data descriptor, for one); if the stream fails with a zip error, the file is copied
     * to `spill` (in the app's cache) and read with ZipFile instead. `spill` is deleted afterwards.
     */
    public void fromPickedFile(Opener opener, File spill, String source) throws Failure {
        Failure first;
        try (InputStream in = opener.open()) {
            if (in == null) throw new IOException("no stream");
            fromStream(in, source);
            return;
        } catch (Failure f) {
            // a zip error, or (as Android's ZipInputStream does with such entries) no entry found in a file that
            // starts like a zip: try again from a copy. Anything else stands.
            boolean zipError = f.getCause() instanceof ZipException;
            if (!zipError && !(f.problem == Problem.NOT_GAME && startsLikeZip(opener))) throw f;
            first = f;
        } catch (IOException | SecurityException e) {
            throw new Failure(Problem.UNREADABLE, "can't open the file", e);
        }
        try {
            try (InputStream in = opener.open(); OutputStream out = new FileOutputStream(spill)) {
                if (in == null) throw new IOException("no stream");
                byte[] buffer = new byte[1 << 16];
                long size = 0;
                int n;
                while ((n = in.read(buffer)) > 0) {
                    size += n;
                    if (size > MAX_SPILL) throw first;  // far larger than any form of the game app: not it
                    try {
                        out.write(buffer, 0, n);
                    } catch (IOException e) {
                        throw new EntryFailure(Problem.SAVE_FAILED, "copying the file to the cache", e);
                    }
                }
            } catch (IOException | SecurityException e) {
                Problem problem = e instanceof IOException ? problemOf((IOException) e) : Problem.UNREADABLE;
                throw new Failure(problem, "copying the file to the cache", e);
            }
            readFromCopy = true;
            fromZipFile(spill, source);
        } finally {
            spill.delete();
        }
    }

    /** The largest picked file copied to the cache for a second try (the game's APK is 87 MB, an XAPK about as much) */
    private static final long MAX_SPILL = 512L * 1024 * 1024;

    private static boolean startsLikeZip(Opener opener) {
        try (InputStream in = opener.open()) {
            if (in == null) return false;
            byte[] magic = new byte[4];
            int got = 0;
            while (got < 4) {
                int n = in.read(magic, got, 4 - got);
                if (n < 0) return false;
                got += n;
            }
            return magic[0] == 'P' && magic[1] == 'K' && magic[2] == 3 && magic[3] == 4;
        } catch (IOException | SecurityException e) {
            return false;
        }
    }

    private void begin() throws Failure {
        File staging = files.staging();
        GameFiles.deleteTree(staging);
        if (!staging.mkdirs()) throw new Failure(Problem.SAVE_FAILED, "can't create " + staging, null);
        targets.clear();
        copied = 0;
        for (ImportManifest.Entry e : files.manifest.entries) {
            File file = e.name.equals(files.manifest.swfEntry) ? new File(staging, GameFiles.ORIGINAL)
                    : new File(staging, e.fileName());
            targets.put(e.name, new Target(e, file));
        }
        progress.reading(0, files.manifest.importBytes());
    }

    private boolean complete() {
        for (Target t : targets.values()) if (!t.found) return false;
        return true;
    }

    private boolean anyFound() {
        for (Target t : targets.values()) if (t.found) return true;
        return false;
    }

    private void readZip(ZipFile zip) throws IOException {
        for (Target t : targets.values()) {
            if (t.found) continue;
            ZipEntry entry = zip.getEntry(t.entry.name);
            if (entry == null || entry.isDirectory()) continue;
            try (InputStream in = zip.getInputStream(entry)) {
                copy(in, t);
            }
        }
        if (complete()) return;
        Enumeration<? extends ZipEntry> all = zip.entries();
        while (all.hasMoreElements() && !complete()) {
            ZipEntry entry = all.nextElement();
            if (!entry.isDirectory() && isApk(entry.getName())) {
                try (InputStream in = zip.getInputStream(entry)) {
                    readStream(in, 1);
                } catch (ZipException ignored) {
                    // an inner file named .apk that isn't one
                }
            }
        }
    }

    private void readStream(InputStream input, int depth) throws IOException {
        // closing it frees its Inflater; the stream under it belongs to the caller (or, for an inner APK, to the
        // outer bundle, which goes on to its next entry)
        try (ZipInputStream zip = new ZipInputStream(new FilterInputStream(input) {
            @Override
            public void close() {
            }
        })) {
            ZipEntry entry;
            while (!complete() && (entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                Target t = targets.get(entry.getName());
                if (t != null && !t.found) {
                    copy(zip, t);
                } else if (depth == 0 && isApk(entry.getName())) {
                    try {
                        readStream(zip, depth + 1);
                    } catch (ZipException ignored) {
                        // not an APK after all (a failure inside one of the game's files is an EntryFailure)
                    }
                }
            }
        }
    }

    private static boolean isApk(String name) {
        return name.toLowerCase(java.util.Locale.ROOT).endsWith(".apk");
    }

    /**
     * A failure while copying one of the game's files, with its problem: writing failed (SAVE_FAILED), the entry is
     * larger than the game's (WRONG_VERSION; the copy stops there, so a crafted entry can't fill the storage), or its
     * data is damaged (UNREADABLE). Not a ZipException, so "not a zip file" is never reported for it.
     */
    private static final class EntryFailure extends IOException {
        final Problem problem;

        EntryFailure(Problem problem, String message, IOException cause) {
            super(message, cause);
            this.problem = problem;
        }
    }

    private void copy(InputStream in, Target t) throws IOException {
        MessageDigest digest = Hashes.sha256();
        long size = 0;
        byte[] buffer = new byte[1 << 16];
        long total = files.manifest.importBytes();
        try (FileOutputStream file = new FileOutputStream(t.file);
             OutputStream out = new BufferedOutputStream(file, 1 << 16)) {
            while (true) {
                int n;
                try {
                    n = in.read(buffer);
                } catch (ZipException e) {
                    throw new EntryFailure(Problem.UNREADABLE, t.entry.name + " is damaged", e);
                }
                if (n < 0) break;
                if (size + n > t.entry.size) {
                    throw new EntryFailure(Problem.WRONG_VERSION, t.entry.name + " is larger than version "
                            + files.manifest.gameVersion + "'s", null);
                }
                digest.update(buffer, 0, n);
                size += n;
                try {
                    out.write(buffer, 0, n);
                } catch (IOException e) {
                    throw new EntryFailure(Problem.SAVE_FAILED, "writing " + t.file.getName(), e);
                }
                copied += n;
                progress.reading(Math.min(copied, total), total);
            }
            try {
                out.flush();
                file.getFD().sync();
            } catch (IOException e) {
                throw new EntryFailure(Problem.SAVE_FAILED, "writing " + t.file.getName(), e);
            }
        }
        t.found = true;
        t.matches = size == t.entry.size && Hashes.hex(digest.digest()).equals(t.entry.sha256);
    }

    private void finish(String source) throws Failure {
        List<String> missing = new ArrayList<>();
        boolean mismatch = false;
        for (Target t : targets.values()) {
            if (!t.found) missing.add(t.entry.name);
            else if (!t.matches) mismatch = true;
        }
        if (missing.size() == targets.size()) throw new Failure(Problem.NOT_GAME, "none of the game's files", null);
        if (mismatch) throw new Failure(Problem.WRONG_VERSION, "files differ from version " + files.manifest.gameVersion, null);
        if (!missing.isEmpty()) throw new Failure(Problem.NOT_GAME, "missing " + missing, null);
        progress.patching();
        File staging = files.staging();
        try {
            files.patch(new File(staging, GameFiles.ORIGINAL), ops, new File(staging, GameFiles.GAME));
        } catch (OpPatch.Mismatch e) {
            throw new Failure(Problem.PATCH_FAILED, e.getMessage(), e);
        } catch (OutOfMemoryError e) {
            throw new Failure(Problem.OUT_OF_MEMORY, "patching the SWF", null);
        } catch (IOException e) {
            throw new Failure(Problem.SAVE_FAILED, "writing the patched SWF", e);
        }
        progress.saving();
        try {
            files.writeState(staging, source);
            files.commit();
        } catch (IOException e) {
            throw new Failure(Problem.SAVE_FAILED, "moving the files into place", e);
        }
    }

    /** The problem of a failure inside a copy; other IOExceptions are read failures. */
    static Problem problemOf(IOException e) {
        return e instanceof EntryFailure ? ((EntryFailure) e).problem : Problem.UNREADABLE;
    }
}
