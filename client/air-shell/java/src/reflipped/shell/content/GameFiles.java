package reflipped.shell.content;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Properties;

/**
 * The imported game in the app's AIR storage (File.applicationStorageDirectory, "Local Store"):
 * <pre>
 *   reflipped-game/original.swf       the game SWF exactly as in the player's game app, kept so that an app update
 *                                     with a changed op list can patch it again without asking for the game
 *   reflipped-game/game.swf           the patched SWF, uncompressed; the loader runs it after checking its hash
 *   reflipped-game/import.properties  which op list made game.swf (its result's hash), when, and from what
 *   reflipped-game/logo.properties    whether BundleLogo added the REFLIPPED line to the title logo in bundle.zip,
 *                                     and the edited bundle's size and SHA-1 (the checks accept that size)
 *   bundle.zip, bundle.zip.sha1       the game's asset bundle, with the title logo's REFLIPPED line (BundleLogo);
 *                                     the patched game's extractor reads them here (tools/patch_import.py) and
 *                                     unpacks them into asset/, as the original does from the APK
 * </pre>
 * An import is written to reflipped-game.new and moved into place at the end, so an interrupted one leaves the old
 * files (or none) behind, never half of them.
 */
public final class GameFiles {
    public static final String DIR = "reflipped-game";
    static final String STAGING = "reflipped-game.new";
    static final String ORIGINAL = "original.swf";
    static final String GAME = "game.swf";
    static final String STATE = "import.properties";

    public enum State {
        /** game.swf was made with this app's op list and the bundle is in place: the loader can run it. */
        READY,
        /** The original SWF and the bundle are here, but game.swf is missing or from another op list (an app update). */
        REPATCH,
        /** Nothing usable: the game has to be imported. */
        IMPORT
    }

    public final File storage;
    public final ImportManifest manifest;

    public GameFiles(File storage, ImportManifest manifest) {
        this.storage = storage;
        this.manifest = manifest;
    }

    public File dir() {
        return new File(storage, DIR);
    }

    public File game() {
        return new File(dir(), GAME);
    }

    File original() {
        return new File(dir(), ORIGINAL);
    }

    File staging() {
        return new File(storage, STAGING);
    }

    /** Where an entry of the game app is kept: the SWF as original.swf in `dir`, the others in the storage root. */
    File place(File dir, ImportManifest.Entry entry) {
        return entry.name.equals(manifest.swfEntry) ? new File(dir, ORIGINAL) : new File(storage, entry.fileName());
    }

    public State state() {
        State state = check();
        if (state == State.IMPORT && !dir().exists() && finishCommit()) state = check();
        // a finished import or an old one is in use: whatever an interrupted import left behind can go
        if (state != State.IMPORT) deleteTree(staging());
        return state;
    }

    /**
     * An import killed inside {@link #commit()}, after the old folder went and before the new one moved in, left a
     * complete staging folder: move it into place.
     */
    private boolean finishCommit() {
        Properties staged = readState(new File(staging(), STATE));
        if (staged == null || !manifest.outputSha256.equals(staged.getProperty("output.sha256"))) return false;
        return staging().renameTo(dir());
    }

    private State check() {
        boolean bundle = true;
        for (ImportManifest.Entry e : manifest.entries) {
            if (e.name.equals(manifest.swfEntry)) continue;
            // the game's own size, or the size BundleLogo recorded after adding the REFLIPPED line to the title logo
            long size = place(dir(), e).length();
            if (size != e.size && size != BundleLogo.stampedSize(dir(), e.fileName())) bundle = false;
        }
        Properties state = readState(new File(dir(), STATE));
        if (bundle && state != null && manifest.outputSha256.equals(state.getProperty("output.sha256"))
                && game().length() == manifest.outputSize) {
            return State.READY;
        }
        if (bundle && original().length() == manifest.entry(manifest.swfEntry).size) return State.REPATCH;
        return State.IMPORT;
    }

    /** Marks game.swf as not ready, so the next start patches it again (it failed the loader's check). */
    public void invalidate() {
        new File(dir(), STATE).delete();
        game().delete();
    }

