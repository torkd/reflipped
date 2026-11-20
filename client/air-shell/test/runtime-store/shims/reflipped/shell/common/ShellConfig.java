package reflipped.shell.common;
import android.app.Activity;
/** Compile-only guard: this harness must never open real preferences. */
public final class ShellConfig {
    public static DeviceKeys.Store keyStore(Activity activity) { throw new AssertionError("Activity preferences are forbidden in this test"); }
}
