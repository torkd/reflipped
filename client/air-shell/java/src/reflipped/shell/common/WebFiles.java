package reflipped.shell.common;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.widget.Toast;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * File uploads and downloads for the app's web views (the admin site's save import/export and server image, the
 * portal's save download). A WebView does neither by itself: a file field needs a chooser from
 * {@link WebChromeClient#onShowFileChooser}, and a download link only reaches a DownloadListener.
 *
 * Downloads use Android's "save as" screen (ACTION_CREATE_DOCUMENT) and then fetch the file with the page's cookies,
 * so they need no storage permission on any Android version (DownloadManager would need one before Android 10 to
 * write to Downloads). Only http(s) files from the page's own server are fetched, without following redirects.
 */
public final class WebFiles {
    /** A save file is a few MB; anything far bigger isn't what the player meant to download. */
    private static final long MAX_DOWNLOAD_BYTES = 64L * 1024 * 1024;

    private WebFiles() { }

    /** For WebChromeClient.onShowFileChooser: opens the system file picker; always answers `callback` once. */
    public static boolean choose(Activity activity, ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        // `accept` holds MIME types or file extensions (".json"). Pickers only filter by MIME type, and many label a
        // .json file application/octet-stream, so extensions don't filter: the server checks the file anyway.
        List<String> types = new ArrayList<>();
        boolean extensions = false;
        for (String accept : params == null || params.getAcceptTypes() == null ? new String[0] : params.getAcceptTypes()) {
            for (String one : accept.split(",")) {
                String type = one.trim();
                if (type.contains("/")) types.add(type);
                else if (!type.isEmpty()) extensions = true;
            }
        }
        if (extensions) types.clear();
        pick.setType(types.size() == 1 ? types.get(0) : "*/*");
        if (types.size() > 1) pick.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
        if (params != null && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        ActivityResults.start(activity, Intent.createChooser(pick, "Choose a file"), (resultCode, data) -> {
            Uri[] chosen = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    chosen = new Uri[clip.getItemCount()];
                    for (int i = 0; i < chosen.length; i++) chosen[i] = clip.getItemAt(i).getUri();
                } else if (data.getData() != null) chosen = new Uri[]{data.getData()};
            }
            try { callback.onReceiveValue(chosen); }
            catch (RuntimeException closed) { Log.w(StubContext.TAG, "web view closed before the file was chosen"); }
        });
        return true;
    }

    /**
     * For a DownloadListener: asks where to save `url` (a file of the page at `page`'s server), then downloads it there.
     * Call on the UI thread.
     */
    public static void download(Activity activity, String page, String url, String userAgent, String disposition,
                                String mimeType) {
        if (url == null || !GameWebUrls.sameOrigin(page, url)) {
            Log.w(StubContext.TAG, "download from another site ignored");
            Toast.makeText(activity, "This file can't be downloaded here.", Toast.LENGTH_LONG).show();
            return;
        }
        String type = mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType;
        String name = URLUtil.guessFileName(url, disposition, type);
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        save.addCategory(Intent.CATEGORY_OPENABLE);
        save.setType(type);
        save.putExtra(Intent.EXTRA_TITLE, name);
        // Read now, on the UI thread: the web view may be closed by the time the player picks a place.
        String cookies = CookieManager.getInstance().getCookie(url);
        ActivityResults.start(activity, save, (resultCode, data) -> {
            if (resultCode == ActivityResults.NOT_STARTED) {
                Toast.makeText(activity, "This phone has no app to save files with.", Toast.LENGTH_LONG).show();
                return;
            }
            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) return;
            Uri target = data.getData();
            new Thread(() -> {
                try {
                    fetch(activity, url, userAgent, cookies, target);
                    String saved = displayName(activity, target, name);
                    activity.runOnUiThread(() -> Toast.makeText(activity, "Saved " + saved, Toast.LENGTH_SHORT).show());
                } catch (Exception failure) {
                    Log.w(StubContext.TAG, "download failed (" + failure.getClass().getSimpleName() + ")");
                    try { DocumentsContract.deleteDocument(activity.getContentResolver(), target); }
                    catch (Exception ignored) { /* the half-written file stays; the message says so */ }
                    try {
                        ShellDialogs.choose(activity, "Download failed",
                                "The file couldn't be downloaded. Check the connection and that you're still logged in, then try again.",
                                "OK");
                    } catch (Exception ignored) { }
                }
            }, "reflipped-download").start();
        });
    }

    /** The name the player gave the file in "Save as" (they may have changed the suggested one), or `fallback`. */
    private static String displayName(Activity activity, Uri target, String fallback) {
        try (android.database.Cursor row = activity.getContentResolver().query(target,
                new String[] { android.provider.OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (row != null && row.moveToFirst() && !row.isNull(0)) return row.getString(0);
        } catch (RuntimeException ignored) { /* the suggested name will do */ }
        return fallback;
    }

    private static void fetch(Activity activity, String url, String userAgent, String cookies, Uri target) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(30000);
        if (userAgent != null) connection.setRequestProperty("User-Agent", userAgent);
        if (cookies != null && !cookies.isEmpty()) connection.setRequestProperty("Cookie", cookies);
        try {
            int status = connection.getResponseCode();
            // a redirect here is the site sending the player back to its login or list page, not the file
            if (status != 200) throw new IllegalStateException("HTTP " + status);
            try (InputStream in = connection.getInputStream();
                 OutputStream out = activity.getContentResolver().openOutputStream(target, "w")) {
                if (out == null) throw new IllegalStateException("No output");
                byte[] chunk = new byte[16384];
                long total = 0;
                for (int n; (n = in.read(chunk)) > 0; ) {
                    total += n;
                    if (total > MAX_DOWNLOAD_BYTES) throw new IllegalStateException("File too large");
                    out.write(chunk, 0, n);
                }
            }
        } finally {
            connection.disconnect();
        }
    }
}
