package reflipped.shell.content;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

import reflipped.shell.common.ShellDialogs;
import reflipped.shell.common.StubContext;

/**
 * The import build's first-launch screens: one full-screen window whose content changes (a choice, progress, a
 * problem). Colours are the admin site's theme tokens (docs/admin-theme.md), light or dark with the phone's theme.
 */
final class ImportScreens {
    /** docs/admin-theme.md roles: background, surface-container, on-surface, on-surface-variant, outline-variant, primary, on-primary, error. */
    private static final int[] LIGHT = {0xFFE1E2E7, 0xFFE6E7ED, 0xFF343B58, 0xFF4A5788, 0xFFA8AECB, 0xFF5B239D, 0xFFFFFFFF, 0xFF94123B};
    private static final int[] DARK = {0xFF1A1B26, 0xFF24283B, 0xFFC0CAF5, 0xFFA9B1D6, 0xFF3B4261, 0xFFBD93F9, 0xFF1A1B26, 0xFFFF5555};
    private static final int BACKGROUND = 0, SURFACE = 1, ON_SURFACE = 2, VARIANT = 3, OUTLINE = 4, PRIMARY = 5,
            ON_PRIMARY = 6, ERROR = 7;

    private final Activity activity;
    private final int[] color;
    private Dialog dialog;
    private LinearLayout card;
    private String progressTitle;
    private ProgressBar bar;
    private TextView step;

    ImportScreens(Activity activity) {
        this.activity = activity;
        boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        color = dark ? DARK : LIGHT;
    }

    /**
     * Shows a screen with buttons (the first is the main action) and waits for one; returns its index. `back` is the
     * index Android's Back button chooses, or -1 to ignore Back. Call off the UI thread.
     */
    int ask(String title, String body, String note, boolean problem, int back, String... buttons) throws InterruptedException {
        BlockingQueue<Integer> answer = new ArrayBlockingQueue<>(1);
        activity.runOnUiThread(() -> {
            try {
                LinearLayout content = screen(title, body, note, problem);
                for (int i = 0; i < buttons.length; i++) {
                    final int index = i;
                    Button button = button(buttons[i], i == 0);
                    button.setOnClickListener(v -> answer.offer(index));
                    content.addView(button);
                }
                dialog.setOnKeyListener((d, key, event) -> {
                    if (key != KeyEvent.KEYCODE_BACK) return false;
                    if (back >= 0 && event.getAction() == KeyEvent.ACTION_UP) answer.offer(back);
                    return true;
                });
            } catch (RuntimeException failure) {
                // e.g. the activity is gone: never pick an answer for the player, let the caller show it again
                android.util.Log.w(StubContext.TAG, "import screen failed (" + failure.getClass().getSimpleName() + ")");
                answer.offer(STALE);
            }
        });
        while (true) {
            Integer chosen = answer.poll(500, java.util.concurrent.TimeUnit.MILLISECONDS);
            if (chosen != null) return chosen;
            if (stale()) return STALE;  // Android destroyed the activity under the screen: nobody can answer it
        }
    }

    /** What {@link #ask} returns when its screen can't be answered any more (its activity is gone). */
    static final int STALE = -1000;

    /** True when this window's activity is gone (Android may recreate the game's activity in the same process). */
    boolean stale() {
        return activity.isDestroyed() || activity.isFinishing();
    }

    boolean belongsTo(Activity current) {
        return activity == current;
    }

