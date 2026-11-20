package reflipped.shell.common;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

/**
 * SH-15: installs an update the server announces ({@code /shell/config} {@code updateApk}: address and SHA-256). The
 * app downloads the APK, checks its SHA-256, that it is this app (same package), newer, and signed with the same key
 * (Android would refuse anything else; this says why first), then hands it to Android's installer through a
 * {@link PackageInstaller} session: the player confirms in Android's own dialog, nothing installs silently. Android
 * 8+ first needs the player to allow this app to install apps (asked here). Runs on a worker thread.
 */
public final class AppUpdater {
    private static final String TITLE = "Update";
    private static final String STATUS_ACTION = "reflipped.shell.UPDATE_STATUS";
    private static final long MAX_BYTES = 400L << 20;

    /** The announced APK: an http(s) address and its SHA-256. */
    public static final class Apk {
        public final String url, sha256;
        Apk(String url, String sha256) { this.url = url; this.sha256 = sha256; }

        /** From /shell/config's {@code updateApk}, or null when absent or unusable. */
        public static Apk of(JSONObject json) {
            if (json == null) return null;
            String url = json.optString("url", "").trim(), sha256 = json.optString("sha256", "").trim().toLowerCase(Locale.ROOT);
            if (!sha256.matches("[0-9a-f]{64}") || url.length() > 2048) return null;
            try {
                URI uri = new URI(url);
                boolean web = "http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme());
                return web && uri.getHost() != null && uri.getUserInfo() == null && uri.getFragment() == null
                        ? new Apk(url, sha256) : null;
            } catch (java.net.URISyntaxException invalid) {
                return null;
            }
        }
    }

    /** A problem the player is told about. */
    private static final class Refused extends Exception {
        Refused(String message) { super(message); }
    }

    private AppUpdater() {}

    /** Downloads, checks and installs `apk`; every failure ends in a dialog. Call off the UI thread. */
    public static void install(Activity activity, Apk apk) {
        File file = new File(activity.getCacheDir(), "reflipped-update.apk");
        try {
            if (!mayInstall(activity)) return;
            download(activity, apk, file);
            check(activity, file);
            commit(activity, file);
        } catch (Refused refused) {
            say(activity, refused.getMessage());
        } catch (Exception failed) {
            Log.w(StubContext.TAG, "update failed", failed);
            say(activity, "The update couldn't be downloaded. Check the connection and try again from the update notice"
                    + " or the update page.");
        } finally {
            if (!file.delete() && file.exists()) Log.w(StubContext.TAG, "can't delete " + file);
        }
    }

