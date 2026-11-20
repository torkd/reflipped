package reflipped.shell.service;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.text.TextUtils;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * The server's code in the APK and its unpacked copy. build.py puts the bundle ({@code npm run bundle}: server.js,
 * build-info.json, web/, and datapack-assets-digest.txt, the data pack it accepts) into the APK as the AIR application file {@value #ASSET}, a zip of stored
 * entries (the APK compresses it). The service unpacks it into {@code <files>/server}, the server's working directory,
 * on the first start and again after every install or update of the app. The data there ({@code .database/}, the data
 * pack in {@code datapack/}) is never touched: only the names the previous unpack wrote are removed first.
 */
final class ServerBundle {
    static final String ASSET = "reflipped-server.zip";
    private static final String MARK = ".bundle", FILES = ".bundle-files";

    private ServerBundle() {}

    static File root(Context context) {
        return new File(context.getFilesDir(), "server");
    }

    /**
     * Whether this build carries the server (build.py --no-node leaves it out); an installed APK can't change under a
     * running process, so the answer is kept.
     */
    static boolean inBuild(Context context) {
        Boolean known = inBuild;
        if (known != null) return known;
        boolean found;
        try (InputStream in = context.getAssets().open(ASSET)) {
            found = true;
        } catch (Exception missing) {
            found = false;
        }
        inBuild = found;
        return found;
    }

    private static volatile Boolean inBuild;

    /** Which bundle the installed app carries: its version code and install time, which every update changes. */
    static String id(Context context) throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        @SuppressWarnings("deprecation") long code = info.versionCode;
        return code + "-" + info.lastUpdateTime;
    }

    /** Unpacks the bundle unless the copy in {@link #root} is this install's already. Returns {@link #id}. */
    static String unpack(Context context) throws Exception {
        String id = id(context);
        File root = root(context);
        File mark = new File(root, MARK);
        if (id.equals(read(mark)) && new File(root, "server.js").isFile()) return id;
        long started = System.nanoTime();
        if (!root.isDirectory() && !root.mkdirs()) throw new IllegalStateException("can't create " + root);
        // the previous bundle's files go first, so a file a newer bundle dropped doesn't linger
        mark.delete();
        for (String name : read(new File(root, FILES)).split("\n")) {
            if (!name.isEmpty() && !name.contains("/") && !name.startsWith(".")) delete(new File(root, name));
        }
        Set<String> top = new LinkedHashSet<>();
        String canonicalRoot = root.getCanonicalPath() + File.separator;
        long bytes = 0;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(context.getAssets().open(ASSET), 1 << 16))) {
            byte[] buffer = new byte[1 << 16];
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null; ) {
                String name = entry.getName();
                File target = new File(root, name);
                if (!target.getCanonicalPath().startsWith(canonicalRoot) || name.startsWith("."))
                    throw new IllegalStateException("bad entry in the server bundle: " + name);
                top.add(name.split("/", 2)[0]);
                if (entry.isDirectory()) {
                    target.mkdirs();
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs())
                    throw new IllegalStateException("can't create " + parent);
                try (FileOutputStream out = new FileOutputStream(target)) {
                    for (int n; (n = zip.read(buffer)) > 0; ) {
                        out.write(buffer, 0, n);
                        bytes += n;
                    }
                    // on disk before the mark says the unpack is complete: a power cut must not leave a valid mark
                    // over a truncated file
                    out.getFD().sync();
                }
            }
        }
        write(new File(root, FILES), TextUtils.join("\n", top));
        write(mark, id);
        Log.i(ServerService.TAG, "unpacked the server bundle (" + bytes / 1024 + " KB) in "
                + (System.nanoTime() - started) / 1000000 + " ms");
        return id;
    }

    /** Makes the next start unpack again (after the service gave up: the copy on disk may be what is broken). */
    static void invalidate(Context context) {
        new File(root(context), MARK).delete();
    }

    private static void delete(File file) {
        File[] children = file.isDirectory() ? file.listFiles() : null;
        if (children != null) for (File child : children) delete(child);
        file.delete();
    }

    private static String read(File file) {
        if (!file.isFile()) return "";
        try (InputStream in = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int n = 0;
            while (n < bytes.length) {
                int r = in.read(bytes, n, bytes.length - n);
                if (r < 0) break;
                n += r;
            }
            return new String(bytes, 0, n, StandardCharsets.UTF_8).trim();
        } catch (Exception unreadable) {
            return "";
        }
    }

    private static void write(File file, String text) throws Exception {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
    }
}
