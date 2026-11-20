package reflipped.shell.common;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Dedicated browser: explicit navigation changes views; asynchronous probes only update existing rows. */
public final class ServerBrowser<T> {
    // Card connection messages; each card reserves room for the tallest, so a finished check never resizes it.
    private static final String NOT_CHECKED = "Not checked yet", CHECKING = "Checking…", READY = "Ready to play",
            NO_ANSWER = "No answer from this server. Tap to try again.",
            NOT_FOUND = "Can't find this address. Tap to try again.",
            NOT_REFLIPPED = "This address isn't a Reflipped server. Tap to try again.",
            NOT_READY = "This server isn't ready right now. Tap to try again later.",
            MOVED = "This address has moved. Edit it to the server's new address.";
    // Add/Edit form messages, reserved the same way in the form's status line.
    private static final String FORM_EMPTY = "Paste a server address to get started",
            FORM_INVALID = "This doesn't look like a server address.",
            FORM_NO_ANSWER = "No server answers at this address right now. You can still save it.",
            FORM_NOT_FOUND = "Can't find this address. Check the spelling.",
            FORM_NOT_REFLIPPED = "This address answers, but it isn't a Reflipped server.",
            FORM_NOT_READY = "This server isn't ready right now. You can still save it.",
            FORM_MOVED = "This address points somewhere else. Use the server's final address, usually with https://.",
            FORM_FOUND = "Found: ", FORM_FOUND_SAMPLE = "Found: A server name about forty characters long",
            FORM_SAVE_ANYWAY = " You can still save it.";

    /** Which check failure says most: something that answered beats silence, which beats an unknown name. */
    private static int rank(Exception failure) {
        if (failure instanceof ServerSetup.NeedsUpdate) return 4;
        if (failure instanceof ServerSetup.NotReflipped || failure instanceof ServerSetup.NotReady) return 3;
        if (failure instanceof java.net.UnknownHostException) return 1;
        return 2;
    }

    private static String cardMessage(Exception failure) {
        // SH-15: a server this app version can't join says why, e.g. "needs a newer Reflipped app (version 0.2.0 or later)"
        if (failure instanceof ServerSetup.NeedsUpdate) return failure.getMessage();
        if (failure instanceof ServerSetup.Moved) return MOVED;
        if (failure instanceof ServerSetup.NotReady) return NOT_READY;
        if (failure instanceof ServerSetup.NotReflipped) return NOT_REFLIPPED;
        if (failure instanceof java.net.UnknownHostException) return NOT_FOUND;
        return NO_ANSWER;
    }

    private static String formMessage(Exception failure) {
        if (failure instanceof ServerSetup.NeedsUpdate) return failure.getMessage() + FORM_SAVE_ANYWAY;
        if (failure instanceof ServerSetup.Moved) return FORM_MOVED;
        if (failure instanceof ServerSetup.NotReady) return FORM_NOT_READY;
        if (failure instanceof ServerSetup.NotReflipped) return FORM_NOT_REFLIPPED;
        if (failure instanceof java.net.UnknownHostException) return FORM_NOT_FOUND;
        return FORM_NO_ANSWER;
    }
    private final Activity activity;
    private final ShellDialogs.AddressChecker<T> checker;
    private final BlockingQueue<Object> answer;
    private final List<ServerDirectory.Entry> community;
    private final ProvidedOrigins provided;
    private final List<String> providedAddresses = new ArrayList<>();
    private final Map<String, String> providedNotes = new LinkedHashMap<>();
    private final Map<String, Record> records = new LinkedHashMap<>();
    private final Map<String, Row> rows = new LinkedHashMap<>();
    private final ServerProbeQueues worker = new ServerProbeQueues();
    private final JoinGuard joinGuard = new JoinGuard();
    private final ServerArtwork artwork = new ServerArtwork();
    private Dialog dialog;
    private LinearLayout list;
    private ScrollView scroll;
    private Button join, edit, remove;
    private TextView emptyState;
    private TextView notice;
    /** The notice shows a message from the last action; otherwise it explains the disabled buttons. */
    private boolean noticeFromAction;
    private String selected;
    private boolean closed;

    private final class Record {
        ServerDirectory.Entry entry;
        final boolean provided, local;
        final String providedNote;
        String nickname = "", state = "neutral", message = NOT_CHECKED;
        final AddressCheckState generation = new AddressCheckState();
        T verified;
        java.util.concurrent.ScheduledFuture<?> pending;

