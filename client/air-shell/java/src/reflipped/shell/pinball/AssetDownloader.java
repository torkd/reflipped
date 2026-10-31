package reflipped.shell.pinball;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import reflipped.shell.common.StubContext;

/**
 * One download run of `pinball.assetDownload`, modelled on the original Kotlin service
 * (pinball.assetDownload.AssetDownloadService in the APK):
 *
 * - archives are fetched one at a time, in list order, because diff archives must be applied on
 *   top of the full set in version order;
 * - each response is a zip streamed straight into the asset dir. A `.removed.csv` entry
 *   (`rowid,path`) lists files to delete. Writing `a/b/c` deletes its shortened twin
 *   `a/hash/b/c.hash` and vice versa;
 * - finished archive URLs and the latest `Last-Modified` go to the partial file (JSON, only read
 *   by us; the game just deletes it), so a restarted download skips what's done;
 * - `progress` is throttled; `completed` carries the latest `Last-Modified`.
 */
final class AssetDownloader {
    static final class Archive {
        final String location;
        final long size;

        Archive(String location, long size) {
            this.location = location;
            this.size = size;
        }
    }

    private static final String TAG = StubContext.TAG;
    private static final long PROGRESS_INTERVAL_MS = 250;

    private final StubContext ctx;
    private final List<Archive> archives;
    private final File assetDir;
    private final File partialFile;
    private final int idleTimeoutMsec;
    private final int totalTimeoutMsec;
    private final String debugOauthKey;
    private final AtomicLong doneBytes = new AtomicLong();
    private final long totalBytes;
    private volatile boolean cancelled;
    private long lastProgressAt;

    private final Set<String> downloadedUrls = new LinkedHashSet<>();
    private String latestModified;

    AssetDownloader(StubContext ctx, List<Archive> archives, String assetDir, String partialFile,
                    int idleTimeoutMsec, int totalTimeoutMsec, String debugOauthKey) {
        this.ctx = ctx;
        this.archives = archives;
        this.assetDir = new File(assetDir);
        this.partialFile = partialFile == null ? null : new File(partialFile);
        this.idleTimeoutMsec = idleTimeoutMsec;
        this.totalTimeoutMsec = totalTimeoutMsec;
        this.debugOauthKey = debugOauthKey;
        long total = 0;
        for (Archive a : archives) total += a.size;
        this.totalBytes = total;
    }

    void start() {
        new Thread(this::run, "reflipped-assets").start();
    }

    void cancel() {
        cancelled = true;
    }

    double progressRatio() {
        return totalBytes <= 0 ? 1.0 : Math.min(1.0, (double) doneBytes.get() / totalBytes);
    }

    private void run() {
        Log.i(TAG, "assetDownload: " + archives.size() + " archives, " + totalBytes + " bytes into " + assetDir
                + " (idle timeout " + idleTimeoutMsec + " ms, total timeout " + totalTimeoutMsec + " ms per archive)");
        try {
            readPartial();
            long done = 0;
            for (Archive a : archives) if (downloadedUrls.contains(a.location)) done += a.size;
            doneBytes.set(done);
            if (done > 0) Log.i(TAG, "assetDownload: resuming, " + downloadedUrls.size() + " archives already done");
            assetDir.mkdirs();

            for (Archive archive : archives) {
                if (cancelled) return;
                if (downloadedUrls.contains(archive.location)) continue;
                long before = doneBytes.get();
                if (!download(archive)) return;
                doneBytes.set(before + archive.size);
                downloadedUrls.add(archive.location);
                writePartial();
                progress(true);
            }
            Log.i(TAG, "assetDownload: completed, latest Last-Modified " + latestModified);
            event("completed", latestModified == null ? "" : latestModified);
        } catch (SocketTimeoutException e) {
            fail("timeout", e);
        } catch (IOException e) {
            fail("ioError", e);
        } catch (Exception e) {
            fail("error", e);
        }
    }

    /** Downloads and extracts one archive; false if the run stopped (error event already sent). */
    private boolean download(Archive archive) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(archive.location).openConnection();
        conn.setConnectTimeout(idleTimeoutMsec);
        conn.setReadTimeout(idleTimeoutMsec);
        if (!debugOauthKey.isEmpty()) conn.setRequestProperty("DEBUG_OAUTH", debugOauthKey);
        int status = conn.getResponseCode();
        if (status != 200) {
            conn.disconnect();
            String message = "HTTP " + status + " " + conn.getResponseMessage() + ": " + archive.location;
            Log.e(TAG, "assetDownload: " + message);
            event("error", message);
            return false;
        }
        noteLastModified(conn);

