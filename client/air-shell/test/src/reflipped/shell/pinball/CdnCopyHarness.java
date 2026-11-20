package reflipped.shell.pinball;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Desktop check of installing a copy of the {@code .cdn} folder (SH-29, {@link CdnCopy}) from the copies
 * client/air-shell/test/make_cdn_copies.py makes: each tar and zip installs files identical to the archives' own, a
 * pack is recognised as one, and a compressed, cut-short or damaged copy is refused with its reason.
 *
 *   java CdnCopyHarness <copies dir> <cdn dir> <pack.tar> <work dir>
 */
public final class CdnCopyHarness {
    private static int failures;
    private static File copies;

    public static void main(String[] args) throws Exception {
        copies = new File(args[0]);
        File cdn = new File(args[1]);
        File pack = new File(args[2]);
        File work = new File(args[3]);
        GamePack.Manifest list;
        try (InputStream in = new FileInputStream(new File(copies, "list.tsv"))) {
            list = GamePack.list("en", in, true);
        }
        // the short list isn't an official one
        try (InputStream in = new FileInputStream(new File(copies, "list.tsv"))) {
            GamePack.officialList("en", in);
            fail("a short list passed as official");
        } catch (GamePack.Refused refused) {
            check("a short list isn't official", refused.getMessage().contains("damaged"), true);
        }

        Map<String, byte[]> expected = new HashMap<>();
        for (GamePack.Archive archive : list.archives) {
            try (ZipFile zip = new ZipFile(new File(cdn, archive.path))) {
                for (Enumeration<? extends ZipEntry> e = zip.entries(); e.hasMoreElements(); ) {
                    ZipEntry entry = e.nextElement();
                    if (entry.isDirectory() || entry.getName().equals(".removed.csv")) continue;
                    expected.put(entry.getName(), read(zip.getInputStream(entry)));
                }
            }
        }

        for (String name : new String[]{"cdn-pax.tar", "cdn-gnu.tar", "cdn.zip", "cdn64.zip"}) {
            File out = new File(work, name);
            try (FileChannel channel = open(new File(copies, name))) {
                CdnCopy copy = CdnCopy.open(channel);
                check(name + ": not a pack", copy.isPack(), false);
                check(name + ": nothing missing", copy.missing(list), 0);
                long[] reported = {0};
                check(name + ": installs", copy.install(list, out, (done, total) -> reported[0] = done, null), true);
                check(name + ": progress reaches the total", reported[0], list.totalSize);
            }
            int same = 0;
            for (Map.Entry<String, byte[]> file : expected.entrySet()) {
                File written = new File(out, file.getKey());
                if (written.isFile() && Arrays.equals(Files.readAllBytes(written.toPath()), file.getValue())) same++;
                else System.out.println("FAIL " + name + " differs: " + file.getKey());
            }
            check(name + ": files identical to the archives' entries (" + same + ")", same, expected.size());
            check(name + ": nothing of another language or platform", new File(out, "not this language").exists(), false);
        }

        try (FileChannel channel = open(pack)) {
            check("a game data pack is recognised", CdnCopy.open(channel).isPack(), true);
        }
        refused("cdn.tar.gz", list, "compressed");
        refused("cut.tar", list, "incomplete");
        refused("damaged.zip", list, "doesn't match");
        refused("list.tsv", list, "isn't a game data pack");

        if (failures > 0) {
            System.out.println(failures + " check(s) failed");
            System.exit(1);
        }
        System.out.println("all checks passed");
    }

    private static FileChannel open(File file) throws IOException {
        return new RandomAccessFile(file, "r").getChannel();
    }

    private static void refused(String name, GamePack.Manifest list, String reason) throws IOException {
        try (FileChannel channel = open(new File(copies, name))) {
            CdnCopy copy = CdnCopy.open(channel);
            copy.install(list, Files.createTempDirectory("cdncopy").toFile(), null, null);
            fail(name + ": accepted");
        } catch (GamePack.Refused refusal) {
            check(name + " refused (" + refusal.getMessage() + ")", refusal.getMessage().contains(reason), true);
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
