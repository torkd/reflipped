package reflipped.shell.service;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import java.util.function.DoubleSupplier;

/**
 * SH-7: keeps the game's asset download going while the app is in the background, as the original's download service
 * did. The download itself stays on the downloader's thread in the game's process ({@code pinball.AssetDownloader});
 * this foreground service only keeps that process from being frozen or killed, holds a partial wake lock and a Wi-Fi
 * lock while it runs, and shows the progress in a notification with the game's own texts ({@code setMessageTexts}).
 *
 * <p>Declared in the descriptor with {@code foregroundServiceType="dataSync"} and no {@code android:process}, so it
 * shares the game's process. Android 15 limits dataSync to 6 hours a day ({@link #onTimeout}); a first download
 * takes well under an hour on Wi-Fi. A start the system refuses (the app no longer in front) changes nothing: the
 * download then runs as before, only while the game is on the screen.
 *
 * <p>Swiping the app away is closing it: the work is cancelled and the process ends ({@link #onTaskRemoved}), as it did
 * before this service, which otherwise keeps the process alive with no game. A download resumes at the next start; a
 * game data pack install is offered again (its info.json is written only at the end).
 */
public final class DownloadService extends ForegroundServiceBase {
    static final String TAG = "ReflippedShell";
    private static final int NOTIFICATION_ID = 7;
    private static final int DONE_NOTIFICATION_ID = 8;
    private static final long TICK_MS = 1000;

    /** The texts the game passes to setMessageTexts; English until it does. */
    public static final class Texts {
        public final String title;
        public final String downloading;
        public final String completed;

        public Texts(String title, String downloading, String completed) {
            this.title = orElse(title, "Downloading game data");
            this.downloading = orElse(downloading, "Downloading…");
            this.completed = orElse(completed, "The download is complete.");
        }

        private static String orElse(String value, String fallback) {
            return value == null || value.trim().isEmpty() ? fallback : value;
        }
    }

    private static final Object lock = new Object();
    /** The running download's progress (0..1), or null when none runs; read by the service's tick. */
    private static DoubleSupplier progress;
    /** Stops the running work when the player closes the app; null when none runs. */
    private static Runnable cancel;
    private static Texts texts = new Texts(null, null, null);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private int percent = -1;

    /**
     * Starts the service for work that reports its progress through {@code ratio}; call while the game is shown.
     * {@code onClose} stops that work when the player swipes the app away.
     */
    public static void begin(Context context, DoubleSupplier ratio, Texts messages, Runnable onClose) {
        synchronized (lock) {
            progress = ratio;
            cancel = onClose;
            if (messages != null) texts = messages;
        }
        Context app = context.getApplicationContext();
        Intent intent = new Intent(app, DownloadService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(intent);
            else app.startService(intent);
        } catch (RuntimeException refused) {
            // ForegroundServiceStartNotAllowedException (12+) or a background start limit: download in the foreground only
            Log.w(TAG, "assetDownload: no background service (" + refused.getClass().getSimpleName() + ")");
        }
    }

    /**
     * Ends the service. {@code completed}: the whole set is in, so a player who is away gets a "complete" notification
     * that opens the game; after an error or a cancel the game shows its own dialog when it is opened again.
     */
    public static void end(Context context, boolean completed) {
        Texts messages;
        synchronized (lock) {
            if (progress == null) return;
            progress = null;
            cancel = null;
            messages = texts;
        }
        Context app = context.getApplicationContext();
        app.stopService(new Intent(app, DownloadService.class));
        if (completed && !inFront(app)) notifyCompleted(app, messages);
    }

