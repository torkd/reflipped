package reflipped.shell.common;

import android.app.Activity;
import android.app.Fragment;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import java.util.HashMap;
import java.util.Map;

/**
 * Starts another app's screen for a result (a file picker, a "save as" screen, a permission request) from the shell. AIR owns the game's
 * activity and the shell can't override its onActivityResult, so a headless fragment added to that activity starts
 * the screen and receives the result: Android hands a fragment's results to the fragment itself, whatever the activity
 * does with its own. No manifest entry or permission is needed. The callback runs on the UI thread, exactly once.
 *
 * Android may destroy the game's activity while the other screen is open (low memory, "Don't keep activities") and
 * create a new one when it closes, in the same process. It then recreates the fragment in the new activity and hands
 * the result to that instance, so the callbacks wait here, by the fragment's key, not in the fragment. If the process
 * itself was restarted, nobody waits any more and the result is dropped.
 */
@SuppressWarnings("deprecation") // android.app.Fragment: the support library isn't packaged, and AIR's activity is a plain Activity
public final class ActivityResults {
    public interface Callback {
        /** `resultCode` is {@link #NOT_STARTED} (with null data) when nothing could be started. */
        void done(int resultCode, Intent data);
    }

    /** The result code when no app could be started for the intent (a cancel is Activity.RESULT_CANCELED). */
    public static final int NOT_STARTED = Activity.RESULT_FIRST_USER + 100;

    private static final String TAG_PREFIX = "reflipped-result-";
    private static final String KEY = "reflipped.key";
    private static final String INTENT = "reflipped.intent";
    private static final String PERMISSION = "reflipped.permission";
    private static final Map<String, Callback> PENDING = new HashMap<>();
    private static final java.util.Set<String> STARTED = new java.util.HashSet<>();
    private static int next;

    private ActivityResults() { }

    /** Call on the UI thread. */
    public static void start(Activity activity, Intent intent, Callback callback) {
        Bundle arguments = new Bundle();
        arguments.putParcelable(INTENT, intent);
        add(activity, arguments, intent.getAction(), callback);
    }

    /**
     * Asks the player for a runtime permission (Android's own dialog); the callback gets {@link Activity#RESULT_OK}
     * when it is granted. Granted at once (no dialog) when it already is, or when Android before {@code minSdk} has no
     * such runtime permission (POST_NOTIFICATIONS exists from Android 13). Call on the UI thread.
     */
    public static void requestPermission(Activity activity, String permission, int minSdk, Callback callback) {
        if (android.os.Build.VERSION.SDK_INT < minSdk
                || activity.checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            callback.done(Activity.RESULT_OK, null);
            return;
        }
        Bundle arguments = new Bundle();
        arguments.putString(PERMISSION, permission);
        add(activity, arguments, permission, callback);
    }

    private static void add(Activity activity, Bundle arguments, String what, Callback callback) {
        String key = TAG_PREFIX + android.os.Process.myPid() + "-" + (next++);
        PENDING.put(key, callback);
        Host host = new Host();
        arguments.putString(KEY, key);
        host.setArguments(arguments);
        try {
            activity.getFragmentManager().beginTransaction().add(host, key).commitAllowingStateLoss();
        } catch (RuntimeException failure) {
            Log.w(StubContext.TAG, "can't start " + what + " (" + failure.getClass().getSimpleName() + ")");
            PENDING.remove(key);
            callback.done(NOT_STARTED, null);
        }
    }

    /** Public with a no-argument constructor, as Android requires to recreate a fragment. */
    public static final class Host extends Fragment {
        private String key;

        @Override
        public void onCreate(Bundle state) {
            super.onCreate(state);
            Bundle arguments = getArguments();
            key = arguments == null ? null : arguments.getString(KEY);
            if (key == null || !PENDING.containsKey(key)) {
                // recreated after the process was restarted: nothing waits for this result any more
                finish(Activity.RESULT_CANCELED, null);
                return;
            }
            // the saved state can't tell (a fragment that saved nothing gets null): remember what was started
            if (!STARTED.add(key)) {
                Log.i(StubContext.TAG, "activity recreated while waiting for a result: still waiting");
                return;  // the other screen is open already; its result comes to this new instance
            }
            String permission = arguments.getString(PERMISSION);
            if (permission != null) {
                requestPermissions(new String[]{permission}, 2);
                return;
            }
            Intent intent = arguments.getParcelable(INTENT);
            try {
                startActivityForResult(intent, 1);
            } catch (ActivityNotFoundException | SecurityException failure) {
                Log.w(StubContext.TAG, "no app for " + (intent == null ? null : intent.getAction()));
                finish(NOT_STARTED, null);
            }
        }

        @Override
        public void onActivityResult(int requestCode, int resultCode, Intent data) {
            finish(resultCode, data);
        }

        @Override
        public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
            boolean granted = results.length > 0 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
            finish(granted ? Activity.RESULT_OK : Activity.RESULT_CANCELED, null);
        }

        private void finish(int resultCode, Intent data) {
            Callback waiting = key == null ? null : PENDING.remove(key);
            if (key != null) STARTED.remove(key);
            try {
                if (isAdded()) getFragmentManager().beginTransaction().remove(this).commitAllowingStateLoss();
            } catch (RuntimeException ignored) {
                // the activity is going away; the fragment goes with it
            }
            if (waiting != null) waiting.done(resultCode, data);
        }
    }
}