        // Like the original, close the stream once an archive takes longer than the total timeout.
        final InputStream body = conn.getInputStream();
        Timer watchdog = new Timer("reflipped-assets-timeout", true);
        if (totalTimeoutMsec > 0) {
            watchdog.schedule(new TimerTask() {
                @Override
                public void run() {
                    try {
                        body.close();
                    } catch (IOException ignored) {
                    }
                }
            }, totalTimeoutMsec);
        }
        final long base = doneBytes.get();
        try (ZipInputStream zip = new ZipInputStream(new FilterInputStream(body) {
            private long read;

            @Override
            public int read() throws IOException {
                int b = super.read();
                if (b >= 0) counted(1);
                return b;
            }

            @Override
            public int read(byte[] buf, int off, int len) throws IOException {
                int n = super.read(buf, off, len);
                if (n > 0) counted(n);
                return n;
            }

            private void counted(int n) {
                read += n;
                doneBytes.set(base + Math.min(read, archive.size));
                progress(false);
            }
        })) {
            byte[] buf = new byte[64 * 1024];
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null; ) {
                if (cancelled) return false;
                String name = entry.getName();
                if (name.equals(".removed.csv")) {
                    removeFiles(zip);
                } else if (entry.isDirectory()) {
                    resolve(name).mkdirs();
                } else {
                    File out = resolve(name);
                    out.getParentFile().mkdirs();
                    try (OutputStream os = new FileOutputStream(out)) {
                        for (int n; (n = zip.read(buf)) > 0; ) os.write(buf, 0, n);
                    }
                    String twin = isShortened(name) ? shortenedToActual(name) : actualToShortened(name);
                    if (twin != null) resolve(twin).delete();
                }
                zip.closeEntry();
            }
        } finally {
            watchdog.cancel();
            conn.disconnect();
        }
        return !cancelled;
    }

    /** `.removed.csv`: a `rowid,path` header, then one asset path per row. */
    private void removeFiles(InputStream entry) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(entry, StandardCharsets.UTF_8));
        int removed = 0;
        for (String line; (line = reader.readLine()) != null; ) {
            int comma = line.indexOf(',');
            String path = (comma >= 0 ? line.substring(comma + 1) : line).trim();
            if (path.isEmpty() || line.startsWith("rowid,")) continue;
            if (resolve(path).delete()) removed++;
        }
        Log.i(TAG, "assetDownload: .removed.csv deleted " + removed + " files");
    }

    /** Resolves an archive path inside the asset dir, refusing anything that escapes it. */
    private File resolve(String name) throws IOException {
        File file = new File(assetDir, name);
        String root = assetDir.getCanonicalPath() + File.separator;
        if (!file.getCanonicalPath().startsWith(root)) throw new IOException("archive entry outside asset dir: " + name);
        return file;
    }

    // Same rules as the game's own (AS3) and the original ANE's AssetShortenedTools.
    static boolean isShortened(String path) {
        return path.endsWith(".hash");
    }

    static String shortenedToActual(String path) {
        String r = path.replaceFirst("^(.*)/hash/([^/]+/[^/]+)\\.hash$", "$1/$2");
        return r.equals(path) ? null : r;
    }

    static String actualToShortened(String path) {
        String r = path.replaceFirst("^(.*)/([^/]+/[^/]+)$", "$1/hash/$2.hash");
        return r.equals(path) ? null : r;
    }

    private void noteLastModified(HttpURLConnection conn) throws IOException {
        String header = conn.getHeaderField("Last-Modified");
        if (header == null) return;
        long time = conn.getHeaderFieldDate("Last-Modified", 0);
        long known = latestModified == null ? -1 : parseHttpDate(latestModified);
        if (time > known) {
            latestModified = header;
            writePartial();
        }
    }

    private static long parseHttpDate(String value) {
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", java.util.Locale.US);
            return f.parse(value).getTime();
        } catch (Exception e) {
            return 0;
        }
    }

    private void readPartial() {
        if (partialFile == null || !partialFile.exists()) return;
        try {
            byte[] data = new byte[(int) partialFile.length()];
            try (InputStream in = new java.io.FileInputStream(partialFile)) {
                int off = 0;
                for (int n; off < data.length && (n = in.read(data, off, data.length - off)) > 0; ) off += n;
            }
            JSONObject json = new JSONObject(new String(data, StandardCharsets.UTF_8));
            JSONArray urls = json.optJSONArray("downloadedUrls");
            for (int i = 0; urls != null && i < urls.length(); i++) downloadedUrls.add(urls.getString(i));
            latestModified = json.optString("latestModifiedTimeOfArchive", null);
        } catch (Exception e) {
            Log.w(TAG, "assetDownload: ignoring unreadable " + partialFile, e);
        }
    }

    private void writePartial() throws IOException {
        if (partialFile == null) return;
        try {
            JSONObject json = new JSONObject().put("downloadedUrls", new JSONArray(downloadedUrls));
            if (latestModified != null) json.put("latestModifiedTimeOfArchive", latestModified);
            partialFile.getParentFile().mkdirs();
            try (OutputStream out = new FileOutputStream(partialFile)) {
                out.write(json.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (org.json.JSONException e) {
            throw new IOException(e);
        }
    }

    private void progress(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        event("progress", "");
    }

    private void fail(String code, Exception e) {
        if (cancelled) return;
        Log.e(TAG, "assetDownload: " + code, e);
        event(code, String.valueOf(e.getMessage()));
    }

    private void event(String code, String level) {
        if (cancelled && !code.equals("cancel")) return;
        try {
            ctx.dispatchStatusEventAsync(code, level);
        } catch (Exception e) {
            Log.w(TAG, "assetDownload: could not dispatch " + code, e);
        }
    }
}
