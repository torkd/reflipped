package reflipped.shell.common;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

/** Keyboard-safe panels matching the original game's white/pale-pink frames, charcoal text and coral actions. */
public final class ShellDialogs {
    public static final int INK = Color.rgb(37, 43, 53);
    public static final int SURFACE = Color.WHITE;
    private static final int FRAME = Color.rgb(248, 239, 249);
    private static final int ACCENT = Color.rgb(217, 31, 72);
    private static final int ACCENT_RIM = Color.rgb(255, 111, 139);
    private static final int OUTLINE = Color.rgb(228, 231, 234);

    private ShellDialogs() { }

    public static int dp(Activity activity, int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    public static GradientDrawable frame(int color, int border, Activity activity) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(activity, 10));
        background.setStroke(dp(activity, 2), border);
        return background;
    }

    public static LinearLayout panel(Activity activity, String title) {
        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(activity, 18), dp(activity, 14), dp(activity, 18), dp(activity, 18));
        root.setBackground(frame(SURFACE, FRAME, activity));
        root.setElevation(dp(activity, 8));
        if (title != null && !title.isEmpty()) {
            TextView heading = text(activity, title, 24);
            heading.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
            heading.setGravity(Gravity.CENTER);
            heading.setPadding(0, dp(activity, 6), 0, dp(activity, 16));
            root.addView(heading);
        }
        return root;
    }

    public static TextView text(Activity activity, String value, int size) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextColor(INK);
        view.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        view.setTextSize(size);
        view.setGravity(Gravity.CENTER);
        view.setLineSpacing(dp(activity, 3), 1.05f);
        view.setPadding(0, dp(activity, 6), 0, dp(activity, 12));
        return view;
    }

    public static Button button(Activity activity, String label, boolean primary) {
        Button button = new Button(activity);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(18);
        button.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        button.setTextColor(primary ? Color.WHITE : INK);
        button.setBackground(frame(primary ? ACCENT : SURFACE, primary ? ACCENT_RIM : OUTLINE, activity));
        button.setElevation(dp(activity, 4));
        button.setMinHeight(dp(activity, 52));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(activity, 10);
        button.setLayoutParams(params);
        return button;
    }

    /**
     * Enables or disables a button made by {@link #button}. A disabled one turns grey with dark grey text (about 5.6:1)
     * instead of fading: a faded coral Join was white on pale pink, about 1.8:1.
     */
    public static void enable(Activity activity, Button button, boolean enabled, boolean primary) {
        button.setEnabled(enabled);
        button.setAlpha(1f);
        if (enabled) {
            button.setTextColor(primary ? Color.WHITE : INK);
            button.setBackground(frame(primary ? ACCENT : SURFACE, primary ? ACCENT_RIM : OUTLINE, activity));
        } else {
            button.setTextColor(Color.rgb(89, 97, 113));
            button.setBackground(frame(Color.rgb(241, 243, 245), OUTLINE, activity));
        }
    }

    /** Call after show(): sizing before show is overwritten by Android's dialog decor setup. */
    public static void size(Activity activity, Dialog dialog, boolean tall) {
        Window window = dialog.getWindow();
        if (window == null) return;
        window.setBackgroundDrawableResource(android.R.color.transparent);
        window.setGravity(Gravity.CENTER);
        window.setDimAmount(.18f);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        int width = Math.min(dp(activity, 560), (int) (activity.getResources().getDisplayMetrics().widthPixels * .94f));
        int height = tall ? (int) (activity.getResources().getDisplayMetrics().heightPixels * .9f)
                : ViewGroup.LayoutParams.WRAP_CONTENT;
        window.setLayout(width, height);
        if (!tall) {
            // Centred panels touched the title screen's logo; sit a little lower (Android keeps them on screen).
            WindowManager.LayoutParams position = window.getAttributes();
            position.y = dp(activity, 40);
            window.setAttributes(position);
        }
    }

    /**
     * Lets a full-screen dialog draw behind the status and navigation bars and pads `root` by them (and by a display
     * cutout or the keyboard), so its top bar sits below the status bar instead of against or under it, the same on
     * every Android version. The bars get the panels' charcoal behind their white icons.
     */
    @SuppressWarnings("deprecation") // the pre-Android 11 flags are the only way there
    public static void keepClearOfSystemBars(Window window, View root) {
        window.setStatusBarColor(INK);
        window.setNavigationBarColor(INK);
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
        } else {
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            }
            // with adjustResize, these include the keyboard
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        root.requestApplyInsets();
    }

    // ---------------------------------------------------------------- "Signing out…" cover

    /** Long enough for the game to restart into the next shell dialog; a cover never stays up for good. */
    private static final long BUSY_LIMIT_MS = 30000;
    private static Dialog busy;

    /**
     * Covers the whole screen with `message` and a spinner, e.g. "Signing out…" while the game restarts behind it.
     * It stays until the next shell dialog has appeared ({@link #show}), {@link #endBusy}, or a time limit. Any thread.
     */
    public static void busy(Activity activity, String message) {
        activity.runOnUiThread(() -> {
            try {
                endBusyNow();
                Dialog cover = new Dialog(activity, android.R.style.Theme_DeviceDefault_Light_NoActionBar_Fullscreen);
                LinearLayout root = new LinearLayout(activity);
                root.setOrientation(LinearLayout.VERTICAL);
                root.setGravity(Gravity.CENTER);
                root.setBackgroundColor(SURFACE);
                root.addView(new ProgressBar(activity), new LinearLayout.LayoutParams(dp(activity, 48), dp(activity, 48)));
                TextView label = text(activity, message, 18);
                label.setPadding(0, dp(activity, 16), 0, 0);
                root.addView(label);
                cover.setContentView(root);
                cover.setCancelable(false);
                cover.setOnKeyListener((d, key, event) -> key == android.view.KeyEvent.KEYCODE_BACK);
                cover.show();
                busy = cover;
                root.postDelayed(() -> { if (busy == cover) endBusyNow(); }, BUSY_LIMIT_MS);
            } catch (RuntimeException failure) {
                android.util.Log.w(StubContext.TAG, "can't show the busy cover (" + failure.getClass().getSimpleName() + ")");
            }
        });
    }

    /** A full-screen progress cover: {@link #set} the bar (percent below 0: unknown) and text, then {@link #close}. */
    public static final class Progress {
        private final Activity activity;
        private Dialog dialog;
        private ProgressBar bar;
        private TextView detail;

        private Progress(Activity activity) { this.activity = activity; }

        /** Any thread. */
        public void set(int percent, String text) {
            activity.runOnUiThread(() -> {
                if (bar == null) return;
                bar.setIndeterminate(percent < 0);
                if (percent >= 0) bar.setProgress(Math.min(100, percent));
                detail.setText(text);
            });
        }

        /** Any thread. */
        public void close() {
            activity.runOnUiThread(() -> {
                Dialog shown = dialog;
                dialog = null;
                bar = null;
                if (shown != null) try { shown.dismiss(); } catch (RuntimeException ignored) { /* already gone */ }
            });
        }
    }

    /** Shows a {@link Progress} cover with a title over a bar and a line of detail; Back does nothing. Any thread. */
    public static Progress progress(Activity activity, String title, String text) {
        Progress progress = new Progress(activity);
        activity.runOnUiThread(() -> {
            try {
                endBusyNow();
                Dialog cover = new Dialog(activity, android.R.style.Theme_DeviceDefault_Light_NoActionBar_Fullscreen);
                LinearLayout root = new LinearLayout(activity);
                root.setOrientation(LinearLayout.VERTICAL);
                root.setGravity(Gravity.CENTER);
                root.setBackgroundColor(SURFACE);
                int side = dp(activity, 32);
                root.setPadding(side, 0, side, 0);
                TextView heading = text(activity, title, 20);
                heading.setGravity(Gravity.CENTER);
                root.addView(heading);
                ProgressBar bar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
                bar.setMax(100);
                bar.setIndeterminate(true);
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT);
                params.topMargin = dp(activity, 24);
                root.addView(bar, params);
                TextView detail = text(activity, text, 15);
                detail.setGravity(Gravity.CENTER);
                detail.setPadding(0, dp(activity, 12), 0, 0);
                root.addView(detail);
                cover.setContentView(root);
                cover.setCancelable(false);
                cover.setOnKeyListener((d, key, event) -> key == android.view.KeyEvent.KEYCODE_BACK);
                cover.show();
                progress.dialog = cover;
                progress.bar = bar;
                progress.detail = detail;
            } catch (RuntimeException failure) {
                android.util.Log.w(StubContext.TAG, "can't show the progress cover (" + failure.getClass().getSimpleName() + ")");
            }
        });
        return progress;
    }

    /** Removes the {@link #busy} cover, if any. Any thread. */
    public static void endBusy(Activity activity) {
        activity.runOnUiThread(ShellDialogs::endBusyNow);
    }

    private static void endBusyNow() {
        Dialog cover = busy;
        busy = null;
        if (cover == null) return;
        try { cover.dismiss(); } catch (RuntimeException ignored) { /* its window is already gone */ }
    }

    /**
     * A message with one button, or a two-button confirmation (secondary left, primary right, like the game's own).
     * Returns the index of the chosen label; index 0 is the primary action. Call off the UI thread.
     */
    public static int choose(Activity activity, String title, String message, String... labels) throws Exception {
        return show(activity, title, message, labels.length == 2, null, -1, labels);
    }

    /** A two-button confirmation where Android Back means `secondary` (index 1). */
    public static int confirm(Activity activity, String title, String message, String primary, String secondary)
            throws Exception {
        return show(activity, title, message, true, null, 1, primary, secondary);
    }

    /** Full-width rows, the first one primary, where Android Back means the row at index `back`. */
    public static int chooseRowWithBack(Activity activity, String title, String message, int back, String... labels)
            throws Exception {
        return show(activity, title, message, false, null, back, labels);
    }

    /**
     * Choices as full-width rows, the first one primary. `unavailable`, if not null, is added as a last, disabled row
     * with a "Not available yet" note and can't be chosen. Returns the index of the chosen label. Call off the UI thread.
     */
    public static int chooseRow(Activity activity, String title, String message, String unavailable, String... labels)
            throws Exception {
        if (unavailable == null) return show(activity, title, message, false, null, -1, labels);
        String[] rows = java.util.Arrays.copyOf(labels, labels.length + 1);
        rows[labels.length] = unavailable;
        return show(activity, title, message, false, unavailable, -1, rows);
    }

    private static int show(Activity activity, String title, String message, boolean confirmation, String unavailable,
                            int back, String... labels) throws Exception {
        final BlockingQueue<Object> answer = new ArrayBlockingQueue<>(1);
        activity.runOnUiThread(() -> {
            try {
                Dialog dialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar);
                LinearLayout root = panel(activity, title);
                root.addView(text(activity, message, 16));
                android.view.View divider = new android.view.View(activity);
                divider.setBackgroundColor(OUTLINE);
                root.addView(divider, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(activity, 1)));
                LinearLayout actions = root;
                if (confirmation) {
                    actions = new LinearLayout(activity);
                    actions.setOrientation(LinearLayout.HORIZONTAL);
                    actions.setBaselineAligned(false);
                    actions.setGravity(Gravity.CENTER_VERTICAL);
                    root.addView(actions);
                }
                for (int row = 0; row < labels.length; row++) {
                    int i = confirmation ? labels.length - 1 - row : row;
                    final int selected = i;
                    String label = labels[i];
                    boolean enabled = unavailable == null || i < labels.length - 1;
                    Button button = button(activity, label, i == 0);
                    button.setEnabled(enabled);
                    if (!enabled) button.setAlpha(.5f);
                    button.setOnClickListener(v -> { answer.offer(selected); dialog.dismiss(); });
                    if (confirmation) {
                        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
                        params.topMargin = dp(activity, 10);
                        params.bottomMargin = dp(activity, 10);
                        if (row == 0) params.rightMargin = dp(activity, 8);
                        button.setLayoutParams(params);
                        button.setMinWidth(0);
                    }
                    actions.addView(button);
                    if (!enabled) {
                        TextView availability = text(activity, "Not available yet", 14);
                        availability.setGravity(Gravity.CENTER);
                        actions.addView(availability);
                    }
                }
                ScrollView scroll = new ScrollView(activity);
                scroll.addView(root);
                dialog.setContentView(scroll);
                dialog.setCancelable(false);
                if (back >= 0) {
                    dialog.setOnKeyListener((d, key, event) -> {
                        if (key != android.view.KeyEvent.KEYCODE_BACK) return false;
                        if (event.getAction() == android.view.KeyEvent.ACTION_UP) {
                            answer.offer(back);
                            dialog.dismiss();
                        }
                        return true;
                    });
                }
                dialog.show();
                size(activity, dialog, false);
                // only now, so the game's restart behind a "Signing out" cover never shows in between
                endBusyNow();
            } catch (Throwable error) {
                endBusyNow();
                answer.offer(error);
            }
        });
        Object result = answer.take();
        if (result instanceof Throwable) throw new IllegalStateException("Cannot show game dialog", (Throwable) result);
        return (Integer) result;
    }

    public interface AddressChecker<T> { T check(String address) throws Exception; ServerDirectory.Entry entry(T result); }

    /** Dedicated server browser. Returns only after explicit Join, or null on Back. */
    public static <T> T address(Activity activity, String initial, AddressChecker<T> checker, ServerBrowser.Memory memory)
            throws Exception {
        return ServerBrowser.open(activity, initial, checker, memory);
    }
}