    /** Removes the imported SWFs (the bundle stays until an import replaces it). */
    public void clear() {
        deleteTree(dir());
        deleteTree(staging());
    }

    /** Patches original.swf into game.swf again with this app's op list (after an app update). */
    public void repatch(OpPatch ops, String source) throws IOException {
        File next = new File(dir(), GAME + ".new");
        patch(original(), ops, next);
        File state = new File(dir(), STATE);
        state.delete();
        if (!next.renameTo(game())) throw new IOException("can't move the patched SWF into place");
        writeState(dir(), source);
    }

    /**
     * Writes the patched form of `original` (the game's SWF as stored in its APK) to `target`. Throws
     * {@link OpPatch.Mismatch} if `original` isn't the SWF the manifest names or the result isn't the expected one.
     */
    void patch(File original, OpPatch ops, File target) throws IOException {
        ImportManifest.Entry entry = manifest.entry(manifest.swfEntry);
        if (original.length() != entry.size) throw new OpPatch.Mismatch(true, "the kept game SWF has another size");
        // inflate while reading and hashing the stored file: only the 31.7 MB result is in memory
        java.security.MessageDigest digest = Hashes.sha256();
        byte[] swf;
        try (InputStream in = new java.security.DigestInputStream(
                new java.io.BufferedInputStream(new FileInputStream(original), 1 << 16), digest)) {
            swf = Swf.uncompressed(in);
        } catch (IOException e) {
            if (!Hashes.hex(digest.digest()).equals(entry.sha256)) {
                throw new OpPatch.Mismatch(true, "the kept game SWF isn't the expected one");
            }
            throw e;
        }
        if (!Hashes.hex(digest.digest()).equals(entry.sha256)) {
            throw new OpPatch.Mismatch(true, "the kept game SWF isn't the expected one");
        }
        try (FileOutputStream file = new FileOutputStream(target);
             OutputStream out = new BufferedOutputStream(file, 1 << 16)) {
            ops.apply(swf, out);
            out.flush();
            file.getFD().sync();
        } catch (IOException e) {
            target.delete();
            throw e;
        }
    }

    void writeState(File dir, String source) throws IOException {
        Properties state = new Properties();
        state.setProperty("format", "1");
        state.setProperty("output.sha256", manifest.outputSha256);
        state.setProperty("ops.sha256", manifest.opsSha256);
        state.setProperty("game.version", manifest.gameVersion);
        state.setProperty("source", source);
        state.setProperty("time", Long.toString(System.currentTimeMillis()));
        try (FileOutputStream out = new FileOutputStream(new File(dir, STATE))) {
            state.store(out, "Reflipped: the imported game");
            out.getFD().sync();
        }
    }

    /** Moves a finished import from {@link #staging()} into place. */
    void commit() throws IOException {
        File staging = staging();
        for (ImportManifest.Entry e : manifest.entries) {
            if (e.name.equals(manifest.swfEntry)) continue;
            File from = new File(staging, e.fileName());
            File to = place(dir(), e);
            to.delete();
            if (!from.renameTo(to)) throw new IOException("can't move " + e.fileName() + " into place");
        }
        deleteTree(dir());
        if (!staging.renameTo(dir())) throw new IOException("can't move the imported game into place");
    }

    static Properties readState(File file) {
        if (!file.isFile()) return null;
        Properties p = new Properties();
        try (InputStream in = new FileInputStream(file)) {
            p.load(in);
            return p;
        } catch (IOException | IllegalArgumentException e) {
            return null;
        }
    }

    static byte[] readFully(File file) throws IOException {
        long length = file.length();
        if (length > Integer.MAX_VALUE) throw new IOException(file.getName() + " is too large");
        byte[] data = new byte[(int) length];
        try (InputStream in = new FileInputStream(file)) {
            int at = 0;
            while (at < data.length) {
                int n = in.read(data, at, data.length - at);
                if (n < 0) throw new IOException(file.getName() + " is shorter than expected");
                at += n;
            }
        }
        return data;
    }

    static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }
}
