package reflipped.shell.common;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.text.Layout;
import android.text.StaticLayout;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/** Labelled connection states; colour is always paired with text and a distinct shape. */
public final class ConnectionBadge extends LinearLayout {
    private final TextView label;
    private final ImageView icon;
    private final ProgressBar spinner;
    private CharSequence[] reserved = new CharSequence[0];

    public ConnectionBadge(Activity activity) {
        super(activity);
        // Top-aligned: a reserved (taller) badge would otherwise centre a short message and leave a gap above it.
        // onLayout lines the mark up with the message's first line instead.
        setGravity(Gravity.TOP);
        setBaselineAligned(false);
        spinner = new ProgressBar(activity);
        spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(Color.rgb(217, 31, 72)));
        spinner.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(spinner, new LayoutParams(ShellDialogs.dp(activity, 24), ShellDialogs.dp(activity, 24)));
        icon = new ImageView(activity);
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(icon, new LayoutParams(ShellDialogs.dp(activity, 24), ShellDialogs.dp(activity, 24)));
        label = ShellDialogs.text(activity, "", 16);
        label.setGravity(Gravity.LEFT);
        label.setPadding(ShellDialogs.dp(activity, 8), ShellDialogs.dp(activity, 10), 0, ShellDialogs.dp(activity, 10));
        addView(label, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1));
        setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        show("neutral", "Choose a server to check its connection");
    }

    /**
     * Keeps room for the tallest of these texts at the current width and font scale, so switching between them
     * (e.g. Checking… to a wrapped error) never changes the badge's height and the list around it never reflows.
     */
    public void reserve(CharSequence... texts) {
        reserved = texts.clone();
        requestLayout();
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        super.onMeasure(widthSpec, heightSpec);
        int width = label.getMeasuredWidth() - label.getCompoundPaddingLeft() - label.getCompoundPaddingRight();
        if (width <= 0 || reserved.length == 0) return;
        int tallest = 0;
        for (CharSequence text : reserved) tallest = Math.max(tallest, textHeight(text, width));
        int needed = tallest + label.getCompoundPaddingTop() + label.getCompoundPaddingBottom() + getPaddingTop()
                + getPaddingBottom();
        if (needed > getMeasuredHeight()) setMeasuredDimension(getMeasuredWidth(), resolveSize(needed, heightSpec));
    }

    @Override
    protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        super.onLayout(changed, left, top, right, bottom);
        Layout layout = label.getLayout();
        if (layout == null || layout.getLineCount() == 0) return;
        // The first line's centre depends only on the font and padding, so it stays put when the text changes.
        int middle = label.getTop() + label.getExtendedPaddingTop() + layout.getLineBaseline(0)
                + (layout.getLineAscent(0) + layout.getLineDescent(0)) / 2;
        for (View mark : new View[] {spinner, icon}) {
            int height = mark.getMeasuredHeight(), markTop = Math.max(getPaddingTop(), middle - height / 2);
            mark.layout(mark.getLeft(), markTop, mark.getRight(), markTop + height);
        }
    }

    private int textHeight(CharSequence text, int width) {
        return textHeight(label, text, width);
    }

    /** Lays the text out the way the view would (same paint, spacing and, where available, line breaking). */
    static int textHeight(TextView label, CharSequence text, int width) {
        if (Build.VERSION.SDK_INT >= 23) {
            return StaticLayout.Builder.obtain(text, 0, text.length(), label.getPaint(), width)
                    .setLineSpacing(label.getLineSpacingExtra(), label.getLineSpacingMultiplier())
                    .setIncludePad(label.getIncludeFontPadding())
                    .setBreakStrategy(label.getBreakStrategy())
                    .setHyphenationFrequency(label.getHyphenationFrequency())
                    .build()
                    .getHeight();
        }
        return new StaticLayout(text, label.getPaint(), width, Layout.Alignment.ALIGN_NORMAL,
                label.getLineSpacingMultiplier(), label.getLineSpacingExtra(), label.getIncludeFontPadding())
                .getHeight();
    }

    /** Card use: smaller text and padding; the reserved height still keeps the card from changing size. */
    public void compact() {
        label.setTextSize(14);
        label.setPadding(ShellDialogs.dp((Activity) getContext(), 8), ShellDialogs.dp((Activity) getContext(), 6), 0,
                ShellDialogs.dp((Activity) getContext(), 6));
        requestLayout();
    }

    public void show(String state, String text) {
        spinner.setVisibility("checking".equals(state) ? View.VISIBLE : View.GONE);
        icon.setVisibility("checking".equals(state) ? View.GONE : View.VISIBLE);
        int color = "ready".equals(state) ? Color.rgb(25, 108, 65)
                : "error".equals(state)   ? Color.rgb(171, 25, 56)
                                            : Color.rgb(89, 97, 113);
        icon.setImageDrawable(mark(state, color));
        label.setText(text);
        label.setTextColor(color);
    }

    /** The code-drawn state mark ("ready", "error", "info", anything else neutral) for use next to other text. */
    static Drawable mark(String state, int color) {
        return new Mark(state, color);
    }

    private static final class Mark extends Drawable {
        private final String state;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final int color;

        Mark(String state, int color) {
            this.state = state;
            this.color = color;
        }

        public void draw(Canvas canvas) {
            canvas.save();
            canvas.translate(getBounds().left, getBounds().top);
            canvas.scale(getBounds().width() / 24f, getBounds().height() / 24f);
            paint.setColor(color);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(2);
            canvas.drawCircle(12, 12, 9, paint);
            if ("ready".equals(state)) {
                canvas.drawLine(7, 12, 10, 15, paint);
                canvas.drawLine(10, 15, 17, 8, paint);
            } else if ("error".equals(state)) {
                canvas.drawLine(12, 6, 12, 13, paint);
                canvas.drawPoint(12, 17, paint);
            } else if ("info".equals(state)) {
                canvas.drawPoint(12, 7, paint);
                canvas.drawLine(12, 11, 12, 17, paint);
            } else {
                paint.setStyle(Paint.Style.FILL);
                canvas.drawCircle(12, 12, 3, paint);
            }
            canvas.restore();
        }

        public void setAlpha(int value) {
            paint.setAlpha(value);
        }

        public void setColorFilter(ColorFilter value) {
            paint.setColorFilter(value);
        }

        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }
}
