package reflipped.shell.common;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/** The same readable card represents a suggestion and the currently checked server. */
public final class ServerCard {
    private ServerCard() {}

    private static TextView label(Activity a, String value, int size, boolean bold) {
        TextView text = ShellDialogs.text(a, value, size);
        text.setGravity(Gravity.LEFT);
        text.setPadding(0, 0, 0, ShellDialogs.dp(a, 6));
        text.setTypeface(Typeface.create("sans-serif", bold ? Typeface.BOLD : Typeface.NORMAL));
        return text;
    }

    public static Holder create(Activity a, ServerDirectory.Entry entry, boolean selected, ServerArtwork artwork) {
        return new Holder(a, entry, selected, artwork);
    }

    public static final class Holder extends LinearLayout {
        private static final int GREY = Color.rgb(89, 97, 113), CORAL = Color.rgb(165, 19, 53);
        private final Activity activity;
        private final ServerArtwork artwork;
        private final TextView badge, title, subline, description, facts;
        private final ReservedText explanation;
        private final ImageView image, progressionIcon;
        private final ConnectionBadge status;
        private String connectionMessage = "";
        private String lastThumbnail = null, nickname = "", providedNote = "";
        private ServerDirectory.Entry entry;
        private boolean liveReported, provided, framed, chosen;
        /** How the title is laid out: 0 not yet, 1 an address on one line, 2 a name (one line, three when selected). */
        private int titleLayout;