    /** Shows (or updates) a progress screen. `percent` < 0 shows a spinner-like bar. Any thread. */
    void progress(String title, String body, String stepText, int percent) {
        activity.runOnUiThread(() -> {
            try {
                if (!title.equals(progressTitle) || bar == null) {
                    LinearLayout content = screen(title, body, null, false);
                    progressTitle = title;
                    bar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
                    bar.setMax(100);
                    bar.setProgressTintList(android.content.res.ColorStateList.valueOf(color[PRIMARY]));
                    bar.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(color[PRIMARY]));
                    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, dp(12));
                    params.topMargin = dp(8);
                    content.addView(bar, params);
                    step = text("", 14, color[VARIANT], false);
                    content.addView(step);
                    dialog.setOnKeyListener((d, key, event) -> key == KeyEvent.KEYCODE_BACK);
                }
                bar.setIndeterminate(percent < 0);
                if (percent >= 0) bar.setProgress(percent);
                step.setText(stepText);
            } catch (RuntimeException failure) {
                android.util.Log.w(StubContext.TAG, "import progress failed (" + failure.getClass().getSimpleName() + ")");
            }
        });
    }

    /** Changes the step line of a progress screen that is showing (nothing otherwise). Any thread. */
    void step(String stepText) {
        activity.runOnUiThread(() -> {
            if (bar == null || step == null) return;
            bar.setIndeterminate(true);
            step.setText(stepText);
        });
    }

    /** Removes the screens. Any thread. */
    void close() {
        activity.runOnUiThread(() -> {
            Dialog open = dialog;
            dialog = null;
            card = null;
            bar = null;
            progressTitle = null;
            if (open != null) {
                try {
                    open.dismiss();
                } catch (RuntimeException ignored) {
                    // the window is already gone
                }
            }
        });
    }

    // ---------------------------------------------------------------- layout (UI thread)

    private LinearLayout screen(String title, String body, String note, boolean problem) {
        if (dialog == null) open();
        card.removeAllViews();
        progressTitle = null;
        bar = null;
        TextView heading = text(title, 22, color[ON_SURFACE], true);
        heading.setPadding(0, 0, 0, dp(10));
        card.addView(heading);
        if (body != null) card.addView(text(body, 16, color[ON_SURFACE], false));
        if (note != null) {
            TextView notice = text(note, 15, problem ? color[ERROR] : color[PRIMARY], false);
            GradientDrawable tint = new GradientDrawable();
            tint.setColor(mix(problem ? color[ERROR] : color[PRIMARY], 0.10f));
            tint.setCornerRadius(dp(10));
            notice.setBackground(tint);
            notice.setPadding(dp(14), dp(10), dp(14), dp(10));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            params.topMargin = dp(4);
            params.bottomMargin = dp(8);
            card.addView(notice, params);
        }
        return card;
    }

    private void open() {
        dialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar_Fullscreen);
        FrameLayout root = new FrameLayout(activity);
        root.setBackgroundColor(color[BACKGROUND]);
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        root.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        LinearLayout column = new LinearLayout(activity);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER);
        column.setPadding(dp(16), dp(24), dp(16), dp(24));
        scroll.addView(column, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout brand = new LinearLayout(activity);
        brand.setOrientation(LinearLayout.HORIZONTAL);
        brand.setGravity(Gravity.CENTER_VERTICAL);
        try {
            Drawable icon = activity.getPackageManager().getApplicationIcon(activity.getApplicationInfo());
            ImageView image = new ImageView(activity);
            image.setImageDrawable(icon);
            brand.addView(image, new LinearLayout.LayoutParams(dp(48), dp(48)));
        } catch (RuntimeException ignored) {
            // no icon: the name alone
        }
        TextView name = text("Reflipped", 24, color[ON_SURFACE], true);
        name.setPadding(dp(12), 0, 0, 0);
        brand.addView(name);
        LinearLayout.LayoutParams brandParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        brandParams.bottomMargin = dp(20);
        column.addView(brand, brandParams);

        card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(20), dp(20), dp(20), dp(20));
        GradientDrawable surface = new GradientDrawable();
        surface.setColor(color[SURFACE]);
        surface.setCornerRadius(dp(16));
        surface.setStroke(dp(1), mix(color[OUTLINE], 0.6f));
        card.setBackground(surface);
        int width = Math.min(dp(560), activity.getResources().getDisplayMetrics().widthPixels - dp(32));
        column.addView(card, new LinearLayout.LayoutParams(width, ViewGroup.LayoutParams.WRAP_CONTENT));

        dialog.setContentView(root);
        dialog.setCancelable(false);
        Window window = dialog.getWindow();
        dialog.show();
        if (window != null) {
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            if (android.os.Build.VERSION.SDK_INT >= 28) {  // draw beside a camera cutout too, not a black strip
                android.view.WindowManager.LayoutParams attributes = window.getAttributes();
                attributes.layoutInDisplayCutoutMode =
                        android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(attributes);
            }
            ShellDialogs.keepClearOfSystemBars(window, root);
            window.setStatusBarColor(color[BACKGROUND]);
            window.setNavigationBarColor(color[BACKGROUND]);
        }
    }

    private TextView text(String value, int size, int ink, boolean bold) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextColor(ink);
        view.setTextSize(size);
        view.setTypeface(Typeface.create("sans-serif", bold ? Typeface.BOLD : Typeface.NORMAL));
        view.setLineSpacing(dp(2), 1.05f);
        view.setPadding(0, dp(4), 0, dp(8));
        return view;
    }

    private Button button(String label, boolean primary) {
        Button button = new Button(activity);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(17);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        button.setTextColor(primary ? color[ON_PRIMARY] : color[PRIMARY]);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(primary ? color[PRIMARY] : Color.TRANSPARENT);
        shape.setCornerRadius(dp(12));
        shape.setStroke(dp(1), primary ? color[PRIMARY] : color[OUTLINE]);
        button.setBackground(shape);
        button.setStateListAnimator(null);
        button.setMinHeight(dp(52));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(10);
        button.setLayoutParams(params);
        return button;
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    /** `ink` at `alpha` over the card's surface. */
    private int mix(int ink, float alpha) {
        int base = color[SURFACE];
        return Color.rgb(
                Math.round(Color.red(ink) * alpha + Color.red(base) * (1 - alpha)),
                Math.round(Color.green(ink) * alpha + Color.green(base) * (1 - alpha)),
                Math.round(Color.blue(ink) * alpha + Color.blue(base) * (1 - alpha)));
    }
}
