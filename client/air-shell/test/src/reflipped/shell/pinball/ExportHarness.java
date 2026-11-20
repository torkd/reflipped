package reflipped.shell.pinball;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/** SH-29 desktop test: extracts base and layer archives, exports a format 2 pack, installs one. */
public class ExportHarness {
    public static void main(String[] a) throws Exception {
        File root = new File(a[1]);
        File assets = new File(root, "download");
        switch (a[0]) {
            case "start":
                LayerRecord.start(root);
                break;
            case "start-v1":
                root.mkdirs();
                try (OutputStream out = new FileOutputStream(new File(root, LayerRecord.NAME))) {
                    out.write((LayerRecord.HEADER_V1 + "\n").getBytes("UTF-8"));
                }
                break;
            case "extract": { // extract <root> <zip> [layer]
                ArchiveExtractor extractor = new ArchiveExtractor(assets);
                LayerRecord.Keeper keeper = a.length > 3 ? LayerRecord.keeper(root) : null;
                extractor.touch = keeper;
                try (InputStream in = new FileInputStream(a[2])) {
                    extractor.extract(in, null);
                }
                if (keeper != null) keeper.close();
                break;
            }
            case "export": // export <root> <lang> <out.tar>
                try {
                    GameFilesExport.Plan plan = GameFilesExport.plan(root, assets, a[2], true);
                    try (OutputStream out = new BufferedOutputStream(new FileOutputStream(a[3]))) {
                        GameFilesExport.write(plan, out, null, null, true);
                    }
                    System.out.println("OK " + plan.files.size());
                } catch (GamePack.Refused refused) {
                    System.out.println("REFUSED " + refused.getMessage());
                }
                break;
            case "install": // install <root> <tar>
                try (InputStream in = new BufferedInputStream(new FileInputStream(a[2]))) {
                    GamePack pack = new GamePack(in, true);
                    GamePack.Manifest m = pack.manifest();
                    System.out.println(pack.install(assets, null, null) ? "OK " + m.format + " " + m.files : "STOPPED");
                } catch (GamePack.Refused refused) {
                    System.out.println("REFUSED " + refused.getMessage());
                }
                break;
            default:
                throw new IllegalArgumentException(a[0]);
        }
    }
}
