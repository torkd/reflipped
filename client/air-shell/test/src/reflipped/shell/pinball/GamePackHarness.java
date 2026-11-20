package reflipped.shell.pinball;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Desktop check of the game data pack installer (SH-25) against a pack the real tool made (`npm run gamepack -- --limit
 * N`, client/air-shell/test/gamepack-test.sh): every file ends up as in the CDN's archives, a pack whose list isn't an
 * official one is refused, and a damaged or cut-off pack stops with a reason before writing the damaged archive's files.
 *
 *   java GamePackHarness <pack.tar> <cdn dir> <work dir>
 */
public final class GamePackHarness {
    private static int failures;

    public static void main(String[] args) throws Exception {
        byte[] pack = Files.readAllBytes(new File(args[0]).toPath());
        File cdn = new File(args[1]);
        File work = new File(args[2]);

        // 1. installs, and the files match the archives (a later archive's copy wins, as in a download)
        File out = new File(work, "installed");
        GamePack reader = new GamePack(new ByteArrayInputStream(pack), true);
        GamePack.Manifest manifest = reader.manifest();
        long[] reported = {0};
        check("install completes", reader.install(out, (done, total) -> reported[0] = done, null), true);
        check("progress reaches the total", reported[0], manifest.totalSize);
        Map<String, byte[]> expected = new HashMap<>();
        for (GamePack.Archive archive : manifest.archives) {
            try (ZipFile zip = new ZipFile(new File(cdn, archive.path))) {
                for (Enumeration<? extends ZipEntry> e = zip.entries(); e.hasMoreElements(); ) {
                    ZipEntry entry = e.nextElement();
                    if (entry.isDirectory() || entry.getName().equals(".removed.csv")) continue;
                    expected.put(entry.getName(), read(zip.getInputStream(entry)));
                }
            }
        }
        int same = 0;
        for (Map.Entry<String, byte[]> file : expected.entrySet()) {
            File written = new File(out, file.getKey());
            if (written.isFile() && Arrays.equals(Files.readAllBytes(written.toPath()), file.getValue())) same++;
            else System.out.println("FAIL differs: " + file.getKey());
        }
        check("files identical to the archives' entries", same, expected.size());
        System.out.println("installed " + manifest.archives.size() + " archives, " + same + " files");

        // 2. a list that isn't an official one (this test pack's) is refused by the app's reader
        refused("not an official list", pack, false, "official");

        // 3. one changed byte in the second archive: refused, and nothing of that archive written
        int second = offsetOf(pack, manifest, 1);
        byte[] tampered = pack.clone();
        tampered[second + 1000] ^= 1;
        File damaged = new File(work, "tampered");
        refusedInto("damaged archive", tampered, damaged, "doesn't match");
        int leaked = 0;
        try (ZipFile zip = new ZipFile(new File(cdn, manifest.archives.get(1).path))) {
            for (Enumeration<? extends ZipEntry> e = zip.entries(); e.hasMoreElements(); ) {
                String name = e.nextElement().getName();
                if (!isIn(cdn, manifest.archives.get(0).path, name) && new File(damaged, name).exists()) leaked++;
            }
        }
        check("no file of the damaged archive written", leaked, 0);

        // 4. a pack cut off in the middle of an archive
        refused("cut-off pack", Arrays.copyOf(pack, second + 4096), true, "incomplete");

        // 5. not a pack at all
        refused("not a pack", "hello, this is not a tar".getBytes("UTF-8"), true, "isn't a game data pack");

        if (failures > 0) {
            System.out.println(failures + " check(s) failed");
            System.exit(1);
        }
        System.out.println("all checks passed");
    }

    private static void refused(String what, byte[] data, boolean anyList, String reason) {
        try {
            GamePack reader = new GamePack(new ByteArrayInputStream(data), anyList);
            reader.manifest();
            reader.install(Files.createTempDirectory("gamepack").toFile(), null, null);
            fail(what + ": accepted");
        } catch (GamePack.Refused refusal) {
            check(what + " refused (" + refusal.getMessage() + ")", refusal.getMessage().contains(reason), true);
        } catch (IOException other) {
            fail(what + ": " + other);
        }
    }

    private static void refusedInto(String what, byte[] data, File dir, String reason) {
        try {
            GamePack reader = new GamePack(new ByteArrayInputStream(data), true);
            reader.install(dir, null, null);
            fail(what + ": accepted");
        } catch (GamePack.Refused refusal) {
            check(what + " refused (" + refusal.getMessage() + ")", refusal.getMessage().contains(reason), true);
        } catch (IOException other) {
            fail(what + ": " + other);
        }
    }

    /** Where the data of archive {@code index} starts in the tar: header blocks and padded data before it. */
    private static int offsetOf(byte[] pack, GamePack.Manifest manifest, int index) throws IOException {
        long offset = 512 + padded(manifestSize(pack));
        for (int i = 0; i < index; i++) offset += 512 + padded(manifest.archives.get(i).size);
        return (int) (offset + 512);
    }

    private static long manifestSize(byte[] pack) {
        String size = new String(pack, 124, 11).trim();
        return Long.parseLong(size, 8);
    }

    private static long padded(long size) {
        return (size + 511) / 512 * 512;
    }

    private static boolean isIn(File cdn, String archive, String name) throws IOException {
        try (ZipFile zip = new ZipFile(new File(cdn, archive))) {
            return zip.getEntry(name) != null;
        }
    }

    private static byte[] read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[65536];
        for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
        return out.toByteArray();
    }

    private static void check(String what, Object actual, Object expected) {
        if (actual.equals(expected)) System.out.println("ok   " + what);
        else fail(what + ": got " + actual + ", expected " + expected);
    }

    private static void fail(String message) {
        failures++;
        System.out.println("FAIL " + message);
    }
}
