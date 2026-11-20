package reflipped.shell.common;

import android.app.Activity;
import android.app.Application;
import android.os.Bundle;
import android.os.PowerManager;
import android.util.Log;

import java.lang.reflect.Field;

/**
 * Releases AIR's keep-awake wakelock when the game leaves the screen (SH-26).
 *
 * <p>The game keeps the screen on in battles ({@code NativeApplication.systemIdleMode = KEEP_AWAKE}); AIR does it
 * with {@code com.adobe.air.AndroidIdleState}: a screen-bright wakelock ("DoNotDimScreen") plus
 * {@code KeyguardLock.disableKeyguard()}. The second call needs {@code DISABLE_KEYGUARD}, which this app doesn't ask
 * for (it would switch off the phone's lock screen), so it throws; AIR swallows that before it records the lock as
 * held, so its own release in {@code onPause} never runs and every further keep-awake adds a hold. The app then kept
 * the lock in the background, and Samsung's power manager flagged it as wakelock abuse.
 *
 * <p>This makes the lock non-counting (repeated keep-awake calls hold it once) and releases it whenever the game's
 * activity pauses; AIR takes it again on resume when the game still wants the screen on. Reflection on AIR's
 * runtime classes: when they change, this only logs once and does nothing.
 */
public final class ScreenAwake {
    private static boolean installed;
    private static boolean broken;

    private ScreenAwake() {}

    public static synchronized void install(Activity activity) {
        if (installed) return;
        installed = true;
        activity.getApplication().registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            public void onActivityPaused(Activity a) {
                release();
            }
            public void onActivityResumed(Activity a) {
                PowerManager.WakeLock lock = lock();
                if (lock != null) lock.setReferenceCounted(false); // created on the first keep-awake
            }
            public void onActivityCreated(Activity a, Bundle b) {}
            public void onActivityStarted(Activity a) {}
            public void onActivityStopped(Activity a) {}
            public void onActivitySaveInstanceState(Activity a, Bundle b) {}
            public void onActivityDestroyed(Activity a) {}
        });
    }

    /** Releases every hold on AIR's keep-awake lock, if the game ever took it. */
    static void release() {
        PowerManager.WakeLock lock = lock();
        if (lock == null) return;
        try {
            int holds = 0;
            while (lock.isHeld() && holds < 1000) {
                lock.release();
                holds++;
            }
            lock.setReferenceCounted(false);
            if (holds > 0) Log.i(StubContext.TAG, "released the keep-awake lock (" + holds + " holds)");
        } catch (RuntimeException e) {
            Log.w(StubContext.TAG, "couldn't release the keep-awake lock", e);
        }
    }

    /** AIR's screen-bright wakelock, or null before the first keep-awake (or when AIR's classes changed). */
    private static synchronized PowerManager.WakeLock lock() {
        if (broken) return null;
        try {
            Class<?> wrapper = Class.forName("com.adobe.air.AndroidActivityWrapper");
            Field manager = wrapper.getDeclaredField("sIdleStateManager");
            manager.setAccessible(true);
            Object idle = manager.get(null);
            if (idle == null) return null;
            Field bright = idle.getClass().getDeclaredField("mScreenBrightLock");
            bright.setAccessible(true);
            return (PowerManager.WakeLock) bright.get(idle);
        } catch (ReflectiveOperationException | RuntimeException e) {
            broken = true;
            Log.w(StubContext.TAG, "AIR's keep-awake lock isn't where it was (" + e + "); not releasing it");
            return null;
        }
    }
}
