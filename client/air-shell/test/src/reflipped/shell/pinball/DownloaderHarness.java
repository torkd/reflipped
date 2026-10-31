package reflipped.shell.pinball;

import java.util.ArrayList;
import java.util.List;
import reflipped.shell.common.StubContext;

public class DownloaderHarness {
    public static void main(String[] a) throws Exception {
        String cdn = a[0], dir = a[1], partial = a[2];
        List<AssetDownloader.Archive> list = new ArrayList<>();
        for (int i = 3; i + 1 < a.length; i += 2) list.add(new AssetDownloader.Archive(a[i].replace("{$cdnAddress}", cdn), Long.parseLong(a[i + 1])));
        StubContext ctx = new StubContext();
        AssetDownloader d = new AssetDownloader(ctx, list, dir, partial, 30000, 300000, "");
        long t = System.currentTimeMillis();
        d.start();
        while (ctx.lastCode == null) Thread.sleep(50);
        System.out.printf("ratio=%.3f progressEvents=%d time=%dms%n", d.progressRatio(), ctx.progressEvents, System.currentTimeMillis() - t);
        check("production/android_medium_upload/hash/07/97a7b82da2315ea1a96a25e186cb30e6e187ef.hash", AssetDownloader.shortenedToActual("production/android_medium_upload/hash/07/97a7b82da2315ea1a96a25e186cb30e6e187ef.hash"), "production/android_medium_upload/07/97a7b82da2315ea1a96a25e186cb30e6e187ef");
        check("actual", AssetDownloader.actualToShortened("production/upload/08/15638a7d270d06e5b69692e099467fb571881c"), "production/upload/hash/08/15638a7d270d06e5b69692e099467fb571881c.hash");
        System.exit(0);
    }
    static void check(String what, String got, String want) {
        System.out.println((want.equals(got) ? "OK   " : "FAIL ") + what + " -> " + got);
    }
}
