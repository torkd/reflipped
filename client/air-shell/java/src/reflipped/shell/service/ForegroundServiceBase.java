package reflipped.shell.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * A started (not bound) foreground service with one ongoing notification: the shared part of the app's long-running
 * work outside the game's screen: the local server ({@link ServerService}, SH-13) and the background asset download
 * ({@link DownloadService}, SH-7). Each subclass is declared in the descriptor's manifestAdditions with its
 * {@code foregroundServiceType} (and, for {@code specialUse}, the subtype property); {@link #type()} must match it.
 */
public abstract class ForegroundServiceBase extends Service {
    /** One channel for all of them, so the player can silence the app's status notifications in one place. */
    static final String CHANNEL = "reflipped.work";

    /** The notification's ID; unique per subclass. */
    protected abstract int notificationId();

    /** The title and text of the ongoing notification. */
    protected abstract String title();

    protected abstract String text();

    /** {@code ServiceInfo.FOREGROUND_SERVICE_TYPE_*}, as declared in the manifest. */
    protected abstract int type();

    /** Shows the notification and makes this a foreground service; call within 5 s of a startForegroundService. */
    protected final void goForeground() {
        Notification notification = notification().build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(notificationId(), notification, type());
        else startForeground(notificationId(), notification);
    }

    /** Replaces the ongoing notification, e.g. with new progress from {@link #decorate}. */
    protected final void refreshNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(notificationId(), notification().build());
    }

    /** Adds to the notification before it is shown (a progress bar, say); nothing by default. */
    protected void decorate(Notification.Builder builder) {
    }

    private Notification.Builder notification() {
        Notification.Builder builder = builder(this, CHANNEL);
        builder.setSmallIcon(smallIcon(this)).setContentTitle(title()).setContentText(text())
                .setOngoing(true).setShowWhen(false).setOnlyAlertOnce(true);
        PendingIntent launch = launchIntent(this);
        if (launch != null) builder.setContentIntent(launch);
        decorate(builder);
        return builder;
    }

    /** A builder on {@code channel}, made on first use (Android 8+); below 8 the priority stands in for it. */
    static Notification.Builder builder(Context context, String channel) {
        if (Build.VERSION.SDK_INT < 26) return new Notification.Builder(context).setPriority(Notification.PRIORITY_LOW);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel work = new NotificationChannel(CHANNEL, "Running in the background",
                    NotificationManager.IMPORTANCE_LOW);
            work.setShowBadge(false);
            manager.createNotificationChannel(work);
        }
        return new Notification.Builder(context, channel);
    }

    /** Opens the app (its launcher activity) when the notification is tapped. */
    static PendingIntent launchIntent(Context context) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) return null;
        return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /**
     * The status-bar icon: our white silhouette (tools/make_icons.py, shipped with the launcher icon's resources).
     * Not the launcher icon: Android draws only a small icon's alpha (a white blob), and an adaptive one crashed
     * SystemUI on Android 8.0. Looked up by name, since the extension's Java is compiled without the app's R class.
     */
    public static int smallIcon(Context context) {
        int id = context.getResources().getIdentifier("reflipped_notification", "drawable", context.getPackageName());
        return id != 0 ? id : android.R.drawable.stat_notify_sync;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