        /**
         * Compact layout (QA: the first version showed barely one card per screen): a header with the image, the
         * name, a grey line with "Built-in server" or the address, and a "Selected" badge whose space is always
         * kept; a description clamped to two lines unless the card is selected; one line with the event mode and
         * the owner's type; and the connection status, which keeps the height of its tallest message.
         *
         * An unselected card keeps its height when its server answers for the first time: the name, the address
         * line and the mode line are one line each (an address is never broken in the middle, it's shortened with
         * "…"), and the description always takes two lines. A selected card shows everything in full, plus a line
         * explaining the event mode (room kept for the longest explanation).
         */
        public Holder(Activity a, ServerDirectory.Entry entry, boolean selected, ServerArtwork artwork) {
            super(a);
            this.activity = a;
            this.artwork = artwork;
            setOrientation(VERTICAL);
            int padding = ShellDialogs.dp(a, 10);
            setPadding(padding, padding, padding, ShellDialogs.dp(a, 4));
            LinearLayout.LayoutParams outer = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            outer.topMargin = ShellDialogs.dp(a, 6);
            setLayoutParams(outer);
            LinearLayout heading = new LinearLayout(a);
            heading.setGravity(Gravity.CENTER_VERTICAL);
            image = new ImageView(a);
            image.setScaleType(ImageView.ScaleType.CENTER_CROP);
            image.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            heading.addView(image, new LinearLayout.LayoutParams(ShellDialogs.dp(a, 52), ShellDialogs.dp(a, 52)));
            LinearLayout names = new LinearLayout(a);
            names.setOrientation(VERTICAL);
            LinearLayout titleRow = new LinearLayout(a);
            titleRow.setGravity(Gravity.CENTER_VERTICAL);
            title = label(a, "", 18, true);
            title.setPadding(0, 0, 0, 0);
            title.setMaxLines(1);
            title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            titleRow.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            badge = label(a, "Selected", 12, true);
            badge.setPadding(ShellDialogs.dp(a, 6), 0, 0, 0);
            badge.setTextColor(CORAL);
            titleRow.addView(badge);
            names.addView(titleRow);
            subline = label(a, "", 13, false);
            subline.setPadding(0, ShellDialogs.dp(a, 2), 0, 0);
            subline.setTextColor(GREY);
            subline.setSingleLine(true);
            names.addView(subline);
            LinearLayout.LayoutParams namesParams =
                    new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
            namesParams.leftMargin = ShellDialogs.dp(a, 10);
            heading.addView(names, namesParams);
            addView(heading);
            description = label(a, "", 14, false);
            description.setPadding(0, ShellDialogs.dp(a, 6), 0, 0);
            description.setEllipsize(android.text.TextUtils.TruncateAt.END);
            // Two lines always: a placeholder or short description keeps the room a real one will need.
            description.setMinLines(2);
            addView(description);
            LinearLayout policy = new LinearLayout(a);
            policy.setGravity(Gravity.CENTER_VERTICAL);
            policy.setPadding(0, ShellDialogs.dp(a, 6), 0, 0);
            progressionIcon = new ImageView(a);
            progressionIcon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            policy.addView(
                    progressionIcon, new LinearLayout.LayoutParams(ShellDialogs.dp(a, 18), ShellDialogs.dp(a, 18)));
            facts = label(a, "", 13, false);
            facts.setPadding(ShellDialogs.dp(a, 6), 0, 0, 0);
            facts.setTextColor(GREY);
            facts.setEllipsize(android.text.TextUtils.TruncateAt.END);
            policy.addView(facts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            addView(policy);
            explanation = new ReservedText(a);
            explanation.setTextColor(GREY);
            explanation.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
            explanation.setTextSize(12);
            explanation.setLineSpacing(ShellDialogs.dp(a, 3), 1.05f);
            explanation.setGravity(Gravity.LEFT | Gravity.TOP);
            // Lined up with the mode's text, right of its icon (18dp + 6dp).
            explanation.setPadding(ShellDialogs.dp(a, 24), 0, 0, 0);
            explanation.reserve(Progression.explanations());
            addView(explanation);
            status = new ConnectionBadge(a);
            status.compact();
            addView(status);
            select(selected);
            bind(entry);
        }

        public void select(boolean selected) {
            badge.setVisibility(selected ? View.VISIBLE : View.INVISIBLE);
            description.setMaxLines(selected ? Integer.MAX_VALUE : 2);
            facts.setMaxLines(selected ? 3 : 1);
            explanation.setVisibility(selected ? View.VISIBLE : View.GONE);
            if (chosen != selected) {
                chosen = selected;
                titleLayout = 0;
                if (entry != null) titleLines();
            }
            // Every probe result re-binds the row: rebuild the frame only when the selection changes, so a running
            // touch ripple or focus highlight isn't reset by a background check.
            if (framed && isSelected() == selected) return;
            framed = true;
            setSelected(selected);
            android.graphics.drawable.StateListDrawable focus = new android.graphics.drawable.StateListDrawable();
            focus.addState(new int[] {android.R.attr.state_focused},
                    ShellDialogs.frame(Color.rgb(255, 240, 243), Color.rgb(217, 31, 72), activity));
            focus.addState(new int[] {},
                    ShellDialogs.frame(
                            Color.WHITE, selected ? Color.rgb(217, 31, 72) : Color.rgb(214, 220, 228), activity));
            setBackground(new android.graphics.drawable.RippleDrawable(
                    android.content.res.ColorStateList.valueOf(Color.rgb(255, 223, 231)), focus, null));
        }

        public void connection(String state, String message) {
            connectionMessage = message;
            status.show(state, message);
            status.setContentDescription(entry.name + ". " + message);
            describe();
        }

        public void providedNote(String value) {
            if (providedNote.equals(value)) return;
            providedNote = value;
            if (entry != null) {
                displayNames();
                describe();
            }
        }

        public void provided(boolean value) {
            if (provided == value) return;
            provided = value;
            if (entry != null) {
                displayNames();
                describe();
            }
        }

        /** Every connection message this card can show; its status line keeps the tallest one's height. */
        public void reserveStatus(String... messages) {
            status.reserve(messages);
        }

        public void releaseArtwork() {
            artwork.unbind(image);
        }

        public void nickname(String value) {
            nickname = value == null ? "" : value;
            if (entry != null) displayNames();
        }

        /** The server answered this session, so what it didn't report is "not shared" rather than unknown. */
        public void reported() {
            if (liveReported) return;
            liveReported = true;
            if (entry != null) {
                displayNames();
                describe();
            }
        }

        private boolean placeholder() {
            return !liveReported && entry.placeholder();
        }

        private String host() {
            try {
                java.net.URI address = new java.net.URI(entry.address);
                String host = address.getHost();
                String shown = host == null ? entry.address : host + (address.getPort() > 0 ? ":" + address.getPort() : "");
                // Only a plain-HTTP address says so; HTTPS is the normal case.
                return "http".equalsIgnoreCase(address.getScheme()) ? "http://" + shown : shown;
            } catch (Exception invalid) {
                return entry.address;
            }
        }

        /**
         * An address title stays on one line, shortened in the middle so its port shows (at 1.5× text "10.0.2.2:8303"
         * used to break mid-way); a name takes one line, or up to three on the selected card.
         */
        private void titleLines() {
            int wanted = nickname.isEmpty() && placeholder() ? 1 : 2;
            if (titleLayout == wanted) return;
            titleLayout = wanted;
            if (wanted == 1) {
                title.setSingleLine(true);
                title.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
            } else {
                title.setSingleLine(false);
                title.setMaxLines(chosen ? 3 : 1);
                title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            }
        }

        private void displayNames() {
            title.setText(!nickname.isEmpty() ? nickname : placeholder() ? host() : entry.name);
            titleLines();
            // The address first, so a long reported name is what gets shortened; an address alone keeps its port.
            boolean named = !nickname.isEmpty() && !placeholder() && !nickname.equals(entry.name);
            // An address already in the title isn't repeated under it.
            boolean addressTitle = nickname.isEmpty() && placeholder();
            subline.setText(provided ? "Built-in server" : addressTitle ? "Custom server"
                    : named ? host() + " · " + entry.name : host());
            subline.setEllipsize(provided || named ? android.text.TextUtils.TruncateAt.END
                                                   : android.text.TextUtils.TruncateAt.MIDDLE);
            String actual = entry.description;
            String shown = providedNote.isEmpty()
                    ? (placeholder() ? "Details appear when this server answers." : actual)
                    : actual.isEmpty() || providedNote.equals(actual) ? providedNote : providedNote + "\n" + actual;
            // Generic placeholder when the server sends no description (older servers, or none set yet).
            if (shown.isEmpty())
                shown = liveReported ? "This server has no description yet." : "Details appear when this server answers.";
            description.setText(shown);
            description.setVisibility(View.VISIBLE);
            boolean local = "local".equals(entry.mode);
            boolean known = !entry.progression.mode.isEmpty();
            String mode = known || liveReported ? entry.progression.label() : Progression.UNKNOWN;
            String kind = !entry.type.isEmpty() ? entry.type : liveReported ? "Community server" : "";
            facts.setText(mode + (kind.isEmpty() ? "" : " · " + kind) + (local ? " · Local play, not available yet" : ""));
            explanation.setText(
                    known || liveReported ? entry.progression.explanation() : Progression.UNKNOWN_EXPLANATION);
        }

        private void describe() {
            setContentDescription(title.getText() + ". " + subline.getText() + ". " + description.getText() + ". "
                    + facts.getText() + ". " + explanation.getText()
                    + (provided ? " Built-in server, can't be edited or removed." : "") + " " + connectionMessage);
        }

        public void bind(ServerDirectory.Entry entry) {
            this.entry = entry;
            displayNames();
            progressionIcon.setImageDrawable(new ProgressionArt(entry.progression.mode));
            describe();
            if (!entry.thumbnail.equals(lastThumbnail)) {
                lastThumbnail = entry.thumbnail;
                artwork.bind(activity, image, entry.thumbnail, new ModeArt("local".equals(entry.mode)));
            }
        }
    }

