package reflipped.shell.content;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/**
 * SH-20: the importer, patcher and storage states on a desktop JVM, against the fixture of sh20-import-fixture.py
 * (args: fixture dir, scratch dir), or against a real import build (args: the build's reflipped-import assets dir,
 * scratch dir, the game APK), which also prints timings.
 */
public final class ImportTest {
    private static int failures;

    public static void main(String[] args) throws Exception {
        File assets = args.length > 2 ? new File(args[0]) : new File(args[0], "assets");
        File scratch = new File(args[1]);
        ImportManifest manifest;
        try (InputStream in = new FileInputStream(new File(assets, ImportManifest.FILE))) {
            manifest = ImportManifest.read(in);
        }
        OpPatch ops = new OpPatch(GameFiles.readFully(new File(assets, manifest.opsName)));
        check("op list result = manifest", Hashes.hex(ops.outputSha256).equals(manifest.outputSha256));
        if (args.length > 2) {
            real(manifest, ops, new File(args[2]), scratch);
        } else {
            fixture(manifest, ops, new File(args[0]), scratch);
        }
        if (failures > 0) {
            System.out.println(failures + " check(s) failed");
            System.exit(1);
        }
        System.out.println("all checks passed");
    }

    private static void fixture(ImportManifest manifest, OpPatch ops, File dir, File scratch) throws Exception {
        String expected = new String(GameFiles.readFully(new File(dir, "expected.sha256")), StandardCharsets.US_ASCII).trim();

        GameFiles files = fresh(scratch, "installed", manifest);
        check("empty storage needs an import", files.state() == GameFiles.State.IMPORT);
        new GameImporter(files, ops, quiet()).fromApkFiles(Collections.singletonList(new File(dir, "game.apk")), "installed");
        check("installed app: ready", files.state() == GameFiles.State.READY);
        check("installed app: game.swf is the patched SWF",
                Hashes.hex(Hashes.sha256(GameFiles.readFully(files.game()))).equals(expected));
        check("bundle.zip in the storage root", new File(files.storage, "bundle.zip").length() == manifest.entry("assets/bundle.zip").size);
        check("bundle.zip.sha1 in the storage root", new File(files.storage, "bundle.zip.sha1").isFile());
        check("original kept", new File(files.dir(), GameFiles.ORIGINAL).isFile());
        check("no staging folder left", !files.staging().exists());

        // an app update with another op list: the state names a different result
        File state = new File(files.dir(), GameFiles.STATE);
        String text = new String(GameFiles.readFully(state), StandardCharsets.ISO_8859_1);
        write(state, text.replace(manifest.outputSha256, repeat('0', 64)));
        check("other op list: re-patch", files.state() == GameFiles.State.REPATCH);
        files.repatch(ops, "update");
        check("after re-patch: ready", files.state() == GameFiles.State.READY);
        check("re-patched game.swf",
                Hashes.hex(Hashes.sha256(GameFiles.readFully(files.game()))).equals(expected));

        // the loader found game.swf damaged
        files.invalidate();
        check("invalidated: re-patch", files.state() == GameFiles.State.REPATCH);
        files.repatch(ops, "update");
        check("re-patched after invalidate: ready", files.state() == GameFiles.State.READY);

        // a damaged kept original can't be re-patched: import again
        byte[] original = GameFiles.readFully(new File(files.dir(), GameFiles.ORIGINAL));
        original[original.length / 2] ^= 1;
        write(new File(files.dir(), GameFiles.ORIGINAL), original);
        files.invalidate();
        try {
            files.repatch(ops, "update");
            check("damaged original refused", false);
        } catch (OpPatch.Mismatch e) {
            check("damaged original refused", e.input);
        }
        files.clear();
        check("cleared: import", files.state() == GameFiles.State.IMPORT);

        // an interrupted import leaves the old files usable
        files = fresh(scratch, "interrupted", manifest);
        new GameImporter(files, ops, quiet()).fromApkFiles(Collections.singletonList(new File(dir, "game.apk")), "installed");
        files.staging().mkdirs();
        write(new File(files.staging(), GameFiles.ORIGINAL), new byte[10]);
        check("half an import beside a finished one: still ready", files.state() == GameFiles.State.READY);
        check("the leftover staging folder is cleaned up", !files.staging().exists());

        // a kill inside commit(), after the old folder went and before the new one moved in
        files = fresh(scratch, "commitkill", manifest);
        new GameImporter(files, ops, quiet()).fromApkFiles(Collections.singletonList(new File(dir, "game.apk")), "installed");
        check("(set-up) folder moved back to staging", files.dir().renameTo(files.staging()));
        check("killed mid-commit: ready again", files.state() == GameFiles.State.READY);
        check("killed mid-commit: moved into place", files.dir().isDirectory() && !files.staging().exists());

        // a crafted entry larger than the game's: the copy stops at the game's size
        expectProblem("oversized entry (stream)", manifest, ops, scratch, new File(dir, "oversized.apk"), false,
                GameImporter.Problem.WRONG_VERSION);
        expectProblem("oversized entry (installed)", manifest, ops, scratch, new File(dir, "oversized.apk"), true,
                GameImporter.Problem.WRONG_VERSION);
        // damaged compressed data inside one of the game's files: a damaged file, not "not a zip"
        expectProblem("damaged entry (stream)", manifest, ops, scratch, new File(dir, "damaged.apk"), false,
                GameImporter.Problem.UNREADABLE);
        files = fresh(scratch, "damagedinstalled", manifest);
        try {
            new GameImporter(files, ops, quiet()).fromApkFiles(Collections.singletonList(new File(dir, "damaged.apk")),
                    "installed");
            check("damaged entry (installed) refused", false);
        } catch (GameImporter.Failure f) {
            // ZipFile doesn't check the CRC: depending on the damage, inflating fails or the hash does
            check("damaged entry (installed) refused (" + f.problem + ")", f.problem == GameImporter.Problem.UNREADABLE
                    || f.problem == GameImporter.Problem.WRONG_VERSION);
        }

        // STORED entries with data descriptors: the stream can't read them, the copy to the cache can
        File storedDd = new File(dir, "stored-dd.apk");
        files = fresh(scratch, "storeddd", manifest);
        try (InputStream in = new FileInputStream(storedDd)) {
            new GameImporter(files, ops, quiet()).fromStream(in, "file");
            check("STORED + data descriptor refused by the stream", false);
        } catch (GameImporter.Failure f) {
            check("STORED + data descriptor refused by the stream with a zip error",
                    f.getCause() instanceof java.util.zip.ZipException);
        }
        File spill = new File(scratch, "spill.apk");
        new GameImporter(files, ops, quiet()).fromPickedFile(() -> new FileInputStream(storedDd), spill, "file");
        check("STORED + data descriptor (picked file, read again from the cache): ready",
                files.state() == GameFiles.State.READY);
        check("the cache copy is deleted", !spill.exists());
        files = fresh(scratch, "pickedplain", manifest);
        new GameImporter(files, ops, quiet()).fromPickedFile(() -> new FileInputStream(new File(dir, "game.apk")),
                spill, "file");
        check("picked file (stream, no cache copy): ready", files.state() == GameFiles.State.READY && !spill.exists());
        files = fresh(scratch, "pickednotgame", manifest);
        try {
            new GameImporter(files, ops, quiet()).fromPickedFile(() -> new FileInputStream(new File(dir, "notgame.zip")),
                    spill, "file");
            check("picked zip that isn't the game refused", false);
        } catch (GameImporter.Failure f) {
            check("picked zip that isn't the game: NOT_GAME after the second try (" + f.problem + ")",
                    f.problem == GameImporter.Problem.NOT_GAME && !spill.exists());
        }

        files = fresh(scratch, "file", manifest);
        try (InputStream in = new FileInputStream(new File(dir, "game.apk"))) {
            new GameImporter(files, ops, quiet()).fromStream(in, "file");
        }
        check("APK file (stream): ready", files.state() == GameFiles.State.READY);

        files = fresh(scratch, "xapk", manifest);
        try (InputStream in = new FileInputStream(new File(dir, "game.xapk"))) {
            new GameImporter(files, ops, quiet()).fromStream(in, "file");
        }
        check("XAPK (stream): ready", files.state() == GameFiles.State.READY);

        files = fresh(scratch, "xapk-zipfile", manifest);
        new GameImporter(files, ops, quiet()).fromZipFile(new File(dir, "game.xapk"), "file");
        check("XAPK (zip file): ready", files.state() == GameFiles.State.READY);

        expectProblem("wrong version (stream)", manifest, ops, scratch, new File(dir, "wrong.apk"), false,
                GameImporter.Problem.WRONG_VERSION);
        expectProblem("wrong version (installed)", manifest, ops, scratch, new File(dir, "wrong.apk"), true,
                GameImporter.Problem.WRONG_VERSION);
        expectProblem("not the game (zip)", manifest, ops, scratch, new File(dir, "notgame.zip"), false,
                GameImporter.Problem.NOT_GAME);
        expectProblem("not the game (not a zip)", manifest, ops, scratch, new File(dir, "notzip.bin"), false,
                GameImporter.Problem.NOT_GAME);
        expectProblem("not the game (installed, not a zip)", manifest, ops, scratch, new File(dir, "notzip.bin"), true,
                GameImporter.Problem.NOT_GAME);

        // a cut-off download: the stream ends inside bundle.zip
        File cut = new File(scratch, "cut.apk");
        byte[] apk = GameFiles.readFully(new File(dir, "game.apk"));
        write(cut, java.util.Arrays.copyOf(apk, apk.length * 2 / 3));
        files = fresh(scratch, "cut", manifest);
        try (InputStream in = new FileInputStream(cut)) {
            new GameImporter(files, ops, quiet()).fromStream(in, "file");
            check("cut-off file refused", false);
        } catch (GameImporter.Failure f) {
            check("cut-off file refused (" + f.problem + ")", f.problem != null);
        }
        check("cut-off file: nothing imported", files.state() == GameFiles.State.IMPORT);

        // a broken op list (another app's) can't produce a game.swf
        byte[] broken = GameFiles.readFully(new File(dir, "assets/swf.ops"));
        broken[20] ^= 1;  // the input hash
        files = fresh(scratch, "badops", manifest);
        try {
            new GameImporter(files, new OpPatch(broken), quiet()).fromApkFiles(
                    Collections.singletonList(new File(dir, "game.apk")), "installed");
            check("op list for another SWF refused", false);
        } catch (GameImporter.Failure f) {
            check("op list for another SWF refused", f.problem == GameImporter.Problem.PATCH_FAILED);
        }
        check("bad op list: nothing imported", files.state() == GameFiles.State.IMPORT);
    }

