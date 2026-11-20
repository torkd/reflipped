package reflipped.shell.common;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

/**
 * Android 13+: the app's notifications (download progress, stamina reminders, the local server's) show only with
 * POST_NOTIFICATIONS. The game never calls the push extension's TRY_INITIALIZE_PUSH, where the original asked, so the
 * app asks once per install at the first moment a notification helps: an asset download starting, or the game
 * scheduling its first reminder. A refusal only hides the notifications; the player can change it in Android's settings.
 */
public final class NotificationPermission {
    private static final String PREFS = "reflipped.notifications";
    private static final String ASKED = "permissionAsked";

    private NotificationPermission() {
    }

    public static void askOnce(Activity activity) {
        if (activity == null || Build.VERSION.SDK_INT < 33) return;
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean(ASKED, false)) return;
        prefs.edit().putBoolean(ASKED, true).apply();
        activity.runOnUiThread(() -> ActivityResults.requestPermission(activity,
                "android.permission.POST_NOTIFICATIONS", 33, (code, data) -> { }));
    }
}
