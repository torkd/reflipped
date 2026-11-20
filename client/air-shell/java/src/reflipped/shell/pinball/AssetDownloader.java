package reflipped.shell.pinball;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
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
 * - `progress` is throttled; `completed` carries the latest `Last-Modified`;
 * - SH-27: the paths each layer archive (any archive that isn't a base one) writes or deletes go to the
 *   {@link LayerRecord}, which a fresh full download starts; SH-29: the base originals they replace are kept.
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

    /** Told once when a run ends, on the downloader's thread: completed, or stopped by an error or a cancel. */
    interface Listener {
        void ended(boolean completed);
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
    private volatile Listener listener;
    private ArchiveExtractor extractor;
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

    /** Set before {@link #start()}. */
    void setListener(Listener listener) {
        this.listener = listener;
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
        boolean completed = false;
        try {
            readPartial();
            long done = 0;
            for (Archive a : archives) if (downloadedUrls.contains(a.location)) done += a.size;
            doneBytes.set(done);
            if (done > 0) Log.i(TAG, "assetDownload: resuming, " + downloadedUrls.size() + " archives already done");
            assetDir.mkdirs();
            extractor = new ArchiveExtractor(assetDir);
            if (downloadedUrls.isEmpty()) {
                for (Archive a : archives) {
                    if (!LayerRecord.isFullBase(a.location)) continue;
                    LayerRecord.start(recordRoot());
                    break;
                }
            }

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
            completed = true;
            event("completed", latestModified == null ? "" : latestModified);
        } catch (SocketTimeoutException e) {
            fail("timeout", e);
        } catch (IOException e) {
            fail("ioError", e);
        } catch (Exception e) {
            fail("error", e);
        } finally {
            Listener l = listener;
            if (l != null) {
                try {
                    l.ended(completed);
                } catch (RuntimeException e) {
                    Log.w(TAG, "assetDownload: end listener failed", e);
                }
            }
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
        try (InputStream counted = new FilterInputStream(body) {
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
        }) {
            LayerRecord.Keeper keeper = LayerRecord.isBase(archive.location) ? null : LayerRecord.keeper(recordRoot());
            extractor.touch = keeper;
            try {
                if (!extractor.extract(counted, () -> cancelled)) return false;
            } finally {
                // what a layer changed is recorded even when its extraction stopped half-way
                extractor.touch = null;
                if (keeper != null) keeper.close();
            }
            if (extractor.removed > 0) Log.i(TAG, "assetDownload: .removed.csv deleted " + extractor.removed + " files");
        } finally {
            watchdog.cancel();
            conn.disconnect();
        }
        return !cancelled;
    }

    /** The record sits beside the game's info.json, one level above the extraction folder. */
    private File recordRoot() {
        File parent = assetDir.getAbsoluteFile().getParentFile();
        return parent == null ? assetDir : parent;
    }

    // The shortened-twin rules live in ArchiveExtractor; kept here for the desktop test's checks.
    static String shortenedToActual(String path) {
        return ArchiveExtractor.shortenedToActual(path);
    }

    static String actualToShortened(String path) {
        return ArchiveExtractor.actualToShortened(path);
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
