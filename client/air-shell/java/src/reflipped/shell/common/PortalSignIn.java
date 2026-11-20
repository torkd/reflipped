package reflipped.shell.common;

import android.app.Activity;
import android.app.Dialog;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.util.Log;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;
import android.widget.LinearLayout;
import android.widget.Button;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

/**
 * Signs the shell in to a Reflipped portal account (ACC-3, docs/accounts.md "Shell login"). Everything here blocks,
 * so call it from a background thread, like {@link ServerSetup}.
 *
 * On a server that has the portal (`/shell/config` `portal: 1`) the first login opens `<server>/portal/shell` in a
 * WebView. After the player logs in and presses Play, the portal sends the WebView to
 * `/portal/shell/done?code=...`; this class stops that page, trades the code for a device token at
 * `POST /portal/shell/token` and sends the token as `whiteKey` from then on. "Play without an account"
 * (`/portal/shell/done?guest=1`) keeps the install's own `deviceKey`, as before accounts, and isn't asked again.
 *
 * Prefs: `portalToken` (the device token), `signIn` = "guest" once the player chose to play without an account.
 *
 * The patched account menu signs out through {@link #logOut}; account management itself opens the portal.
 * Legacy CONNECT handling remains available for old callers, but no old IdP button is exposed by this build.
 */
public final class PortalSignIn {
    private static final String DONE_PATH = "/portal/shell/done";
    /** A sign-in code lives two minutes on the server; redeem it only well within that. */
    private static final long PENDING_MILLIS = 100_000;

    /** What the player chose for a server before joining it ({@link #chooseBeforeJoin}). */
    public enum Choice { ANOTHER_SERVER, GUEST, ACCOUNT, KEEP }

    /**
     * Thrown by {@link #deviceSecret} when the player chose "Choose another server" at session start: the server list
     * is due (`chooseServer`), and the caller restarts the game to get there.
     */
    public static final class AnotherServer extends Exception {
        AnotherServer() { super("Choose another server"); }
    }

    private static String pendingCode, pendingServer;
    private static long pendingAt;

    private PortalSignIn() {
    }

    /**
     * The device secret to log in with: the device token when signed in, else the install's `deviceKey`. Asks the
     * player to sign in first when the server has a portal and they haven't chosen to play as a guest; with
     * `signedOut`, also after that choice, explaining that the account now plays on another device. That choice also
     * offers the server list (and Android Back means it), as before joining: then this throws {@link AnotherServer}.
     */
    public static String deviceSecret(Activity activity, String appId, boolean signedOut) throws Exception {
        SharedPreferences prefs = ShellConfig.prefs(activity);
        String token = prefs.getString("portalToken", null);
        if (token != null && !signedOut) return token;
        if (signedOut) {
            prefs.edit().remove("portalToken").remove("signIn").remove("playerId").apply();
            ShellSession.clear();
            if (!choose(activity, "Signed out",
                    "Your account is now played on another device. Log in to play it here again, or play without an account.",
                    "Log in", "Play without an account")) {
                prefs.edit().putString("signIn", "guest").apply();
                return ShellConfig.deviceKey(activity);
            }
        } else if (!ShellConfig.serverHasPortal(activity) || "guest".equals(prefs.getString("signIn", null))) {
            return ShellConfig.deviceKey(activity);
        }
        String code = takePending(ShellConfig.server(activity));
        if (code != null) {
            try {
                return redeem(activity, ShellConfig.server(activity), code, appId);
            } catch (Exception e) {
                Log.w(StubContext.TAG, "portal sign-in exchange failed (" + e.getClass().getSimpleName() + ")");
                choose(activity, "Sign-in failed", "The server didn't accept the sign-in. Sign in again.", "OK", null);
            }
        }

        PortalFlow.Result result = PortalFlow.choose(new PortalFlow.Choices() {
            public boolean account() throws Exception {
                int pick = ShellDialogs.chooseRowWithBack(activity, "Play on " + ShellConfig.serverName(activity),
                        "Sign in to your Reflipped account, or continue with this device's guest save.", 2,
                        "Reflipped account", "Play as guest", "Choose another server");
                if (pick == 2) {
                    prefs.edit().putBoolean("chooseServer", true).apply();
                    throw new AnotherServer();
                }
                return pick == 0;
            }
            public PortalFlow.Result signIn() throws Exception { return PortalSignIn.signIn(activity, appId, false); }
        });
        if (result.kind == PortalFlow.Kind.SUCCESS) return result.value;
        prefs.edit().putString("signIn", "guest").apply();
        return ShellConfig.deviceKey(activity);
    }

