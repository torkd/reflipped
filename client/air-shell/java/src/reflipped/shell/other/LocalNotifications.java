package reflipped.shell.other;

import android.app.ActivityManager;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;

import reflipped.shell.service.ForegroundServiceBase;

/**
 * SH-6 (in SH-7): the game's local notifications, as the original's PushService ANE scheduled them. The game asks for
 * them by label (master `notification/notification`: `stamina` when stamina will be full, and three `retention`
 * reminders it leaves off through its devConfig): schedule replaces the label's earlier one, cancel removes it.
 *
 * <p>Each one is an {@link AlarmManager} alarm to {@link LocalNotificationReceiver}, also kept in the app's preferences
 * so the receiver can re-arm them after a reboot or an app update (alarms don't survive either). The alarm is the
 * inexact {@code setAndAllowWhileIdle}: exact alarms need a permission the player grants by hand on Android 14+, and a
 * stamina reminder a few minutes late does no harm. The notification shows only while the game isn't in front, like
 * the original's, and the game's notification ID (its group: 1 stamina, 2 retention) keeps one per group.
 */
public final class LocalNotifications {
    static final String TAG = "ReflippedShell";
    static final String CHANNEL = "reflipped.reminders";
    private static final String PREFS = "reflipped.notifications";
    private static final String SCHEDULED = "scheduled";
    private static final String ACTION_PREFIX = "reflipped.notification.";
    /** Android notification IDs: 1000 + the game's group, apart from the services' own (7, 8). */
    private static final int ID_BASE = 1000;

    private LocalNotifications() {
    }

    /** Schedules {@code message} in {@code delayMsec} under {@code label}, replacing that label's earlier one. */
    public static synchronized void schedule(Context context, String label, String message, long delayMsec, int group) {
        if (label == null || label.isEmpty() || message == null) return;
        long at = System.currentTimeMillis() + Math.max(0, delayMsec);
        try {
            JSONObject entry = new JSONObject().put("label", label).put("message", message).put("at", at).put("group", group);
            JSONObject all = read(context);
            all.put(label, entry);
            write(context, all);
            arm(context, label, at);
            Log.i(TAG, "notification '" + label + "' in " + Math.round(delayMsec / 60000.0) + " min");
        } catch (JSONException | RuntimeException e) {
            Log.w(TAG, "couldn't schedule notification '" + label + "'", e);
        }
    }

    public static synchronized void cancel(Context context, String label) {
        if (label == null) return;
        JSONObject all = read(context);
        all.remove(label);
        write(context, all);
        disarm(context, label);
    }

    public static synchronized void cancelAll(Context context) {
        JSONObject all = read(context);
        for (Iterator<String> it = all.keys(); it.hasNext(); ) disarm(context, it.next());
        write(context, new JSONObject());
    }

    /** The player is back in the game: the reminders already shown are out of date. */
    public static void clearShown(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        for (int group = 1; group <= 2; group++) manager.cancel(ID_BASE + group);
    }

    /** After a reboot or an app update: arms every stored one again (one already due fires at once). */
    static synchronized void rearm(Context context) {
        JSONObject all = read(context);
        int count = 0;
        for (Iterator<String> it = all.keys(); it.hasNext(); ) {
            String label = it.next();
            JSONObject entry = all.optJSONObject(label);
            if (entry == null) continue;
            arm(context, label, entry.optLong("at"));
            count++;
        }
        if (count > 0) Log.i(TAG, "re-armed " + count + " notification(s)");
    }

    /** An alarm went off: show the label's notification (unless the game is in front) and forget it. */
    static synchronized void fire(Context context, String label) {
        JSONObject all = read(context);
        JSONObject entry = all.optJSONObject(label);
        if (entry == null) return;
        all.remove(label);
        write(context, all);
        if (inFront(context)) {
            Log.i(TAG, "notification '" + label + "' skipped: the game is in front");
            return;
        }
        show(context, entry.optString("message"), entry.optInt("group", 1));
    }

    static String labelOf(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        return action != null && action.startsWith(ACTION_PREFIX) ? action.substring(ACTION_PREFIX.length()) : null;
    }

    private static void show(Context context, String message, int group) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || message.isEmpty()) return;
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            channel(manager);
            builder = new Notification.Builder(context, CHANNEL);
        } else {
            builder = new Notification.Builder(context).setDefaults(Notification.DEFAULT_ALL);
        }
        CharSequence name = context.getApplicationInfo().loadLabel(context.getPackageManager());
        builder.setSmallIcon(ForegroundServiceBase.smallIcon(context)).setContentTitle(name).setContentText(message)
                .setStyle(new Notification.BigTextStyle().bigText(message))
                .setAutoCancel(true).setShowWhen(true).setWhen(System.currentTimeMillis());
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            builder.setContentIntent(PendingIntent.getActivity(context, ID_BASE + group, launch,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        try {
            manager.notify(ID_BASE + group, builder.build());
        } catch (RuntimeException e) {
            Log.w(TAG, "couldn't show a notification", e);
        }
    }

    /** The reminders' channel; the player can turn it off in Android's settings without touching the download's. */
    static void channel(NotificationManager manager) {
        if (Build.VERSION.SDK_INT < 26 || manager.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Game reminders", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Stamina full and other reminders from the game");
        manager.createNotificationChannel(channel);
    }

    private static void arm(Context context, String label, long at) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        PendingIntent intent = pending(context, label, PendingIntent.FLAG_UPDATE_CURRENT);
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent);
    }

    private static void disarm(Context context, String label) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        PendingIntent intent = pending(context, label, PendingIntent.FLAG_NO_CREATE);
        if (intent == null) return;
        if (alarms != null) alarms.cancel(intent);
        intent.cancel();
    }

    private static PendingIntent pending(Context context, String label, int flags) {
        Intent intent = new Intent(context, LocalNotificationReceiver.class).setAction(ACTION_PREFIX + label);
        return PendingIntent.getBroadcast(context, 0, intent, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    private static boolean inFront(Context context) {
        ActivityManager.RunningAppProcessInfo state = new ActivityManager.RunningAppProcessInfo();
        ActivityManager.getMyMemoryState(state);
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                && (power == null || power.isInteractive());
    }

    private static JSONObject read(Context context) {
        String raw = prefs(context).getString(SCHEDULED, "{}");
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static void write(Context context, JSONObject all) {
        prefs(context).edit().putString(SCHEDULED, all.toString()).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
