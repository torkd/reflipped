package reflipped.shell.common;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import org.json.JSONObject;

/**
 * SH-15: shows {@link UpdateNotice} once per server and announced version, where a server's /shell/config is known.
 * Joining stays allowed whichever button is tapped. Runs on the Kakao stub's worker thread, like the other dialogs.
 */
public final class UpdateNoticeDialog {
    private UpdateNoticeDialog() { }

    /** Never throws: a failing notice must not stop the player from joining. */
    public static void showOnce(Activity activity, String server, JSONObject config) {
        try {
            Boolean available = config.isNull("updateAvailable") ? null : Boolean.valueOf(config.optBoolean("updateAvailable"));
            UpdateNotice notice = UpdateNotice.of(ShellConfig.appVersion(activity), text(config, "latestAppVersion"),
                    available, text(config, "updateUrl"), text(config, "updateNotes"));
            if (notice == null) return;
            String key = "updateNoticeShown." + server;
            if (notice.seenKey().equals(ShellConfig.prefs(activity).getString(key, ""))) return;
            ShellConfig.prefs(activity).edit().putString(key, notice.seenKey()).apply();
            AppUpdater.Apk apk = AppUpdater.Apk.of(config.optJSONObject("updateApk"));
            if (apk != null) {
                // the server offers the APK itself: install it in the app, or open the page as before
                String message = "Update available: Reflipped app " + notice.latest + ".\nInstall it now: the app downloads"
                        + " it and Android asks you to confirm. Your game files and progress stay. You can also keep playing"
                        + " and update later from the update page." + (notice.notes.isEmpty() ? "" : "\n\n" + notice.notes);
                int choice = ShellDialogs.chooseRowWithBack(activity, "Update available", message, 2,
                        "Install update", "Open update page", "Not now");
                if (choice == 0) {
                    AppUpdater.install(activity, apk);
                    return;
                }
                if (choice != 1) return;
            } else if (ShellDialogs.confirm(activity, "Update available", notice.message, "Open update page", "Not now") != 0) {
                return;
            }
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(notice.url)));
        } catch (Exception failure) {
            Log.w(StubContext.TAG, "update notice failed (" + failure.getClass().getSimpleName() + ")");
        }
    }

    private static String text(JSONObject config, String name) {
        return config.isNull(name) ? null : config.optString(name, null);
    }
}
