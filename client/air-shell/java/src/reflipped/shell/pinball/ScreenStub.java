package reflipped.shell.pinball;

import android.app.Activity;
import android.os.Build;
import android.util.Log;
import android.view.DisplayCutout;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;

import com.adobe.fre.FREArray;
import com.adobe.fre.FREObject;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/**
 * `pinball.screen`: full-screen layout and display cutout handling.
 *
 * The game asks for a cutout mode on start and after every resume, and lays its UI out inside the
 * safe area from getDisplayCutoutInsets. Without a real edge-to-edge window the system status bar
 * keeps its own black strip on top and the game then adds the cutout padding below it as well, so
 * both are applied here: the window draws behind the system bars (hidden, swipe to show) and the
 * cutout mode the game asked for is set on it.
 *
 * getDisplayCutoutInsets must return a Vector.<Number> [left, top, right, bottom]: the game reads
 * `.length` without a null check (null caused Error #1009 on startup) and falls back to zeros
 * when the vector is shorter than 4.
 */
public class ScreenStub extends StubExtension {
    private static int cutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;

    @Override
    protected String extensionId() {
        return "pinball.screen";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.on("getDisplayCutoutInsets", (c, a) -> insets(c.getActivity()));
        ctx.on("setLayoutInDisplayCutoutMode", (c, a) -> {
            if (a.length > 0) cutoutMode = a[0].getAsInt();
            applyFullscreen(c.getActivity());
            return null;
        });
        ctx.on("resetFullscreen", (c, a) -> {
            applyFullscreen(c.getActivity());
            return null;
        });
    }

    /** Edge-to-edge with the system bars hidden; runs on the UI thread. */
    private static void applyFullscreen(final Activity activity) {
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 28) {
                WindowManager.LayoutParams params = activity.getWindow().getAttributes();
                params.layoutInDisplayCutoutMode = cutoutMode;
                activity.getWindow().setAttributes(params);
            }
            if (Build.VERSION.SDK_INT >= 30) {
                activity.getWindow().setDecorFitsSystemWindows(false);
                WindowInsetsController controller = activity.getWindow().getInsetsController();
                if (controller != null) {
                    controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                    controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                activity.getWindow().getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            }
        });
    }

    private static FREArray insets(Activity activity) throws Exception {
        double[] values = new double[4];
        if (Build.VERSION.SDK_INT >= 28 && activity != null) {
            WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets();
            DisplayCutout cutout = insets == null ? null : insets.getDisplayCutout();
            if (cutout != null) {
                values[0] = cutout.getSafeInsetLeft();
                values[1] = cutout.getSafeInsetTop();
                values[2] = cutout.getSafeInsetRight();
                values[3] = cutout.getSafeInsetBottom();
            }
        }
        Log.i(StubContext.TAG, "pinball.screen insets " + values[0] + "," + values[1] + "," + values[2] + "," + values[3]);
        FREArray vector = FREArray.newArray("Number", values.length, true);
        for (int i = 0; i < values.length; i++) {
            vector.setObjectAt(i, FREObject.newObject(values[i]));
        }
        return vector;
    }
}