    /** Text that keeps the height of the tallest of its possible texts, like {@link ConnectionBadge#reserve}. */
    private static final class ReservedText extends TextView {
        private CharSequence[] reserved = new CharSequence[0];

        ReservedText(Activity a) {
            super(a);
        }

        void reserve(CharSequence... texts) {
            reserved = texts.clone();
            requestLayout();
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            super.onMeasure(widthSpec, heightSpec);
            int width = getMeasuredWidth() - getCompoundPaddingLeft() - getCompoundPaddingRight();
            if (width <= 0 || reserved.length == 0) return;
            int tallest = 0;
            for (CharSequence text : reserved) tallest = Math.max(tallest, ConnectionBadge.textHeight(this, text, width));
            int needed = tallest + getCompoundPaddingTop() + getCompoundPaddingBottom();
            if (needed > getMeasuredHeight()) setMeasuredDimension(getMeasuredWidth(), resolveSize(needed, heightSpec));
        }
    }

    private static final class ProgressionArt extends Drawable {
        private final String mode;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        ProgressionArt(String mode) {
            this.mode = mode;
        }

        public void draw(Canvas canvas) {
            canvas.save();
            canvas.translate(getBounds().left, getBounds().top);
            canvas.scale(getBounds().width() / 24f, getBounds().height() / 24f);
            paint.setColor(mode.isEmpty() ? Color.rgb(89, 97, 113) : Color.rgb(165, 19, 53));
            paint.setStrokeWidth(1.8f);
            paint.setStyle(Paint.Style.STROKE);
            if ("accelerated".equals(mode) || "time-travel".equals(mode)) {
                boolean reverse = "time-travel".equals(mode);
                canvas.save();
                if (reverse) {
                    canvas.translate(24, 0);
                    canvas.scale(-1, 1);
                }
                for (int x : new int[] {3, 12}) {
                    android.graphics.Path path = new android.graphics.Path();
                    path.moveTo(x, 5);
                    path.lineTo(x + 8, 12);
                    path.lineTo(x, 19);
                    path.close();
                    canvas.drawPath(path, paint);
                }
                canvas.restore();
            } else if ("manual".equals(mode)) {
                for (int i = 0; i < 3; i++) {
                    float y = 5 + i * 7;
                    float x = i == 1 ? 15 : 8;
                    canvas.drawLine(3, y, x - 2, y, paint);
                    canvas.drawLine(x + 2, y, 21, y, paint);
                    canvas.drawCircle(x, y, 2, paint);
                }
            } else if ("classic".equals(mode) || "legacy".equals(mode)) {
                canvas.drawCircle(12, 12, 9, paint);
                canvas.drawLine(12, 6, 12, 12, paint);
                canvas.drawLine(12, 12, 17, 15, paint);
                if ("legacy".equals(mode)) canvas.drawLine(3, 3, 7, 3, paint);
            } else {
                canvas.drawCircle(12, 12, 9, paint);
                canvas.drawLine(12, 10, 12, 17, paint);
                canvas.drawPoint(12, 7, paint);
            }
            canvas.restore();
        }