    /**
     * Asks how to play on `server` while the player can still go back to the server list: Reflipped account, guest,
     * or another server (also Android Back). An account sign-in runs here; its one-time code is redeemed at session
     * start ({@link #deviceSecret}), which knows the game's appId. KEEP: nothing to ask (no accounts on the server, or
     * this install already plays it with an account or as a guest).
     */
    public static Choice chooseBeforeJoin(Activity activity, String server, String name, boolean portal) throws Exception {
        synchronized (PortalSignIn.class) { pendingCode = null; }
        if (!portal) return Choice.KEEP;
        SharedPreferences prefs = ShellConfig.prefs(activity);
        if (ServerIdentity.same(server, ShellConfig.server(activity))
                && (prefs.contains("portalToken") || "guest".equals(prefs.getString("signIn", null)))) return Choice.KEEP;
        while (true) {
            int pick = ShellDialogs.chooseRowWithBack(activity, "Play on " + name,
                    "Sign in to your Reflipped account, or play as a guest on this device.", 2,
                    "Reflipped account", "Play as guest", "Choose another server");
            if (pick == 2) return Choice.ANOTHER_SERVER;
            if (pick == 1) return Choice.GUEST;
            PortalFlow.Result result = showPortal(activity, server, false);
            if (result.kind == PortalFlow.Kind.GUEST) return Choice.GUEST;
            if (result.kind == PortalFlow.Kind.SUCCESS) {
                synchronized (PortalSignIn.class) {
                    pendingCode = result.value;
                    pendingServer = server;
                    pendingAt = android.os.SystemClock.elapsedRealtime();
                }
                return Choice.ACCOUNT;
            }
            // Back in the sign-in page: ask again.
        }
    }

    private static synchronized String takePending(String server) {
        String code = pendingCode;
        pendingCode = null;
        boolean fresh = code != null && ServerIdentity.same(server, pendingServer)
                && android.os.SystemClock.elapsedRealtime() - pendingAt < PENDING_MILLIS;
        return fresh ? code : null;
    }

    /** Revoke the current device sessions before the patched game performs its non-destructive soft restart. */
    public static void logOut(Activity activity) throws Exception {
        SharedPreferences prefs = ShellConfig.prefs(activity);
        String token = prefs.getString("portalToken", null);
        JSONObject body = token != null ? new JSONObject().put("deviceToken", token)
                : new JSONObject().put("whiteKey", ShellConfig.deviceKey(activity));
        // Do not claim success offline: the old viewer session must be revoked before another account can adopt it.
        post(ShellConfig.server(activity) + "/portal/shell/logout", body);
        prefs.edit().remove("portalToken").remove("signIn").remove("playerId").putBoolean("chooseServer", true).apply();
        ShellSession.clear();
        clearWebLogins(activity);
    }

    /**
     * Forgets the portal and admin-site logins the app's web views keep as cookies. Without this, the sign-in page
     * after Sign out still offers "Play as" the previous account without a password, and the admin site stays open.
     */
    private static void clearWebLogins(Activity activity) {
        activity.runOnUiThread(() -> {
            try {
                CookieManager cookies = CookieManager.getInstance();
                cookies.removeAllCookies(null);
                cookies.flush();
            } catch (RuntimeException unavailable) {
                Log.w(StubContext.TAG, "couldn't clear web logins (" + unavailable.getClass().getSimpleName() + ")");
            }
        });
    }

