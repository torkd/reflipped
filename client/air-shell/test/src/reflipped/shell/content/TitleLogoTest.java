package reflipped.shell.content;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Enumeration;
import java.util.Random;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import javax.imageio.ImageIO;

/**
 * SH-24: the title logo's REFLIPPED line drawn on the phone (LogoStamp, PngWriter, BundleLogo and the storage check
 * in GameFiles) on a desktop JVM, with made-up images and bundles; no game files. Args: scratch dir. Optionally
 * also: a real bundle.zip, and the same bundle stamped by tools/make_logo.py, to compare the two logos pixel by pixel
 * (only on the maintainer's machine; nothing of them is kept).
 */
public final class TitleLogoTest {
    private static int failures;
    private static final int W = LogoStamp.WIDTH, H = LogoStamp.HEIGHT;
    private static final BundleLogo.PngDecoder IMAGEIO = TitleLogoTest::decode;

    public static void main(String[] args) throws Exception {
        File scratch = new File(args[0]);
        image();
        png();
        bundles(new File(scratch, "bundles"));
        if (args.length >= 3) real(new File(args[1]), new File(args[2]), new File(scratch, "real"));
        if (failures > 0) {
            System.out.println(failures + " check(s) failed");
            System.exit(1);
        }
        System.out.println("all checks passed");
    }

    // ---------------------------------------------------------------- a made-up logo

    /**
     * A made-up "logo" of the right size: a light panel with dark blocks with holes where make_logo.py cuts its
     * letters, a blue "bolt" in the columns whose tail is faded, and transparency below.
     */
    static int[] madeUpLogo() {
        int[] px = new int[W * H];
        fill(px, 10, 250, 910, 530, 0xFFF0E8D0);  // the panel
        int[][] boxes = {{426, 296, 499, 415}, {559, 296, 634, 415}, {258, 412, 324, 510}, {326, 412, 381, 510},
                {381, 412, 407, 510}, {413, 412, 482, 510}, {555, 412, 624, 510}};
        for (int[] b : boxes) {
            fill(px, b[0] + 4, b[1] + 6, b[2] - 4, b[3] - 6, 0xFF101018);           // ink
            fill(px, b[0] + 12, b[1] + 20, b[2] - 12, b[1] + 40, 0xFFF0E8D0);      // a counter in it
            fill(px, b[0] + 4, b[3] - 20, b[0] + 10, b[3] - 6, 0x80202060);        // a half-transparent bit
        }
        fill(px, 600, 300, 660, H, 0xFF3080FF);  // the bolt, down to the bottom edge
        return px;
    }