    /** Android 8+: this app must be allowed to install apps; asks the player once, through Android's settings. */
    private static boolean mayInstall(Activity activity) throws Exception {
        if (Build.VERSION.SDK_INT < 26 || activity.getPackageManager().canRequestPackageInstalls()) return true;
        if (ShellDialogs.choose(activity, TITLE, "To install the update, allow the Reflipped app to install apps."
                + " Android's settings open next: turn it on, then come back.", "Open settings", "Cancel") != 0) return false;
        BlockingQueue<Integer> back = new ArrayBlockingQueue<>(1);
        Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + activity.getPackageName()));
        activity.runOnUiThread(() -> ActivityResults.start(activity, settings, (code, data) -> back.offer(code)));
        back.take();
        if (activity.getPackageManager().canRequestPackageInstalls()) return true;
        say(activity, "The update wasn't installed: the Reflipped app isn't allowed to install apps.");
        return false;
    }

    private static void download(Activity activity, Apk apk, File file) throws Exception {
        ShellDialogs.Progress progress = ShellDialogs.progress(activity, "Downloading the update", "Connecting…");
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(apk.url).openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(30000);
            try {
                if (connection.getResponseCode() != 200) throw new java.io.IOException("HTTP " + connection.getResponseCode());
                long total = connection.getContentLength();
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long done = 0;
                try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(file)) {
                    byte[] buffer = new byte[65536];
                    for (int n; (n = in.read(buffer)) > 0; ) {
                        done += n;
                        if (done > MAX_BYTES) throw new Refused("The update is too big to be the Reflipped app.");
                        out.write(buffer, 0, n);
                        digest.update(buffer, 0, n);
                        progress.set(total > 0 ? (int) (done * 100 / total) : -1,
                                String.format(Locale.ROOT, "%.1f MB", done / 1048576.0));
                    }
                }
                if (!hex(digest.digest()).equals(apk.sha256))
                    throw new Refused("The downloaded update doesn't match the checksum the server gave, so it wasn't"
                            + " installed. Tell the server's owner.");
            } finally {
                connection.disconnect();
            }
        } finally {
            progress.close();
        }
    }

    /** The same package, a newer version, and the same signing key as this installed app. */
    @SuppressWarnings("deprecation")
    private static void check(Activity activity, File file) throws Exception {
        PackageManager manager = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo update = manager.getPackageArchiveInfo(file.getPath(), flags);
        PackageInfo installed = manager.getPackageInfo(activity.getPackageName(), flags);
        if (update == null) throw new Refused("The download isn't an Android app, so it wasn't installed.");
        if (!activity.getPackageName().equals(update.packageName))
            throw new Refused("This update is for another app, so it wasn't installed.");
        if (versionCode(update) <= versionCode(installed))
            throw new Refused("This update isn't newer than the app you have, so it wasn't installed.");
        if (!signers(update).equals(signers(installed)))
            throw new Refused("This update is signed with another key, so Android can't install it over your app."
                    + " Updates from a server only fit apps built by that server's owner; use the update page instead.");
    }

    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    @SuppressWarnings("deprecation")
    private static Set<String> signers(PackageInfo info) {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28 && info.signingInfo != null
                ? info.signingInfo.getApkContentsSigners() : info.signatures;
        Set<String> set = new HashSet<>();
        if (signatures != null) for (Signature signature : signatures) set.add(signature.toCharsString());
        return set;
    }

    /** Streams the checked APK into an installer session and commits it; Android asks the player to confirm. */
    private static void commit(Activity activity, File file) throws Exception {
        Context app = activity.getApplicationContext();
        PackageInstaller installer = app.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(app.getPackageName());
        params.setSize(file.length());
        int id = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(id)) {
            try (InputStream in = new FileInputStream(file); OutputStream out = session.openWrite("reflipped.apk", 0, file.length())) {
                byte[] buffer = new byte[65536];
                for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                session.fsync(out);
            }
            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    // Below Android 13 any app can send this action: only our session's status counts, and only a
                    // confirmation screen of the system's own installer is opened (security review 2026-11-13)
                    if (intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1) != id) return;
                    int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                        Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                        if (confirm != null && systemActivity(app, confirm)) {
                            confirm.setFlags(confirm.getFlags() & ~(Intent.FLAG_GRANT_READ_URI_PERMISSION
                                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                                    | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION));
                            activity.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                        } else {
                            Log.w(StubContext.TAG, "update: a confirmation that isn't the system installer's was ignored");
                        }
                        return;
                    }
                    try { app.unregisterReceiver(this); } catch (RuntimeException ignored) { /* already */ }
                    if (status == PackageInstaller.STATUS_SUCCESS) return; // Android restarts the app as the new version
                    String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                    Log.w(StubContext.TAG, "update not installed: status " + status + " " + message);
                    if (status != PackageInstaller.STATUS_FAILURE_ABORTED)
                        new Thread(() -> say(activity, "Android didn't install the update"
                                + (status == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE
                                ? ": it doesn't fit this phone (another processor type). Use the update page." : ".")),
                                "reflipped-update").start();
                }
            };
            IntentFilter filter = new IntentFilter(STATUS_ACTION);
            if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
            else app.registerReceiver(receiver, filter);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent status = PendingIntent.getBroadcast(app, id, new Intent(STATUS_ACTION).setPackage(app.getPackageName()), flags);
            session.commit(status.getIntentSender());
            Log.i(StubContext.TAG, "update handed to Android's installer (session " + id + ")");
        } catch (Exception failed) {
            installer.abandonSession(id);
            throw failed;
        }
    }

    /** Whether the intent opens an activity of a system app (the package installer), nothing else. */
    private static boolean systemActivity(Context context, Intent intent) {
        try {
            android.content.pm.ResolveInfo resolved = context.getPackageManager().resolveActivity(intent, 0);
            return resolved != null && resolved.activityInfo != null && resolved.activityInfo.applicationInfo != null
                    && (resolved.activityInfo.applicationInfo.flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0;
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static void say(Activity activity, String message) {
        try {
            ShellDialogs.choose(activity, TITLE, message, "OK");
        } catch (Exception ignored) {
            // the activity went away
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) text.append(String.format("%02x", b));
        return text.toString();
    }
}