    private static void real(ImportManifest manifest, OpPatch ops, File apk, File scratch) throws Exception {
        GameFiles files = fresh(scratch, "real-installed", manifest);
        long t0 = System.nanoTime();
        new GameImporter(files, ops, quiet()).fromApkFiles(Collections.singletonList(apk), "installed");
        long t1 = System.nanoTime();
        check("real APK (zip file): ready", files.state() == GameFiles.State.READY);
        System.out.println("import from the APK as a zip file: " + (t1 - t0) / 1000000 + " ms");
        files = fresh(scratch, "real-stream", manifest);
        t0 = System.nanoTime();
        try (InputStream in = new FileInputStream(apk)) {
            new GameImporter(files, ops, quiet()).fromStream(in, "file");
        }
        t1 = System.nanoTime();
        check("real APK (stream): ready", files.state() == GameFiles.State.READY);
        System.out.println("import from the APK as a stream: " + (t1 - t0) / 1000000 + " ms");
        files.invalidate();
        t0 = System.nanoTime();
        files.repatch(ops, "update");
        t1 = System.nanoTime();
        check("real re-patch: ready", files.state() == GameFiles.State.READY);
        System.out.println("re-patch: " + (t1 - t0) / 1000000 + " ms");
        check("real game.swf hash", Hashes.hex(Hashes.sha256(GameFiles.readFully(files.game()))).equals(manifest.outputSha256));
    }

