package reflipped.shell.service;

import org.json.JSONArray;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Set;

import reflipped.shell.pinball.LayerRecord;

/**
 * SH-29: builds a server data pack the way Local play does ({@link DataPackBuilder} with {@link LayerRecord#baseFile})
 * from game files laid out by datapack-build-test.sh, and checks the refusals. Prints the folder of the good pack, for
 * the script to open with the server's own check.
 *
 *   DataPackHarness <bundle zip> <game root> <work dir> <pinned masters digest>
 */
public final class DataPackHarness {
    private static int failures = 0;

    public static void main(String[] args) throws Exception {
        File bundle = new File(args[0]), root = new File(args[1]), work = new File(args[2]);
        String pin = args[3];
        File assetDir = new File(root, "download");

        // 1. the files as a phone leaves them: one master changed by a layer (original kept), one as its shortened twin
        File good = new File(work, "pack-good");
        DataPackBuilder.Built built = build(bundle, root, assetDir, good);
        JSONArray files = built.manifest.getJSONArray("files");
        check(pin.equals(DataPackBuilder.mastersDigest(files)), "the masters digest is the pinned one");
        check(built.missingOptional.isEmpty(), "no optional file missing: " + built.missingOptional);

        // 2. without the record the layer's copy is taken, and the pin tells
        File record = new File(root, "reflipped-layers.txt");
        File saved = new File(work, "record.saved");
        Files.copy(record.toPath(), saved.toPath());
        record.delete();
        built = build(bundle, root, assetDir, new File(work, "pack-norecord"));
        check(!pin.equals(DataPackBuilder.mastersDigest(built.manifest.getJSONArray("files"))),
                "without the record the layer's copy changes the masters digest");
        Files.copy(saved.toPath(), record.toPath());

        // 3. a required table missing: refused with a reason
        String member = firstRequiredMember(bundle);
        File file = LayerRecord.baseFile(root, assetDir, LayerRecord.read(root), member);
        File aside = new File(work, "aside");
        Files.move(file.toPath(), aside.toPath());
        try {
            build(bundle, root, assetDir, new File(work, "pack-missing"));
            check(false, "a missing required table is refused");
        } catch (DataPackBuilder.Refused refused) {
            check(refused.getMessage().contains("incomplete"), "refused: " + refused.getMessage());
        }
        Files.move(aside.toPath(), file.toPath());

        // 4. a bundle without the source can't build
        File empty = new File(work, "empty.zip");
        try (java.util.zip.ZipOutputStream zip = new java.util.zip.ZipOutputStream(new FileOutputStream(empty))) {
            zip.putNextEntry(new java.util.zip.ZipEntry("server.js"));
            zip.closeEntry();
        }
        check(!DataPackBuilder.available(new FileInputStream(empty)), "a bundle without datapack-source/ can't build");
        check(DataPackBuilder.available(new FileInputStream(bundle)), "the test bundle can");

        if (failures > 0) {
            System.err.println(failures + " check(s) failed");
            System.exit(1);
        }
        System.out.println(good.getPath());
    }

    private static DataPackBuilder.Built build(File bundle, File root, File assetDir, File out) throws Exception {
        Set<String> changed = LayerRecord.read(root);
        return DataPackBuilder.build(new FileInputStream(bundle), m -> LayerRecord.baseFile(root, assetDir, changed, m),
                out, null);
    }

    private static String firstRequiredMember(File bundle) throws IOException {
        try (java.util.zip.ZipFile zip = new java.util.zip.ZipFile(bundle)) {
            String text = new String(readAll(zip.getInputStream(zip.getEntry("datapack-source/source.json"))), "UTF-8");
            JSONArray files = new org.json.JSONObject(text).getJSONArray("files");
            for (int i = 0; i < files.length(); i++)
                if (files.getJSONObject(i).getBoolean("required")) return files.getJSONObject(i).getString("member");
        }
        throw new IllegalStateException("no required file");
    }

    private static byte[] readAll(java.io.InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
        return out.toByteArray();
    }

    private static void check(boolean ok, String what) {
        System.out.println((ok ? "ok   " : "FAIL ") + what);
        if (!ok) failures++;
    }
}
