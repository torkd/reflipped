package reflipped.shell.common;

import android.app.Activity;

/**
 * Closes the app so the player opens it again (ACC-12). After a sign-in from the game's account menu, the running game
 * still holds the save it started with, so it has to start over to load the account's save. The app doesn't relaunch
 * itself: Android 10 and later block an activity start from an app that is no longer on screen, so a scheduled
 * relaunch would only work on some phones.
 */
public final class AppRestart {
    private AppRestart() {
    }

    public static void close(Activity activity) {
        activity.runOnUiThread(() -> {
            activity.finishAffinity();
            android.os.Process.killProcess(android.os.Process.myPid());
        });
    }
}