    /** Texts for the next notification, from setMessageTexts (the game sends them before startDownload). */
    public static void texts(Texts messages) {
        synchronized (lock) {
            texts = messages;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        goForeground();
        synchronized (lock) {
            if (progress == null) {
                // ended before the service came up (or a restart after the process died: the game resumes it itself)
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        holdLocks();
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, TICK_MS);
        return START_NOT_STICKY;
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            DoubleSupplier ratio;
            synchronized (lock) {
                ratio = progress;
            }
            if (ratio == null) {
                stopSelf();
                return;
            }
            int now = (int) Math.floor(Math.max(0, Math.min(1, ratio.getAsDouble())) * 100);
            if (now != percent) {
                percent = now;
                refreshNotification();
            }
            handler.postDelayed(this, TICK_MS);
        }
    };

    /**
     * The player swiped the app away: that is closing the game. Cancels the work, stops, and ends the process, which
     * Android spares while a foreground service runs in it (the game's activity is already gone; the local server's
     * own process stops itself, ServerService).
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Runnable stop;
        synchronized (lock) {
            stop = cancel;
            progress = null;
            cancel = null;
        }
        Log.i(TAG, "app swiped away: stopping the background work and closing");
        if (stop != null) {
            try {
                stop.run();
            } catch (RuntimeException e) {
                Log.w(TAG, "couldn't cancel the background work", e);
            }
        }
        stopSelf();
        // a moment for the worker to see the cancel between files; whatever it was writing is redone next time
        handler.postDelayed(() -> android.os.Process.killProcess(android.os.Process.myPid()), 500);
    }

    /** Android 15+: the daily dataSync time is used up. Stop; the game resumes the download when next shown. */
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "assetDownload: Android ended the background download (daily limit)");
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(tick);
        releaseLocks();
        super.onDestroy();
    }

    @Override
    protected int notificationId() {
        return NOTIFICATION_ID;
    }

    @Override
    protected String title() {
        synchronized (lock) {
            return texts.title;
        }
    }

    @Override
    protected String text() {
        synchronized (lock) {
            return percent < 0 ? texts.downloading : texts.downloading + "  " + percent + "%";
        }
    }

    @Override
    protected void decorate(Notification.Builder builder) {
        if (percent < 0) builder.setProgress(0, 0, true);
        else builder.setProgress(100, percent, false);
        builder.setCategory(Notification.CATEGORY_PROGRESS);
    }

    @Override
    protected int type() {
        return Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
    }

    /** Keeps the CPU and Wi-Fi up with the screen off; released in onDestroy, and at the latest after an hour. */
    private void holdLocks() {
        try {
            if (wakeLock == null) {
                PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "reflipped:assetDownload");
                wakeLock.setReferenceCounted(false);
            }
            wakeLock.acquire(60 * 60 * 1000L);
            if (wifiLock == null) {
                WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                if (wifi != null) {
                    wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "reflipped:assetDownload");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null) wifiLock.acquire();
        } catch (RuntimeException e) {
            Log.w(TAG, "assetDownload: couldn't hold the wake or Wi-Fi lock", e);
        }
    }

    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (RuntimeException e) {
            Log.w(TAG, "assetDownload: couldn't release a lock", e);
        }
    }

    /** Whether the game's screen is in front: then it shows the end of the download itself. */
    private static boolean inFront(Context context) {
        ActivityManager.RunningAppProcessInfo state = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(state);
        PowerManager power = (PowerManager) context.getSystemService(POWER_SERVICE);
        return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                && (power == null || power.isInteractive());
    }

    private static void notifyCompleted(Context context, Texts messages) {
        try {
            Notification.Builder builder = builder(context, CHANNEL)
                    .setSmallIcon(smallIcon(context)).setContentTitle(messages.title).setContentText(messages.completed)
                    .setAutoCancel(true).setShowWhen(true);
            PendingIntent launch = launchIntent(context);
            if (launch != null) builder.setContentIntent(launch);
            NotificationManager manager = (NotificationManager) context.getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(DONE_NOTIFICATION_ID, builder.build());
        } catch (RuntimeException e) {
            Log.w(TAG, "assetDownload: couldn't show the completed notification", e);
        }
    }

    /** Removes the "complete" notification once the player is back in the game. */
    public static void clearCompleted(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(DONE_NOTIFICATION_ID);
    }
}