        Record(ServerDirectory.Entry entry) {
            this.entry = entry;
            provided = ServerBrowser.this.provided.contains(entry.address);
            local = "local".equals(entry.mode);
            String note = providedNotes.get(ServerIdentity.origin(entry.address));
            providedNote = note == null ? "" : note;
        }
    }

    private final class Row {
        final ServerCard.Holder card;
        final LinearLayout group;
        ServerDirectory.Entry bound;
        String nickname = "", state = "", message = "";

        Row(ServerCard.Holder card, LinearLayout group) {
            this.card = card;
            this.group = group;
        }
    }

    /**
     * What one setup visit keeps between openings of the browser (after the switch warning or the account choice sends
     * the player back): each server's last check result and the scroll position.
     */
    public static final class Memory {
        private final Map<String, Object[]> checks = new LinkedHashMap<>();
        private int scrollY = -1;
        private boolean onlineOnly;

        /** Leaves the server on this phone out of the list (Local play's choice of an online source, SH-27). */
        public Memory onlineOnly() {
            onlineOnly = true;
            return this;
        }
    }

    private final Memory memory;
    /** Servers checked automatically this opening, so scrolling past a card checks it once. */
    private final java.util.Set<String> autoChecked = new java.util.HashSet<>();
    private android.view.ViewTreeObserver.OnScrollChangedListener scrolled;

    private ServerBrowser(Activity activity, String initial, ShellDialogs.AddressChecker<T> checker,
            BlockingQueue<Object> answer, List<ServerDirectory.Entry> community, List<ServerListStore.Item> saved,
            Memory memory) {
        this.activity = activity;
        this.memory = memory;
        this.checker = checker;
        this.answer = answer;
        this.community = community;
        for (ServerDirectory.Entry entry : community) {
            providedAddresses.add(entry.address);
            providedNotes.put(ServerIdentity.origin(entry.address), entry.description);
        }
        provided = new ProvidedOrigins(providedAddresses);
        for (ServerDirectory.Entry entry : community)
            records.put(ServerIdentity.origin(entry.address), new Record(entry));
        for (ServerListStore.Item item : saved) {
            if (memory.onlineOnly && reflipped.shell.service.LocalServer.isLocal(item.metadata.address)) continue;
            Record bookmarked = record(item.metadata);
            bookmarked.nickname = item.nickname;
        }
        selected = new BrowserStart(initial).origin;
        for (Map.Entry<String, Object[]> kept : memory.checks.entrySet()) {
            Record value = records.get(kept.getKey());
            if (value == null) continue;
            Object[] check = kept.getValue();
            value.entry = (ServerDirectory.Entry) check[0];
            value.state = (String) check[1];
            value.message = (String) check[2];
            value.verified = (T) check[3];
        }
    }

    private Record record(ServerDirectory.Entry entry) {
        String origin = ServerIdentity.origin(entry.address);
        Record value = records.get(origin);
        if (value == null) {
            value = new Record(entry);
            records.put(origin, value);
        } else if (!value.local) {
            // A provided row keeps its catalogue details until its server reports real ones.
            if (!value.provided || !entry.placeholder()) value.entry = entry;
        }
        return value;
    }

    private static ServerDirectory.Entry placeholder(String address) {
        return new ServerDirectory.Entry("Saved server", address, "", "", "", "online", Progression.of("", 1));
    }

    public static <T> T open(Activity activity, String initial, ShellDialogs.AddressChecker<T> checker,
            Memory memory) throws Exception {
        List<ServerDirectory.Entry> community = ServerDirectory.community(activity);
        String known = BrowserStart.address(initial);
        if (!known.isEmpty()) ServerListStore.seedLegacyCurrent(activity, placeholder(known));
        List<ServerListStore.Item> saved = ServerListStore.load(activity);
        BlockingQueue<Object> answer = new ArrayBlockingQueue<>(1);
        activity.runOnUiThread(() -> {
            try {
                new ServerBrowser<T>(activity, known, checker, answer, community, saved, memory).show();
            } catch (Throwable failure) {
                answer.offer(failure);
            }
        });
        Object result = answer.take();
        if (result instanceof Throwable)
            throw new IllegalStateException("Cannot show server browser", (Throwable) result);
        return result == Boolean.FALSE ? null : (T) result;
    }

    private Button compact(String label) {
        Button value = ShellDialogs.button(activity, label, false);
        value.setTextSize(15);
        value.setElevation(0);
        return value;
    }

    private LinearLayout horizontal() {
        LinearLayout row = new LinearLayout(activity);
        row.setGravity(Gravity.CENTER_VERTICAL);
        return row;
    }