        public void setAlpha(int alpha) {
            paint.setAlpha(alpha);
        }

        public void setColorFilter(ColorFilter filter) {
            paint.setColorFilter(filter);
        }

        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }

    private static final class ModeArt extends Drawable {
        private final boolean local;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        ModeArt(boolean local) {
            this.local = local;
        }

        public void draw(Canvas canvas) {
            canvas.save();
            canvas.translate(getBounds().left, getBounds().top);
            canvas.scale(getBounds().width() / 64f, getBounds().height() / 64f);
            paint.setColor(Color.rgb(243, 246, 250));
            paint.setStyle(Paint.Style.FILL);
            canvas.drawRect(0, 0, 64, 64, paint);
            paint.setColor(Color.rgb(89, 97, 113));
            paint.setStrokeWidth(2.5f);
            paint.setStyle(Paint.Style.STROKE);
            if (local) {
                canvas.drawRoundRect(19, 12, 45, 52, 4, 4, paint);
                canvas.drawLine(28, 46, 36, 46, paint);
            } else {
                canvas.drawCircle(32, 32, 22, paint);
                canvas.drawOval(22, 10, 42, 54, paint);
                canvas.drawLine(10, 32, 54, 32, paint);
            }
            canvas.restore();
        }

        public void setAlpha(int alpha) {
            paint.setAlpha(alpha);
        }

        public void setColorFilter(ColorFilter filter) {
            paint.setColorFilter(filter);
        }

        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }
}