    private static void expectProblem(String name, ImportManifest manifest, OpPatch ops, File scratch, File input,
                                      boolean asInstalled, GameImporter.Problem expected) throws IOException {
        GameFiles files = fresh(scratch, name.replaceAll("[^a-z]", ""), manifest);
        try {
            GameImporter importer = new GameImporter(files, ops, quiet());
            if (asInstalled) {
                importer.fromApkFiles(Collections.singletonList(input), "installed");
            } else {
                try (InputStream in = new FileInputStream(input)) {
                    importer.fromStream(in, "file");
                }
            }
            check(name, false);
        } catch (GameImporter.Failure f) {
            check(name + " (" + f.problem + ")", f.problem == expected);
        }
        check(name + ": nothing imported", files.state() == GameFiles.State.IMPORT);
        check(name + ": no staging folder left", !files.staging().exists());
    }

    private static GameFiles fresh(File scratch, String name, ImportManifest manifest) {
        File storage = new File(scratch, name);
        GameFiles.deleteTree(storage);
        storage.mkdirs();
        return new GameFiles(storage, manifest);
    }

    private static GameImporter.Progress quiet() {
        return new GameImporter.Progress() {
            @Override
            public void reading(long done, long total) {
                if (done > total) throw new IllegalStateException("progress past the total");
            }

            @Override
            public void patching() {
            }

            @Override
            public void saving() {
            }
        };
    }

    private static void write(File file, byte[] data) throws IOException {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }

    private static void write(File file, String text) throws IOException {
        write(file, text.getBytes(StandardCharsets.ISO_8859_1));
    }

    private static String repeat(char c, int n) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < n; i++) out.append(c);
        return out.toString();
    }

    private static void check(String name, boolean ok) {
        System.out.println((ok ? "ok   " : "FAIL ") + name);
        if (!ok) failures++;
    }
}