    private void weighted(LinearLayout row, View view) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        params.setMargins(ShellDialogs.dp(activity, 3), ShellDialogs.dp(activity, 6), ShellDialogs.dp(activity, 3),
                ShellDialogs.dp(activity, 6));
        row.addView(view, params);
    }

    private void show() {
        dialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar);
        LinearLayout page = ShellDialogs.panel(activity, "");
        LinearLayout heading = horizontal();
        TextView title = ShellDialogs.text(activity, "My servers", 24);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setGravity(Gravity.LEFT);
        title.setPadding(0, 0, ShellDialogs.dp(activity, 8), 0);
        heading.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button refresh = compact("Refresh");
        refresh.setContentDescription("Refresh server connections");
        refresh.setMinWidth(0);
        refresh.setMinimumWidth(0);
        refresh.setPadding(ShellDialogs.dp(activity, 8), 0, ShellDialogs.dp(activity, 8), 0);
        LinearLayout.LayoutParams refreshParams =
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        refreshParams.topMargin = ShellDialogs.dp(activity, 6);
        refreshParams.bottomMargin = ShellDialogs.dp(activity, 6);
        heading.addView(refresh, refreshParams);
        page.addView(heading);
        page.addView(ShellDialogs.text(activity, "Choose where you want to play.", 15));
        refresh.setOnClickListener(v -> {
            joinGuard.navigate();
            java.util.Set<String> urls = new java.util.HashSet<>();
            for (String origin : new ArrayList<>(rows.keySet())) {
                Record value = records.get(origin);
                if (value != null) {
                    if (urls.add(value.entry.thumbnail)) artwork.refresh(activity, value.entry.thumbnail);
                    probe(value, false, true);
                }
            }
        });
        scroll = new ScrollView(activity);
        scroll.setDescendantFocusability(ViewGroup.FOCUS_BEFORE_DESCENDANTS);
        scroll.setFocusableInTouchMode(true);
        scroll.setPadding(ShellDialogs.dp(activity, 4), ShellDialogs.dp(activity, 8), ShellDialogs.dp(activity, 4),
                ShellDialogs.dp(activity, 8));
        scroll.setClipToPadding(true);
        scroll.setBackgroundColor(Color.rgb(255, 249, 251));
        list = new LinearLayout(activity);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, 0, 0, ShellDialogs.dp(activity, 8));
        scroll.addView(list);
        page.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        notice = ShellDialogs.text(activity, "", 14);
        notice.setMinLines(1);
        // The same padding framed or not, so a message from an action doesn't resize the list.
        notice.setPadding(ShellDialogs.dp(activity, 10), ShellDialogs.dp(activity, 6), ShellDialogs.dp(activity, 10),
                ShellDialogs.dp(activity, 6));
        notice.setCompoundDrawablePadding(ShellDialogs.dp(activity, 8));
        notice.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        LinearLayout.LayoutParams noticeParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        noticeParams.topMargin = ShellDialogs.dp(activity, 6);
        page.addView(notice, noticeParams);
        LinearLayout tools = horizontal();
        Button add = compact("Add");
        add.setContentDescription("Add server");
        edit = compact("Edit");
        remove = compact("Remove");
        weighted(tools, add);
        weighted(tools, edit);
        weighted(tools, remove);
        page.addView(tools);
        add.setOnClickListener(v -> editor(null));
        edit.setOnClickListener(v -> {
            Record current = records.get(selected);
            if (current != null && !current.provided) editor(current);
        });
        remove.setOnClickListener(v -> confirmRemove());
        LinearLayout actions = horizontal();
        Button back = compact("Back");
        join = ShellDialogs.button(activity, "Join server", true);
        weighted(actions, back);
        weighted(actions, join);
        page.addView(actions);
        back.setOnClickListener(v -> {
            answer.offer(Boolean.FALSE);
            dialog.dismiss();
        });
        join.setOnClickListener(v -> join());
        page.setFocusableInTouchMode(true);
        page.requestFocus();
        dialog.setContentView(page);
        dialog.setCancelable(false);
        dialog.setOnDismissListener(d -> {
            close();
            answer.offer(Boolean.FALSE);
        });
        dialog.setOnKeyListener((d, key, event) -> {
            if (key != android.view.KeyEvent.KEYCODE_BACK) return false;
            if (event.getAction() == android.view.KeyEvent.ACTION_UP) {
                answer.offer(Boolean.FALSE);
                dialog.dismiss();
            }
            return true;
        });
        dialog.show();
        ShellDialogs.size(activity, dialog, true);
        render();
        Record current = records.get(selected);
        if (current != null && "neutral".equals(current.state)) probe(current);
        // After the first layout: back to where the player was, the selected card in view, then check what shows.
        list.getViewTreeObserver().addOnGlobalLayoutListener(new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
            public void onGlobalLayout() {
                list.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                if (closed) return;
                if (memory.scrollY >= 0) scroll.scrollTo(0, memory.scrollY);
                showSelected(true);
                checkVisible();
            }
        });
        scrolled = this::checkVisible;
        scroll.getViewTreeObserver().addOnScrollChangedListener(scrolled);
    }

    /** Checks each server whose card is on screen and was never checked, once per opening (two at a time). */
    private void checkVisible() {
        if (closed) return;
        int top = scroll.getScrollY(), bottom = top + scroll.getHeight();
        for (Map.Entry<String, Row> entry : rows.entrySet()) {
            View group = entry.getValue().group;
            int cardTop = list.getTop() + group.getTop(), cardBottom = list.getTop() + group.getBottom();
            if (cardBottom <= top || cardTop >= bottom || !autoChecked.add(entry.getKey())) continue;
            Record value = records.get(entry.getKey());
            if (value != null && "neutral".equals(value.state)) probe(value, false, true);
        }
    }

    /** Scrolls the selected card into view, so Join never acts on a server the player can't see. */
    private void showSelected(boolean immediate) {
        reveal(selected, immediate);
    }

    /**
     * Scrolls as little as needed to show the whole card, its margin above and a little space below. The list's own
     * padding is clipped, and ScrollView's requestChildRectangleOnScreen ignores it, which cut the card's bottom edge.
     */
    private void reveal(String origin, boolean immediate) {
        Row row = rows.get(origin);
        if (row == null || row.group.getHeight() == 0) return;
        int top = list.getTop() + row.group.getTop(),
                bottom = list.getTop() + row.group.getBottom() + ShellDialogs.dp(activity, 6);
        int shownTop = scroll.getScrollY() + scroll.getPaddingTop(),
                shownBottom = scroll.getScrollY() + scroll.getHeight() - scroll.getPaddingBottom();
        int delta = bottom > shownBottom ? bottom - shownBottom : 0;
        // A card taller than the list shows its top.
        if (top < shownTop + delta) delta = top - shownTop;
        if (delta == 0) return;
        if (immediate)
            scroll.scrollBy(0, delta);
        else
            scroll.smoothScrollBy(0, delta);
    }

    private void render() {
        List<ServerDirectory.Entry> visible = new ArrayList<>();
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (ServerDirectory.Entry entry : community) {
            String origin = ServerIdentity.origin(entry.address);
            if (seen.add(origin)) visible.add(records.get(origin).entry);
        }
        for (ServerListStore.Item item : ServerListStore.load(activity)) {
            Record value = records.get(ServerIdentity.origin(item.address));
            if (value == null) value = record(item.metadata);
            value.nickname = item.nickname;
            if (seen.add(ServerIdentity.origin(item.address))) visible.add(value.entry);
        }
        java.util.Iterator<Map.Entry<String, Row>> iterator = rows.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, Row> old = iterator.next();
            if (!seen.contains(old.getKey())) {
                old.getValue().card.releaseArtwork();
                list.removeView(old.getValue().group);
                iterator.remove();
            }
        }
        if (emptyState == null)
            emptyState = ShellDialogs.text(
                    activity, "Your servers will appear here. Add an address shared by a server owner.", 16);
        if (visible.isEmpty()) {
            if (emptyState.getParent() == null) list.addView(emptyState);
        } else
            list.removeView(emptyState);
        int index = 0;
        for (ServerDirectory.Entry entry : visible) {
            String origin = ServerIdentity.origin(entry.address);
            Record value = records.get(origin);
            Row row = rows.get(origin);
            if (row == null) {
                LinearLayout group = new LinearLayout(activity);
                group.setOrientation(LinearLayout.VERTICAL);
                ServerCard.Holder card = ServerCard.create(activity, value.entry, origin.equals(selected), artwork);
                card.setFocusable(true);
                card.setOnClickListener(v -> select(value));
                card.setAccessibilityDelegate(new View.AccessibilityDelegate() {
                    public void onInitializeAccessibilityNodeInfo(
                            View host, android.view.accessibility.AccessibilityNodeInfo info) {
                        super.onInitializeAccessibilityNodeInfo(host, info);
                        info.setClassName("android.widget.Button");
                    }
                });
                card.setEnabled(!value.local);
                card.reserveStatus(NOT_CHECKED, CHECKING, READY, NO_ANSWER, NOT_FOUND, NOT_REFLIPPED, NOT_READY, MOVED,
                        AppVersion.LONGEST_REFUSAL);
                group.addView(card);
                row = new Row(card, group);
                rows.put(origin, row);
            }
            bindRow(row, value);
            if (list.getChildAt(index) != row.group) {
                if (row.group.getParent() != null) list.removeView(row.group);
                list.addView(row.group, index);
            }
            index++;
        }
        controls();
    }

    private void bindRow(Row row, Record value) {
        if (value.verified != null) row.card.reported();
        if (row.bound != value.entry) {
            row.card.bind(value.entry);
            row.bound = value.entry;
        }
        String nickname = value.provided ? "" : value.nickname;
        if (!row.nickname.equals(nickname)) {
            row.card.nickname(nickname);
            row.nickname = nickname;
        }
        row.card.providedNote(value.providedNote);
        row.card.provided(value.provided);
        row.card.select(ServerIdentity.same(selected, value.entry.address));
        if (!row.state.equals(value.state) || !row.message.equals(value.message)) {
            row.card.connection(value.state, value.message);
            row.state = value.state;
            row.message = value.message;
        }
    }

    /** Only call after explicit Save/duplicate focus, never from a probe callback. */
    private void revealSelection() {
        final String origin = selected;
        list.getViewTreeObserver().addOnGlobalLayoutListener(
                new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
                    public void onGlobalLayout() {
                        list.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                        if (closed || !origin.equals(selected)) return;
                        reveal(origin, false);
                    }
                });
    }

    private void select(Record value) {
        if (value.local) return;
        joinGuard.navigate();
        selected = ServerIdentity.origin(value.entry.address);
        noticeFromAction = false;
        for (Map.Entry<String, Row> row : rows.entrySet()) row.getValue().card.select(row.getKey().equals(selected));
        probe(value);
        controls();
    }

    /** A message from the last action, such as "already in My servers": framed with an info mark, like a badge. */
    private void say(String message) {
        noticeFromAction = true;
        noticeLook(true);
        notice.setText(message);
    }

    private void noticeLook(boolean framed) {
        if (framed) {
            notice.setBackground(ShellDialogs.frame(Color.rgb(255, 240, 243), Color.rgb(255, 111, 139), activity));
            android.graphics.drawable.Drawable mark = ConnectionBadge.mark("info", Color.rgb(165, 19, 53));
            int size = ShellDialogs.dp(activity, 20);
            mark.setBounds(0, 0, size, size);
            notice.setCompoundDrawablesRelative(mark, null, null, null);
            notice.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        } else {
            notice.setBackground(null);
            notice.setCompoundDrawablesRelative(null, null, null, null);
            notice.setGravity(Gravity.CENTER);
        }
    }

    private void controls() {
        Record current = records.get(selected);
        boolean valid = current != null && current.verified != null && "ready".equals(current.state)
                && rows.containsKey(selected);
        ShellDialogs.enable(activity, join, valid, true);
        boolean editable = current != null && !current.provided && rows.containsKey(selected);
        ShellDialogs.enable(activity, edit, editable, false);
        ShellDialogs.enable(activity, remove, editable, false);
        if (!noticeFromAction) {
            noticeLook(false);
            notice.setText(current == null || !rows.containsKey(selected) ? "Select a server to join it."
                            : current.provided ? "Built-in servers can't be edited or removed."
                            : "error".equals(current.state) && AppVersion.isRefusal(current.message)
                                    ? "Update the Reflipped app to join this server."
                            : "error".equals(current.state) ? "Join needs a server that answers."
                                                            : "");
        }
    }

    private void update(Record value) {
        Row row = rows.get(ServerIdentity.origin(value.entry.address));
        if (row != null) bindRow(row, value);
        controls();
    }

    private void probe(Record value) {
        probe(value, false);
    }

    private void probe(Record value, boolean requestedJoin) {
        probe(value, requestedJoin, false);
    }

    private void probe(Record value, boolean requestedJoin, boolean background) {
        if (value.local) return;
        value.verified = null;
        value.state = "checking";
        value.message = CHECKING;
        int generation = value.generation.start();
        update(value);
        if (value.pending != null) value.pending.cancel(false);
        final String address = value.entry.address;
        JoinGuard.Ticket ticket = requestedJoin ? joinGuard.begin(address, generation) : null;
        value.pending = worker.submit(requestedJoin ? ServerProbeQueues.Priority.JOIN
                        : background                ? ServerProbeQueues.Priority.BACKGROUND
                                                    : ServerProbeQueues.Priority.INTERACTIVE,
                () -> {
                    try {
                        T result = checker.check(address);
                        activity.runOnUiThread(() -> {
                            if (closed || !value.generation.accept(generation)) return;
                            value.entry = checker.entry(result);
                            value.verified = result;
                            value.state = "ready";
                            value.message = READY;
                            update(value);
                            if (requestedJoin && joinGuard.accepts(ticket, selected, generation)
                                    && rows.containsKey(selected))
                                finishJoin(value);
                        });
                    } catch (Exception failure) {
                        activity.runOnUiThread(() -> {
                            if (closed || !value.generation.accept(generation)) return;
                            value.state = "error";
                            value.message = cardMessage(failure);
                            update(value);
                        });
                    }
                });
    }

    private void join() {
        Record value = records.get(selected);
        if (value == null || value.verified == null || !"ready".equals(value.state) || !rows.containsKey(selected)
                || value.local)
            return;
        showSelected(false);
        probe(value, true);
    }

    private void finishJoin(Record value) {
        try {
            if (!value.provided) {
                boolean exists = false;
                for (ServerListStore.Item item : ServerListStore.load(activity))
                    if (ServerIdentity.same(item.address, value.entry.address)) exists = true;
                if (exists)
                    ServerListStore.updateMetadata(activity, value.entry);
                else
                    ServerListStore.saveCustom(activity, null, "", value.entry, providedAddresses);
            }
        } catch (IllegalArgumentException optionalBookmark) {
            android.util.Log.i(StubContext.TAG, "Joining without updating optional server bookmark");
        }
        answer.offer(value.verified);
        dialog.dismiss();
    }

    private void retire(Record value) {
        value.generation.close();
        if (value.pending != null) value.pending.cancel(false);
        String origin = ServerIdentity.origin(value.entry.address);
        boolean listed = false;
        for (ServerDirectory.Entry entry : community)
            if (ServerIdentity.same(entry.address, origin)) listed = true;
        if (listed)
            records.put(origin, new Record(value.entry));
        else
            records.remove(origin);
    }

    private void close() {
        joinGuard.navigate();
        if (!closed) {
            memory.scrollY = scroll.getScrollY();
            memory.checks.clear();
            for (Map.Entry<String, Record> entry : records.entrySet()) {
                Record value = entry.getValue();
                // A check still running when the list closes counts as not checked.
                if ("ready".equals(value.state) || "error".equals(value.state))
                    memory.checks.put(entry.getKey(), new Object[] {value.entry, value.state, value.message, value.verified});
            }
            if (scrolled != null) scroll.getViewTreeObserver().removeOnScrollChangedListener(scrolled);
        }
        closed = true;
        for (Record value : records.values()) value.generation.close();
        worker.close();
        artwork.close();
    }

    private void confirmRemove() {
        joinGuard.navigate();
        Record current = records.get(selected);
        if (current == null || current.provided || !rows.containsKey(selected)) return;
        Dialog confirm = new Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar);
        LinearLayout panel = ShellDialogs.panel(activity, "Remove "
                + (!current.nickname.isEmpty() ? current.nickname
                        : current.entry.placeholder() ? current.entry.address : current.entry.name)
                + "?");
        panel.addView(ShellDialogs.text(activity,
                "This only removes the entry from your list. Your save and sign-in information stay safe.", 16));
        LinearLayout actions = horizontal();
        Button cancel = compact("Keep server"), removeButton = ShellDialogs.button(activity, "Remove entry", true);
        weighted(actions, cancel);
        weighted(actions, removeButton);
        panel.addView(actions);
        cancel.setOnClickListener(v -> confirm.dismiss());
        removeButton.setOnClickListener(v -> {
            ServerListStore.remove(activity, current.entry.address);
            retire(current);
            selected = "";
            noticeFromAction = false;
            confirm.dismiss();
            render();
        });
        confirm.setContentView(panel);
        confirm.show();
        ShellDialogs.size(activity, confirm, false);
    }

    private void editor(Record original) {
        if (original != null && original.provided) return;
        joinGuard.navigate();
        String previous = null;
        if (original != null)
            for (ServerListStore.Item item : ServerListStore.load(activity))
                if (ServerIdentity.same(item.address, original.entry.address)) previous = item.address;
        final String previousAddress = previous;
        Dialog form = new Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar);
        LinearLayout page = ShellDialogs.panel(activity, original == null ? "Add server" : "Edit server");
        ScrollView scroll = new ScrollView(activity);
        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(body);
        page.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        TextView addressLabel = ShellDialogs.text(activity, "Server address", 16);
        addressLabel.setGravity(Gravity.LEFT);
        body.addView(addressLabel);
        EditText address = field(original == null ? "" : original.entry.address);
        // QA: with the URI variation, keyboards still offered suggestions and underlined the word being typed. The
        // visible-password variation is the one keyboards reliably honour: no suggestions, no learning, no composing
        // underline. It switches the font to monospace, so the field's own font is set again afterwards.
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        address.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        // ...and autofill services must not take it for a password and offer to save it.
        if (android.os.Build.VERSION.SDK_INT >= 26) address.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        // No full-screen keyboard editor either: it has its own underlined field and would hide the styled one.
        address.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI
                | android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        addressLabel.setLabelFor(address.getId());
        address.setHint("Paste the server address");
        body.addView(address);
        // The check result sits right under the field, so it stays in view above the keyboard.
        ConnectionBadge status = new ConnectionBadge(activity);
        status.reserve(FORM_EMPTY, FORM_INVALID, CHECKING, FORM_FOUND_SAMPLE, FORM_NO_ANSWER, FORM_NOT_FOUND,
                FORM_NOT_REFLIPPED, FORM_NOT_READY, FORM_MOVED, AppVersion.LONGEST_REFUSAL + FORM_SAVE_ANYWAY);
        body.addView(status);
        body.addView(hint("Paste the address shared by the server owner. You can save it even when the server is offline."));
        TextView nameLabel = ShellDialogs.text(activity, "Nickname (optional)", 16);
        nameLabel.setGravity(Gravity.LEFT);
        body.addView(nameLabel);
        EditText nickname = field(original == null ? "" : original.nickname);
        nickname.setFilters(new InputFilter[] {new InputFilter.LengthFilter(64)});
        nameLabel.setLabelFor(nickname.getId());
        body.addView(nickname);
        body.addView(hint("A name for your own list. The server's name still shows on its card."));
        TextView error = ShellDialogs.text(activity, "", 14);
        error.setTextColor(Color.rgb(157, 38, 59));
        body.addView(error);
        LinearLayout actions = horizontal();
        Button cancel = compact("Cancel"), save = ShellDialogs.button(activity, "Save server", true);
        weighted(actions, cancel);
        weighted(actions, save);
        page.addView(actions);
        ScheduledThreadPoolExecutor checks = new ScheduledThreadPoolExecutor(1);
        checks.setRemoveOnCancelPolicy(true);
        AddressCheckState generation = new AddressCheckState();
        final java.util.concurrent.ScheduledFuture<?>[] pending = new java.util.concurrent.ScheduledFuture<?>[1];
        final Object[] verified = new Object[1];
        final ServerDirectory.Entry[] metadata = {original == null ? null : original.entry};
        Runnable reveal = () -> scroll.post(() -> {
            android.graphics.Rect area = new android.graphics.Rect(0, 0, status.getWidth(), status.getHeight());
            body.offsetDescendantRectToMyCoords(status, area);
            scroll.requestChildRectangleOnScreen(body, area, false);
        });
        Runnable check = () -> {
            generation.edit();
            verified[0] = null;
            List<String> tries = AddressCandidates.of(address.getText().toString());
            ShellDialogs.enable(activity, save, !tries.isEmpty(), true);
            error.setText("");
            if (pending[0] != null) pending[0].cancel(false);
            if (tries.isEmpty()) {
                status.show(address.getText().length() == 0 ? "neutral" : "error",
                        address.getText().length() == 0 ? FORM_EMPTY : FORM_INVALID);
                return;
            }
            metadata[0] = null;
            int attempt = generation.start();
            status.show("checking", CHECKING);
            pending[0] = checks.schedule(() -> {
                Exception worst = null;
                for (String candidate : tries) {
                    try {
                        T result = checker.check(candidate);
                        activity.runOnUiThread(() -> {
                            if (!generation.accept(attempt)) return;
                            verified[0] = result;
                            metadata[0] = checker.entry(result);
                            status.show("ready", FORM_FOUND + metadata[0].name);
                            reveal.run();
                        });
                        return;
                    } catch (Exception failure) {
                        if (worst == null || rank(failure) > rank(worst)) worst = failure;
                    }
                }
                final Exception failure = worst;
                activity.runOnUiThread(() -> {
                    if (!generation.accept(attempt)) return;
                    status.show("error", formMessage(failure));
                    reveal.run();
                });
            }, 600, TimeUnit.MILLISECONDS);
        };
        nickname.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                error.setText("");
            }
            public void afterTextChanged(Editable s) {}
        });
        address.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                check.run();
            }
            public void afterTextChanged(Editable s) {}
        });
        cancel.setOnClickListener(v -> form.dismiss());
        save.setOnClickListener(v -> {
            List<String> tries = AddressCandidates.of(address.getText().toString());
            if (tries.isEmpty()) return;
            // A checked address keeps the scheme that answered; an unchecked one the first to try.
            ServerDirectory.Entry entry = verified[0] != null && metadata[0] != null ? metadata[0]
                    : placeholder(tries.get(0));
            String normalized = entry.address;
            if (provided.contains(normalized)) {
                if (original != null) {
                    error.setText("A built-in server already uses this address.");
                    return;
                }
                selected = ServerIdentity.origin(normalized);
                form.dismiss();
                render();
                revealSelection();
                say("This server is already built in to My servers.");
                Record existing = records.get(selected);
                if (existing != null) probe(existing);
                return;
            }
            try {
                ServerListStore.Item item = verified[0] == null
                        ? ServerListStore.saveCustom(activity, previousAddress, nickname.getText().toString(),
                                  normalized, providedAddresses)
                        : ServerListStore.saveCustom(
                                  activity, previousAddress, nickname.getText().toString(), entry, providedAddresses);
                if (original != null && !ServerIdentity.same(original.entry.address, item.address)) retire(original);
                Record target = record(item.metadata);
                target.generation.edit();
                if (target.pending != null) target.pending.cancel(false);
                target.nickname = item.nickname;
                target.verified = (T) verified[0];
                target.state = target.verified == null ? "neutral" : "ready";
                target.message = target.verified == null ? NOT_CHECKED : READY;
                selected = ServerIdentity.origin(item.address);
                noticeFromAction = false;
                form.dismiss();
                render();
                revealSelection();
                if (target.verified == null) probe(target);
            } catch (ServerListStore.Duplicate duplicate) {
                if (original != null) {
                    error.setText("Another saved server already uses this address.");
                    return;
                }
                selected = ServerIdentity.origin(duplicate.address);
                form.dismiss();
                render();
                revealSelection();
                say("That server is already in My servers.");
                Record existing = records.get(selected);
                if (existing != null) probe(existing);
            } catch (ServerListStore.Full full) {
                error.setText("My servers is full. Remove an entry before adding another.");
            } catch (IllegalArgumentException invalid) {
                error.setText(
                        "Couldn't save this entry. Use a nickname up to 64 characters and a valid server address.");
            }
        });
        form.setOnDismissListener(d -> {
            generation.close();
            checks.shutdownNow();
        });
        form.setOnKeyListener((d, key, event) -> {
            if (key != android.view.KeyEvent.KEYCODE_BACK) return false;
            if (event.getAction() == android.view.KeyEvent.ACTION_UP) {
                android.graphics.Rect visible = new android.graphics.Rect();
                form.getWindow().getDecorView().getWindowVisibleDisplayFrame(visible);
                if (activity.getResources().getDisplayMetrics().heightPixels - visible.bottom
                        > ShellDialogs.dp(activity, 120)) {
                    android.view.inputmethod.InputMethodManager ime =
                            (android.view.inputmethod.InputMethodManager) activity.getSystemService(
                                    android.content.Context.INPUT_METHOD_SERVICE);
                    if (ime != null) ime.hideSoftInputFromWindow(address.getWindowToken(), 0);
                } else
                    form.dismiss();
            }
            return true;
        });
        page.setFocusableInTouchMode(true);
        page.requestFocus();
        form.setContentView(page);
        form.setCancelable(false);
        form.show();
        ShellDialogs.size(activity, form, true);
        form.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                | android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        check.run();
    }

    private TextView hint(String value) {
        TextView text = ShellDialogs.text(activity, value, 14);
        text.setGravity(Gravity.LEFT);
        return text;
    }

    private EditText field(String value) {
        EditText input = new EditText(activity);
        input.setId(View.generateViewId());
        input.setSingleLine(true);
        input.setTextColor(ShellDialogs.INK);
        input.setTextSize(16);
        input.setBackground(ShellDialogs.frame(Color.WHITE, Color.rgb(201, 208, 218), activity));
        input.setPadding(ShellDialogs.dp(activity, 12), ShellDialogs.dp(activity, 10), ShellDialogs.dp(activity, 12),
                ShellDialogs.dp(activity, 10));
        input.setMinimumHeight(ShellDialogs.dp(activity, 48));
        input.setText(value);
        return input;
    }
}