    /**
     * Logs in now, from the game's account menu (ACC-12), for a player who played without an account or wants
     * another one. True when signed in: the token is stored, so the next launch plays that save, and the caller closes
     * the app ({@link AppRestart}). False when the player backed out, which changes nothing.
     */
    public static boolean signInNow(Activity activity, String appId) throws Exception {
        if (!choose(activity, "Link an account",
                "Sign in to your Reflipped account on this server. An account without a save takes over the progress you made"
                        + " as a guest. The game then closes; open it again to play with the account.",
                "Sign in", "Back")) return false;
        if (signIn(activity, appId, true).kind != PortalFlow.Kind.SUCCESS) return false;
        choose(activity, "Logged in", "Open the game again to play your account's save.", "OK", null);
        return true;
    }

    /**
     * Only a completed sign-in stores a token; Guest and Cancel remain distinct outcomes. `linking`: the player already
     * plays as a guest (Link an account), so the portal leaves out "Play without an account".
     */
    private static PortalFlow.Result signIn(Activity activity, String appId, boolean linking) throws Exception {
        String server = ShellConfig.server(activity);
        while (true) {
            PortalFlow.Result result = showPortal(activity, server, linking);
            if (result.kind != PortalFlow.Kind.SUCCESS) return result;
            try {
                return PortalFlow.success(redeem(activity, server, result.value, appId));
            } catch (Exception e) {
                Log.w(StubContext.TAG, "portal sign-in exchange failed (" + e.getClass().getSimpleName() + ")");
                choose(activity, "Sign-in failed", "The server didn't accept the sign-in. Log in again.", "OK", null);
            }
        }
    }

    /** Trades a sign-in code for the device token and stores it; returns the token. */
    private static String redeem(Activity activity, String server, String code, String appId) throws Exception {
        JSONObject reply = exchange(server, code, ShellConfig.deviceKey(activity), appId);
        String token = reply.getString("deviceToken");
        ShellConfig.prefs(activity).edit().putString("portalToken", token).remove("signIn")
                .putString("playerId", reply.optString("playerId")).apply();
        return token;
    }

    /** POST <server>/portal/shell/token; the reply has `deviceToken` and `playerId`. */
    private static JSONObject exchange(String server, String code, String guestKey, String appId) throws Exception {
        JSONObject body = new JSONObject().put("code", code).put("whiteKey", guestKey).put("appId", appId == null ? "" : appId);
        return new JSONObject(post(server + "/portal/shell/token", body));
    }

    /** POSTs `body` as JSON; returns the reply's text, or throws on any status but 200 and 204. */
    static String post(String url, JSONObject body) throws Exception {
        HttpURLConnection conn = CredentialRequests.open(url);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int status = conn.getResponseCode();
        String text = read(status < 400 ? conn.getInputStream() : conn.getErrorStream());
        if (status != 200 && status != 204) throw new IllegalStateException("HTTP " + status + " from portal request");
        return text;
    }

    // ---------------------------------------------------------------- the portal in a WebView