    private static void fill(int[] px, int x0, int y0, int x1, int y1, int argb) {
        for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) px[y * W + x] = argb;
    }

    private static void image() {
        int[] logo = madeUpLogo();
        int[] copy = logo.clone();
        int[] out = LogoStamp.stamp(logo, W, H);
        check("stamp: an image of the logo's size", out != null && out.length == W * H);
        check("stamp: the input is left as it is", Arrays.equals(logo, copy));
        if (out == null) return;
        int[][] areas = LogoStamp.changedAreas(logo, W);
        int[] word = areas[0];
        check("stamp: the line sits under the logo, centred on x 460",
                word[1] == 542 && Math.abs((word[0] + word[2]) / 2 - 460) <= 1 && word[2] - word[0] > 300);
        int changedInWord = 0, changedElsewhere = 0, orange = 0, ink = 0, white = 0;
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                int i = y * W + x;
                boolean inWord = inside(word, x, y), inBolt = inside(areas[1], x, y);
                if (out[i] != logo[i]) {
                    if (inWord) changedInWord++;
                    else if (!inBolt) changedElsewhere++;
                }
                if (inWord && out[i] == 0xFFFF961E) orange++;
                if (inWord && out[i] == 0xFF0E0618) ink++;
                if (inWord && out[i] == 0xFFFFFFFF) white++;
            }
        }
        System.out.println("  word area " + Arrays.toString(word) + ": " + changedInWord + " pixels changed, " + orange
                + " orange, " + ink + " ink, " + white + " white");
        check("stamp: pixels change in the word's area", changedInWord > 5000);
        check("stamp: nothing changes outside the word and the bolt's tail", changedElsewhere == 0);
        check("stamp: orange \"RE\", dark \"FLIPPED\" and outline, white rim", orange > 300 && ink > 1000 && white > 1000);
        check("stamp: the bolt's tail below y 560 is gone (outside the word)",
                (out[660 * W + 610] >>> 24) == 0 && (out[680 * W + 650] >>> 24) == 0);
        check("stamp: the bolt fades between y 470 and 560", (out[465 * W + 610] >>> 24) == 255
                && (out[515 * W + 610] >>> 24) > 0 && (out[515 * W + 610] >>> 24) < 255);
        check("stamp: the same input, the same output", Arrays.equals(out, LogoStamp.stamp(logo, W, H)));
        check("stamp: another size is refused", LogoStamp.stamp(new int[(W - 1) * H], W - 1, H) == null
                && LogoStamp.stamp(new int[W * (H + 1)], W, H + 1) == null);
    }

    private static boolean inside(int[] box, int x, int y) {
        return x >= box[0] && y >= box[1] && x < box[2] && y < box[3];
    }

    private static void png() throws IOException {
        Random random = new Random(24);
        int[] px = new int[300 * 200];
        for (int i = 0; i < px.length; i++) px[i] = i % 7 == 0 ? random.nextInt() : (i / 300) << 24 | 0x00ff8040;
        byte[] png = PngWriter.encode(px, 300, 200);
        int[] back = decode(png, 300, 200);
        check("PngWriter: ImageIO reads back the exact pixels", Arrays.equals(px, back));
    }

    // ---------------------------------------------------------------- bundles

    private static final String SWF = "assets/worldflipper_android_release.swf";

    private static void bundles(File root) throws Exception {
        Random random = new Random(2024);
        byte[] logoPng = lowercase(PngWriter.encode(madeUpLogo(), W, H));

        // the stored layout of the game's bundle (folders, STORED entries), and a deflated one
        for (boolean deflated : new boolean[] {false, true}) {
            String kind = deflated ? "deflated" : "stored";
            byte[] bundle = zip(deflated, random, logoPng);
            GameFiles files = setUp(new File(root, kind), bundle);
            File bundleFile = new File(files.storage, BundleLogo.BUNDLE);
            File sha1File = new File(files.storage, BundleLogo.SHA1);
            BundleLogo logo = new BundleLogo(files);
            check(kind + ": ready before", files.state() == GameFiles.State.READY);
            check(kind + ": a fresh import needs the line", logo.pending(false));
            BundleLogo.Result result = logo.apply(IMAGEIO, true);
            System.out.println("  " + kind + ": " + result);
            check(kind + ": stamped", result.outcome == BundleLogo.Outcome.STAMPED);
            byte[] stamped = Files.readAllBytes(bundleFile.toPath());
            check(kind + ": bundle.zip changed", stamped.length != bundle.length);
            check(kind + ": still ready with the new size (no re-import)", files.state() == GameFiles.State.READY);
            check(kind + ": bundle.zip.sha1 is the new bundle's SHA-1",
                    new String(Files.readAllBytes(sha1File.toPath()), StandardCharsets.US_ASCII).equals(sha1(stamped)));
            check(kind + ": a staging file isn't left", !new File(files.storage, "bundle.zip.new").exists()
                    && !new File(files.storage, "bundle.zip.sha1.new").exists());
            sameEntries(kind, bundle, stamped, bundleFile);
            byte[] newLogo = entry(stamped, BundleLogo.ENTRY);
            check(kind + ": the logo keeps the lowercase magic", newLogo[1] == 'p' && newLogo[2] == 'n' && newLogo[3] == 'g');
            int[] expected = LogoStamp.stamp(madeUpLogo(), W, H);
            check(kind + ": the logo entry holds the stamped image", Arrays.equals(decode(uppercase(newLogo), W, H), expected));

            check(kind + ": nothing left to do", !logo.pending(true));
            check(kind + ": a second run changes nothing", logo.apply(IMAGEIO, true).outcome == BundleLogo.Outcome.DONE
                    && Arrays.equals(Files.readAllBytes(bundleFile.toPath()), stamped));

            files.invalidate();
            check(kind + ": game.swf damaged: re-patch, not import (the stamped size counts)",
                    files.state() == GameFiles.State.REPATCH);
            restoreGameState(files);
            check(kind + ": restored", files.state() == GameFiles.State.READY);

            // killed after the record, before the rename: the game's own bundle with a record saying "stamped"
            Files.write(bundleFile.toPath(), bundle);
            check(kind + ": interrupted before the rename: ready", files.state() == GameFiles.State.READY);
            check(kind + ": interrupted before the rename: stamped again", logo.pending(false)
                    && logo.apply(IMAGEIO, false).outcome == BundleLogo.Outcome.STAMPED
                    && Arrays.equals(Files.readAllBytes(bundleFile.toPath()), stamped));
            // killed after the rename, before the .sha1
            Files.write(sha1File.toPath(), "0123456789abcdef0123456789abcdef01234567".getBytes(StandardCharsets.US_ASCII));
            check(kind + ": interrupted before the .sha1: only that is written", logo.pending(false)
                    && logo.apply(IMAGEIO, false).outcome == BundleLogo.Outcome.STAMPED
                    && sha1(stamped).equals(new String(Files.readAllBytes(sha1File.toPath()), StandardCharsets.US_ASCII))
                    && Arrays.equals(Files.readAllBytes(bundleFile.toPath()), stamped));

            files.clear();
            check(kind + ": game folder cleared: the stamped bundle isn't accepted any more",
                    files.state() == GameFiles.State.IMPORT);
        }

        // bundles that must be left alone
        notLogo(root, "logo of another size", zipWith(random, lowercase(PngWriter.encode(new int[(W - 1) * H], W - 1, H))), IMAGEIO);
        notLogo(root, "logo with the standard PNG magic", zipWith(random, uppercase(logoPng)), IMAGEIO);
        notLogo(root, "no logo entry", zipWith(random, null), IMAGEIO);
        byte[] junk = new byte[50000];
        random.nextBytes(junk);
        notLogo(root, "not a zip", junk, IMAGEIO);
        notLogo(root, "a logo the decoder can't read", zipWith(random, logoPng), (png, w, h) -> null);

        // a failure (here the decoder throws) leaves the bundle, and a plain start doesn't try again; an import does
        GameFiles files = setUp(new File(root, "failing"), zipWith(random, logoPng));
        BundleLogo logo = new BundleLogo(files);
        byte[] before = Files.readAllBytes(new File(files.storage, BundleLogo.BUNDLE).toPath());
        BundleLogo.Result failed = logo.apply((png, w, h) -> {
            throw new IOException("made-up read failure");
        }, true);
        check("failure: reported", failed.outcome == BundleLogo.Outcome.FAILED);
        check("failure: bundle left as it is", Arrays.equals(before, Files.readAllBytes(new File(files.storage, BundleLogo.BUNDLE).toPath())));
        check("failure: a plain start doesn't retry, an import or re-patch does", !logo.pending(false) && logo.pending(true));
        check("failure: still ready", files.state() == GameFiles.State.READY);
        check("failure: the retry stamps", logo.apply(IMAGEIO, true).outcome == BundleLogo.Outcome.STAMPED
                && files.state() == GameFiles.State.READY);
    }

    private static void notLogo(File root, String name, byte[] bundle, BundleLogo.PngDecoder decoder) throws Exception {
        GameFiles files = setUp(new File(root, name.replace(' ', '-')), bundle);
        File bundleFile = new File(files.storage, BundleLogo.BUNDLE);
        File sha1File = new File(files.storage, BundleLogo.SHA1);
        byte[] sha1Before = Files.readAllBytes(sha1File.toPath());
        BundleLogo logo = new BundleLogo(files);
        BundleLogo.Result result = logo.apply(decoder, true);
        System.out.println("  " + name + ": " + result);
        check(name + ": left alone", result.outcome == BundleLogo.Outcome.NOT_LOGO
                && Arrays.equals(bundle, Files.readAllBytes(bundleFile.toPath()))
                && Arrays.equals(sha1Before, Files.readAllBytes(sha1File.toPath()))
                && !new File(files.storage, "bundle.zip.new").exists());
        check(name + ": not looked at again", !logo.pending(true));
        check(name + ": still ready", files.state() == GameFiles.State.READY);
    }

    /** A storage with a finished import whose bundle.zip is `bundle` (made-up SWFs; only sizes and hashes matter). */
    private static GameFiles setUp(File storage, byte[] bundle) throws Exception {
        GameFiles.deleteTree(storage);
        File dir = new File(storage, GameFiles.DIR);
        if (!dir.mkdirs()) throw new IOException("can't create " + dir);
        byte[] original = "original swf".getBytes(StandardCharsets.US_ASCII);
        byte[] game = "patched game swf".getBytes(StandardCharsets.US_ASCII);
        byte[] sha1 = sha1(bundle).getBytes(StandardCharsets.US_ASCII);  // 40 hex digits, like the game's
        String text = "format=1\ngame.package=com.example.game\ngame.version=0.0.81\n"
                + "entry.0.name=" + SWF + "\nentry.0.size=" + original.length + "\nentry.0.sha256=" + sha256(original) + "\n"
                + "entry.1.name=assets/bundle.zip\nentry.1.size=" + bundle.length + "\nentry.1.sha256=" + sha256(bundle) + "\n"
                + "entry.2.name=assets/bundle.zip.sha1\nentry.2.size=" + sha1.length + "\nentry.2.sha256=" + sha256(sha1) + "\n"
                + "swf.entry=" + SWF + "\nswf.ops=swf.ops\nswf.ops.sha256=" + sha256(new byte[1]) + "\n"
                + "swf.input.size=1\nswf.input.sha256=" + sha256(new byte[2]) + "\n"
                + "swf.output.size=" + game.length + "\nswf.output.sha256=" + sha256(game) + "\n";
        ImportManifest manifest = ImportManifest.read(new ByteArrayInputStream(text.getBytes(StandardCharsets.ISO_8859_1)));
        GameFiles files = new GameFiles(storage, manifest);
        Files.write(new File(dir, GameFiles.ORIGINAL).toPath(), original);
        Files.write(new File(dir, GameFiles.GAME).toPath(), game);
        files.writeState(dir, "test");
        Files.write(new File(storage, BundleLogo.BUNDLE).toPath(), bundle);
        Files.write(new File(storage, BundleLogo.SHA1).toPath(), sha1);
        return files;
    }

    private static void restoreGameState(GameFiles files) throws IOException {
        Files.write(files.game().toPath(), "patched game swf".getBytes(StandardCharsets.US_ASCII));
        files.writeState(files.dir(), "test");
    }

    /** A made-up bundle laid out like the game's: folder entries, files before and after the logo. */
    private static byte[] zip(boolean deflated, Random random, byte[] logo) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(bytes)) {
            put(z, "production/", new byte[0], deflated);
            put(z, "production/bundle/", new byte[0], deflated);
            for (int i = 0; i < 6; i++) put(z, "production/bundle/aa/" + i, randomBytes(random, 3000 + i * 1000), deflated);
            put(z, "production/bundle/ec/", new byte[0], deflated);
            if (logo != null) put(z, BundleLogo.ENTRY, logo, deflated);
            for (int i = 0; i < 6; i++) put(z, "production/medium_bundle/" + i, randomBytes(random, 2000 + i * 700), deflated);
        }
        return bytes.toByteArray();
    }

    private static byte[] zipWith(Random random, byte[] logo) throws IOException {
        return zip(false, random, logo);
    }

    private static void put(ZipOutputStream z, String name, byte[] data, boolean deflated) throws IOException {
        ZipEntry e = new ZipEntry(name);
        if (!deflated || name.endsWith("/")) {
            e.setMethod(ZipEntry.STORED);
            e.setSize(data.length);
            e.setCompressedSize(data.length);
            CRC32 crc = new CRC32();
            crc.update(data);
            e.setCrc(crc.getValue());
        } else {
            e.setMethod(ZipEntry.DEFLATED);  // written with a data descriptor
        }
        z.putNextEntry(e);
        z.write(data);
        z.closeEntry();
    }

    private static byte[] randomBytes(Random random, int n) {
        byte[] b = new byte[n];
        random.nextBytes(b);
        return b;
    }

    /** Every entry but the logo is the same, in the same order, by central directory and by local headers. */
    private static void sameEntries(String kind, byte[] before, byte[] after, File afterFile) throws IOException {
        boolean same = true;
        int count = 0;
        try (ZipFile z = new ZipFile(afterFile)) {
            Enumeration<? extends ZipEntry> all = z.entries();
            while (all.hasMoreElements()) {
                ZipEntry e = all.nextElement();
                count++;
                byte[] data = readAll(z.getInputStream(e));
                if (!e.getName().equals(BundleLogo.ENTRY)) same &= Arrays.equals(data, entry(before, e.getName()));
            }
        }
        int streamed = 0;
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(after))) {
            ZipEntry e;
            while ((e = z.getNextEntry()) != null) {
                byte[] data = readAll(z);
                if (!e.getName().equals(BundleLogo.ENTRY)) same &= Arrays.equals(data, entry(before, e.getName()));
                streamed++;
            }
        }
        check(kind + ": every other entry unchanged (central directory and local headers)",
                same && count == streamed && count == entryCount(before));
    }

    private static int entryCount(byte[] zip) throws IOException {
        int n = 0;
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(zip))) {
            while (z.getNextEntry() != null) n++;
        }
        return n;
    }

    private static byte[] entry(byte[] zip, String name) throws IOException {
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(zip))) {
            ZipEntry e;
            while ((e = z.getNextEntry()) != null) if (e.getName().equals(name)) return readAll(z);
        }
        return null;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
        return out.toByteArray();
    }

    // ---------------------------------------------------------------- the maintainer's real bundle (optional)

    private static void real(File bundle, File reference, File scratch) throws Exception {
        byte[] data = Files.readAllBytes(bundle.toPath());
        GameFiles files = setUp(scratch, data);
        long t0 = System.nanoTime();
        BundleLogo.Result result = new BundleLogo(files).apply(IMAGEIO, true);
        System.out.println("  real bundle: " + result + " in " + (System.nanoTime() - t0) / 1000000 + " ms");
        check("real bundle: stamped", result.outcome == BundleLogo.Outcome.STAMPED);
        byte[] ours = entry(Files.readAllBytes(new File(scratch, BundleLogo.BUNDLE).toPath()), BundleLogo.ENTRY);
        byte[] theirs = entry(Files.readAllBytes(reference.toPath()), BundleLogo.ENTRY);
        int[] a = decode(uppercase(ours), W, H), b = decode(uppercase(theirs), W, H);
        int differing = 0;
        for (int i = 0; i < a.length; i++) if (a[i] != b[i]) differing++;
        System.out.println("  real bundle: " + differing + " pixels differ from make_logo.py's");
        check("real bundle: the same logo as make_logo.py's", differing == 0);
        GameFiles.deleteTree(scratch);
    }

    // ---------------------------------------------------------------- helpers

    static int[] decode(byte[] png, int width, int height) throws IOException {
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
        if (image == null || image.getWidth() != width || image.getHeight() != height) return null;
        return image.getRGB(0, 0, width, height, null, 0, width);
    }

    private static byte[] lowercase(byte[] png) {
        byte[] out = png.clone();
        out[1] = 'p';
        out[2] = 'n';
        out[3] = 'g';
        return out;
    }

    private static byte[] uppercase(byte[] png) {
        byte[] out = png.clone();
        out[1] = 'P';
        out[2] = 'N';
        out[3] = 'G';
        return out;
    }

    private static String sha1(byte[] data) throws Exception {
        return Hashes.hex(MessageDigest.getInstance("SHA-1").digest(data));
    }

    private static String sha256(byte[] data) {
        return Hashes.hex(Hashes.sha256(data));
    }

    private static void check(String name, boolean ok) {
        System.out.println((ok ? "ok   " : "FAIL ") + name);
        if (!ok) failures++;
    }
}
