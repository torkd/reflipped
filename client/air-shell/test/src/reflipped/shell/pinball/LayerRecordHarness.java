package reflipped.shell.pinball;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.Set;

/** SH-27/SH-29 desktop test: prints the layer record, applies a restore archive as GameFiles.restore does, or puts the kept originals back. */
public class LayerRecordHarness {
    public static void main(String[] a) throws Exception {
        File root = new File(a[1]);
        if (a[0].equals("record")) {
            Set<String> paths = LayerRecord.read(root);
            if (paths == null) System.out.println("NULL");
            else for (String p : paths) System.out.println(p);
        } else if (a[0].equals("restore")) {
            try (InputStream in = new FileInputStream(a[2])) {
                if (!new ArchiveExtractor(new File(root, "download")).extract(in, null)) throw new IllegalStateException("stopped");
            }
            LayerRecord.start(root);
        } else if (a[0].equals("restore-local")) {
            if (!LayerRecord.restoreOriginals(root, new File(root, "download"))) throw new IllegalStateException("no originals kept");
        } else if (a[0].equals("version")) {
            System.out.println(LayerRecord.version(root));
        } else {
            throw new IllegalArgumentException(a[0]);
        }
    }
}