    /**
     * A completed callback returns its code or explicit Guest action. Back/Close returns CANCELLED.
     * Only pages of `server` load; anything else is blocked. With `linking`, the web view's user agent says so
     * ("ReflippedLinking"), and the portal leaves out its "Play without an account" link (styling only).
     */
    private static PortalFlow.Result showPortal(final Activity activity, final String server, final boolean linking)
            throws Exception {
        final BlockingQueue<Object> answer = new ArrayBlockingQueue<>(1);
        activity.runOnUiThread(() -> {
            try {
                // not a fullscreen theme: Android doesn't resize a fullscreen window for the keyboard, and the WebView
                // then pans and repaints parts of the page at the wrong scale; this also keeps it clear of the notch
                final Dialog dialog = new Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar);
                final WebView web = new WebView(activity);
                WebViewDialog.markApp(web);
                if (linking) {
                    WebSettings settings = web.getSettings();
                    settings.setUserAgentString(settings.getUserAgentString() + " ReflippedLinking");
                }
                // the portal needs no scripts
                web.getSettings().setJavaScriptEnabled(false);
                web.getSettings().setAllowFileAccess(false);
                web.getSettings().setAllowContentAccess(false);
                web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
                web.setBackgroundColor(ShellDialogs.SURFACE);
                web.setWebViewClient(new WebViewClient() {
                    private boolean finished;

                    /** True when `url` ends the sign-in; then hands its answer over once. */
                    private boolean finish(String url) {
                        if (!GameWebUrls.sameOrigin(server, url) || !Uri.parse(server + DONE_PATH).getPath().equals(Uri.parse(url).getPath())) return false;
                        if (!finished) {
                            Uri uri = Uri.parse(url);
                            PortalFlow.Result result = PortalFlow.callback(uri.getQueryParameter("code"), uri.getQueryParameter("guest"));
                            if (result == null) return false;
                            finished = true;
                            answer.offer(result);
                            dialog.dismiss();
                        }
                        return true;
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, String url) {
                        if (finish(url)) return true;
                        // stay on the player's server
                        return !GameWebUrls.sameOrigin(server, url);
                    }

                    @Override
                    public void onPageStarted(WebView view, String url, Bitmap favicon) {
                        // a redirect the WebView followed without asking still ends here
                        if (finish(url) || !GameWebUrls.sameOrigin(server, url)) view.stopLoading();
                    }
                });
                web.loadUrl(server + "/portal/shell");
                LinearLayout root = ShellDialogs.panel(activity, "");
                LinearLayout header = new LinearLayout(activity);
                header.setOrientation(LinearLayout.HORIZONTAL);
                header.setGravity(android.view.Gravity.CENTER_VERTICAL);
                Button back = ShellDialogs.button(activity, "Back", false);
                back.setTextSize(16);
                back.setMinHeight(ShellDialogs.dp(activity, 44));
                back.setPadding(ShellDialogs.dp(activity, 10), 0, ShellDialogs.dp(activity, 10), 0);
                back.setContentDescription("Back to account choices");
                back.setOnClickListener(v -> { answer.offer(PortalFlow.cancelled()); dialog.dismiss(); });
                header.addView(back, new LinearLayout.LayoutParams(ShellDialogs.dp(activity, 88), ShellDialogs.dp(activity, 44)));
                android.widget.TextView title = ShellDialogs.text(activity, "Reflipped account", 18);
                title.setPadding(ShellDialogs.dp(activity, 8), 0, 0, 0);
                header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                root.addView(header);
                LinearLayout.LayoutParams content = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1);
                content.topMargin = ShellDialogs.dp(activity, 8);
                root.addView(web, content);
                dialog.setContentView(root);
                Window window = dialog.getWindow();
                if (window != null) {
                    window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
                    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
                }
                dialog.setCancelable(false);
                dialog.setOnKeyListener((d, keyCode, event) -> {
                    if (keyCode != KeyEvent.KEYCODE_BACK) return false;
                    if (event.getAction() == KeyEvent.ACTION_UP) {
                        if (web.canGoBack()) web.goBack();
                        else { answer.offer(PortalFlow.cancelled()); dialog.dismiss(); }
                    }
                    return true;
                });
                dialog.setOnDismissListener(d -> { answer.offer(PortalFlow.cancelled()); web.destroy(); });
                dialog.show();
                ShellDialogs.size(activity, dialog, true);
            } catch (Throwable t) {
                Log.e(StubContext.TAG, "can't show the portal sign-in (" + t.getClass().getSimpleName() + ")");
                answer.offer(t);
            }
        });
        Object result = answer.take();
        if (result instanceof Throwable) throw new IllegalStateException("Cannot show sign-in window");
        return (PortalFlow.Result) result;
    }

    /** Shows a two-button dialog (one button when `negative` is null); true for the positive one. */
    private static boolean choose(final Activity activity, final String title, final String message,
                                  final String positive, final String negative) throws Exception {
        return negative == null
                ? ShellDialogs.choose(activity, title, message, positive) == 0
                : ShellDialogs.choose(activity, title, message, positive, negative) == 0;
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        try {
            for (int n; (n = in.read(chunk)) > 0; ) {
                buf.write(chunk, 0, n);
                if (buf.size() > 65536) throw new IllegalStateException("reply too large");
            }
        } finally {
            in.close();
        }
        return buf.toString("UTF-8");
    }
}
