package reflipped.shell.kakao;

import android.app.Activity;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

import reflipped.shell.common.AppRestart;
import reflipped.shell.common.GameWebUrls;
import reflipped.shell.common.Args;
import reflipped.shell.common.PortalSignIn;
import reflipped.shell.common.GamePackSetup;
import reflipped.shell.common.ServerSetup;
import reflipped.shell.common.LocalPlaySetup;
import reflipped.shell.common.ScreenAwake;
import reflipped.shell.common.ShellConfig;
import reflipped.shell.common.ShellSession;
import reflipped.shell.common.ShellDialogs;
import reflipped.shell.common.CredentialRequests;
import reflipped.shell.common.StubContext;
import reflipped.shell.common.WebViewDialog;
import reflipped.shell.common.StubExtension;
import reflipped.shell.service.LocalDataPack;
import reflipped.shell.service.LocalServer;

/**
 * Replaces the Kakao Game SDK ANE (`com.sesisoft.KakaoGameSdk`). See docs/air-shell.md.
 *
 * Async calls: the AS3 wrapper waits for a StatusEvent whose code is the call name, then reads
 * GETLASTRESULT (a JSON string; every handler checks `isSuccess == "true"`).
 */
public class KakaoGameSdkStub extends StubExtension {
    static final String ID = "com.sesisoft.KakaoGameSdk";
    /**
     * The login type the game is told. The Kakao SDK reported device logins as "Guest" (`docs/routes/tool_signup.md`),
     * and the game's account menu exposes its Sign out/portal actions for that type (SH-14 patches the old rows).
     * Reflipped's loginDevice calls them "zd3".
     */
    private static final String GAME_IDP_CODE = "Guest";

    /** The connect result code the game shows as a failed link (`kakao_account_connect_failure_msg`). */
    private static final int CONNECT_FAILURE = 3002;

    /** The appId of the last KGSESSION_START; KGSESSION_LOGIN and the account menu's calls don't pass it. */
    private static volatile String lastAppId;

    @Override
    protected String extensionId() {
        return ID;
    }

    @Override
    protected void register(StubContext ctx) {
        // SH-13: the game creates this context about 6 s before it asks for the server list; start the server on the
        // phone now (when that is the chosen server), so its start-up is over by then
        new Thread(() -> {
            for (int i = 0; i < 50; i++) {
                Activity activity = null;
                try {
                    activity = ctx.getActivity();
                } catch (RuntimeException notYet) {
                    // AIR hasn't attached the context yet
                }
                if (activity != null) {
                    ScreenAwake.install(activity); // SH-26: AIR's keep-awake lock outlived the game's screen
                    prestartLocalServer(activity);
                    return;
                }
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }, "reflipped-server-prestart").start();
        ctx.on("GETLASTRESULT", (c, a) -> c.lastResult);

        // --- session (async) ---
        ctx.on("KGSESSION_START", (c, a) -> {
            startSession(c, "KGSESSION_START", Args.str(a, 0));
            return null;
        });
        ctx.on("KGSESSIONFORCUSTOMUI_LOGIN", (c, a) -> {
            startSession(c, "KGSESSIONFORCUSTOMUI_LOGIN", null);
            return null;
        });
        ctx.on("KGSESSION_LOGIN", (c, a) -> {
            startSession(c, "KGSESSION_LOGIN", null);
            return null;
        });
        // serverInfos is a JSON *string* of infodesk /v2/appGroup content.apps: [{appId, dataMap:
        // {countryCodeList, bannedCountryCodeList, displayName, isServiceAvailable, ...}}]. The game
        // picks the appId whose countryCodeList contains the device country (docs/air-shell.md).
        ctx.on("KGSESSION_LOADAPPINFOS", (c, a) -> {
            loadAppInfos(c);
            return null;
        });
        for (String name : new String[]{
                "KGSESSION_UNREGISTER", "KGSESSION_PAUSE", "KGSESSION_RESUME", "KGSESSIONFORCUSTOMUI_UNREGISTER",
                "KGSUPPORT_SHOWNOTICEVIEW", "KGSUPPORT_SHOWNOTICEVIEWFORONEDAY", "KGSUPPORT_SHOWNOTICEONLYVIEW",
                "KGSUPPORT_SHOWINAPPWEBVIEW",
                "KGPROMOTION_SHOWSTARTINGPROMOTIONPOPUPS", "KGPROMOTION_SHOWENDINGPROMOTIONPOPUPS",
                "KGPLAYER_LOADFRIENDPLAYERS", "KGIDPPROFILE_REFRESHLOCALIDPPROFILE", "KGCOUPON_SHOWCOUPONPOPUP",
                "KGLOG_WRITEROUNDLOG", "KGLOG_WRITERESOURCELOG", "KGLOG_WRITENETWORKLOG", "KGLOG_WRITEITEMLOG",
                "KGLOG_WRITEACTIONLOG", "KGPUSH_ENABLEPUSH", "KGLOCALPLAYER_GETCURRENTPLAYER"}) {
            ctx.on(name, (c, a) -> {
                c.complete(name, "{\"isSuccess\":\"true\",\"resultCode\":200}");
                return null;
            });
        }
        // SH-14 removes only the destructive local-store deletion from the original logout handler. Successful
        // revocation now reports back so its normal soft restart returns to setup without deleting downloads.
        // Legacy CONNECT calls remain handled defensively; the patched account menu exposes portal management.
        for (String name : new String[]{"KGSESSION_LOGOUT", "KGSESSIONFORCUSTOMUI_LOGOUT"}) {
            ctx.on(name, (c, a) -> {
                logOut(c, name);
                return null;
            });
        }
        for (String name : new String[]{"KGSESSION_CONNECT", "KGSESSIONFORCUSTOMUI_CONNECT"}) {
            ctx.on(name, (c, a) -> {
                connect(c, name);
                return null;
            });
        }
        // in-app web views: the game passes the URL (from KGAPPOPTION_GETVALUE) to SHOWINAPPWEBVIEW; the notice
        // views have no URL of their own, so they show Reflipped's news page
        ctx.on("KGSUPPORT_SHOWINAPPWEBVIEW", (c, a) -> {
            String url = Args.str(a, 0);
            if ((ShellConfig.server(c.getActivity()) + ShellConfig.LINK_ACCOUNT_PATH).equals(url)) linkAccount(c);
            else if (GameWebUrls.sameOrigin(ShellConfig.server(c.getActivity()), url)) WebViewDialog.showServerPage(c.getActivity(), url);
            else WebViewDialog.show(c.getActivity(), url);
            c.complete("KGSUPPORT_SHOWINAPPWEBVIEW", "{\"isSuccess\":\"true\",\"resultCode\":200}");
            return null;
        });
        for (String name : new String[]{"KGSUPPORT_SHOWNOTICEVIEW", "KGSUPPORT_SHOWNOTICEVIEWFORONEDAY",
                "KGSUPPORT_SHOWNOTICEONLYVIEW"}) {
            ctx.on(name, (c, a) -> {
                WebViewDialog.show(c.getActivity(), ShellConfig.server(c.getActivity()) + "/game/news");
                c.complete(name, "{\"isSuccess\":\"true\",\"resultCode\":200}");
                return null;
            });
        }
        // Audited native signatures: odds/events/CS have no arguments; Daum cafe's old URL is deliberately ignored.
        for (String name : new String[]{"KGSUPPORT_SHOWGACHAODDSVIEW", "KGSUPPORT_SHOWEVENTWALL",
                "KGSUPPORT_SHOWEVENTPROGRESSWALL", "KGSUPPORT_SHOWCWVIEW", "KGSUPPORT_SHOWDAUMCAFEVIEW"}) {
            ctx.on(name, (c, a) -> {
                String page = GameWebUrls.page(ShellConfig.server(c.getActivity()), name);
                WebViewDialog.showServerPage(c.getActivity(), page);
                c.complete(name, "{\"isSuccess\":\"true\",\"resultCode\":200}");
                return null;
            });
        }
        ctx.on("KGCOUPON_SHOWCOUPONPOPUP", (c, a) -> {
            new Thread(() -> {
                try {
                    Activity activity = c.getActivity();
                    if (LocalServer.isLocal(ShellConfig.server(activity)) && LocalServer.available(activity)) {
                        // SH-13: the phone's own server: its admin site through a one-time login, no password
                        LocalServer.ensureRunning(activity, false);
                        WebViewDialog.showAdminPage(activity, LocalServer.adminLoginUrl(activity));
                        c.complete("KGCOUPON_SHOWCOUPONPOPUP", "{\"isSuccess\":\"true\",\"resultCode\":200}");
                        return;
                    }
                    ShellSession.refresh(c.getActivity());
                    String admin = ShellSession.adminUrl(c.getActivity());
                    if (admin != null) WebViewDialog.showAdminPage(c.getActivity(), admin);
                    else ShellDialogs.choose(c.getActivity(), "Admin panel unavailable", "Sign in with an admin account on this server.", "OK");
                } catch (Exception failure) {
                    ShellSession.clear();
                    try { ShellDialogs.choose(c.getActivity(), "Admin panel unavailable", "Couldn't verify your account. Check the server connection.", "OK"); }
                    catch (Exception ignored) { }
                }
                c.complete("KGCOUPON_SHOWCOUPONPOPUP", "{\"isSuccess\":\"true\",\"resultCode\":200}");
            }, "reflipped-admin").start();
            return null;
        });
        // Google Play Games is not available: report failure so the game falls back.
        for (String name : new String[]{"KGGOOGLEGAMES_LOGIN", "KGGOOGLEGAMES_LOGOUT"}) {
            ctx.on(name, (c, a) -> {
                c.complete(name, "{\"isSuccess\":\"false\",\"resultCode\":9999}");
                return null;
            });
        }
        // kgSessionInitializeSdk exists in the SWF but its call name is not resolved yet.
        ctx.noop("KGSESSION_INITIALIZESDK");

        // --- app options / system info (sync) ---
        ctx.on("KGAPPOPTION_GETGAMESERVERADDRESS", (c, a) -> ShellConfig.gameServer(c.getActivity()));
        ctx.on("KGAPPOPTION_GETCDNADDRESS", (c, a) -> ShellConfig.cdn(c.getActivity()));
        ctx.on("KGAPPOPTION_GETVALUE", (c, a) -> ShellConfig.appOption(c.getActivity(), Args.str(a, 0))); // unknown keys stay null and are logged
        ctx.constant(false, "KGAPPOPTION_ISINREVIEW", "KGPUSH_ISENABLEPUSH", "KGGOOGLEGAMES_ISLOGGEDIN");
        ctx.noop("KGAPPOPTION_SHOWUPDATERECOMMENDEDPOPOUP", "SESISOFT_OPENGOOGLEPLAY",
                "KGGOOGLEGAMESACHIEVEMENTS_SHOWACHIEVEMENTVIEW", "KGGOOGLEGAMESACHIEVEMENTS_UNLOCK");
        ctx.on("KGSYSTEM_GETDEVICEID", (c, a) -> deviceId(c.getActivity()));
        ctx.on("KGSYSTEM_GETDEVICEMODEL", (c, a) -> Build.MODEL);
        ctx.constant("android", "KGSYSTEM_GETOSNAME");
        ctx.on("KGSYSTEM_GETLANGUAGECODE", (c, a) -> Locale.getDefault().getLanguage());
        ctx.constant("us", "KGSYSTEM_GETCOUNTRYCODE", "KGSYSTEM_GETGEOCOUNTRYCODE", "SESISOFT_GETTELEPHONYCOUNTRY");
        ctx.constant("wifi", "KGSYSTEM_GETNETWORKTYPE");
        ctx.constant(true, "KGSYSTEM_ISNETWORKCONNECTED");
    }

    /**
     * Fetches the server list from Reflipped's infodesk appGroup route off the UI thread. This is the first
     * network step, so it is also where a build without a baked server asks for the address
     * ({@link ServerSetup}); an unreachable server offers Retry (and Change server) instead of failing.
     */
    private static void loadAppInfos(StubContext ctx) {
        Activity activity = ctx.getActivity();
        new Thread(() -> {
            try {
                prestartLocalServer(activity);
                String apps;
                while (true) {
                    String server = ServerSetup.ensureServer(activity);
                    // a "Signing out…" cover from before the game's restart: ensureServer's own dialogs end it first
                    ShellDialogs.endBusy(activity);
                    // a build without the server (--no-node) treats the address like any other
                    if (LocalServer.isLocal(server) && LocalServer.available(activity) && !startLocalServer(activity))
                        continue;
                    try {
                        String text = httpGet(server + "/infodesk/v2/appGroup?appGroupId=wdfp_service");
                        apps = new JSONObject(text).getJSONObject("content").getJSONArray("apps").toString();
                    } catch (Exception e) {
                        Log.w(StubContext.TAG, "appGroup fetch from " + server + " failed", e);
                        ServerSetup.unreachable(activity, server);
                        continue;
                    }
                    // SH-25: no game files yet: download them, or install them from a game data pack (any server)
                    if (GamePackSetup.offerIfMissing(activity, server)) break;
                }
                JSONObject result = new JSONObject()
                        .put("isSuccess", "true")
                        .put("resultCode", 200)
                        .put("serverInfos", apps); // a string: the game JSON.parses it again
                ctx.complete("KGSESSION_LOADAPPINFOS", result.toString());
            } catch (Exception e) {
                Log.e(StubContext.TAG, "loadAppInfos failed", e);
                ctx.complete("KGSESSION_LOADAPPINFOS", "{\"isSuccess\":\"false\",\"resultCode\":1001}");
            }
        }, "reflipped-appinfos").start();
    }

    /** Whether the next local-server start is the player's Retry: it clears the guard and a given-up state. */
    private static volatile boolean localServerFresh = false;

    /**
     * SH-13: when the app plays on the server on this phone, starts it at once, so it is up by the time the setup
     * dialogs are done (the app asks for the server list right after them).
     */
    private static void prestartLocalServer(Activity activity) {
        try {
            // a server the service gave up on waits for the player's Retry in the dialog below
            if (!LocalServer.isLocal(ShellConfig.server(activity)) || !LocalServer.available(activity)
                    || LocalServer.givenUp(activity) || !LocalDataPack.ready(activity)) return;
            LocalServer.start(activity, false);
        } catch (RuntimeException e) {
            Log.w(StubContext.TAG, "local server prestart failed (" + e.getClass().getSimpleName() + ")");
        }
    }

    /**
     * Waits until the server on this phone answers, starting it if needed. If it can't start, shows why with Node's
     * last output and offers Retry or Change server; returns false then, and the caller asks ensureServer again.
     */
    private static boolean startLocalServer(Activity activity) throws Exception {
        // an app update whose server needs another data pack gets it from where the last one came from
        boolean newPack = !LocalDataPack.ready(activity) && LocalPlaySetup.refreshPack(activity);
        try {
            LocalServer.ensureRunning(activity, localServerFresh || newPack);
            localServerFresh = false;
            // from here on the game is in play: restart the server on return, explain a server that stops
            LocalServer.keepRunningWhileShown(activity, () -> LocalServer.isLocal(ShellConfig.server(activity)));
            return true;
        } catch (LocalServer.Failed failed) {
            Log.w(StubContext.TAG, "local server failed: " + failed.getMessage());
            localServerFresh = true;
            String output = errorLines(failed.output, 6);
            if (ShellDialogs.choose(activity, "The server on this phone didn't start",
                    failed.getMessage() + (output.isEmpty() ? "" : "\n\n" + output), "Retry", "Change server") != 0)
                ShellConfig.prefs(activity).edit().putBoolean("chooseServer", true).apply();
            return false;
        }
    }

    /** Up to `max` lines of Node's output from its last error line on (a stack's top), else its last lines. */
    static String errorLines(String output, int max) {
        String[] lines = output.trim().split("\n");
        int start = Math.max(0, lines.length - max);
        for (int i = lines.length - 1; i >= 0; i--) {
            if (lines[i].contains("Error") || lines[i].contains("ERR_")) {
                start = i;
                break;
            }
        }
        return android.text.TextUtils.join("\n", java.util.Arrays.copyOfRange(lines, start, Math.min(lines.length, start + max))).trim();
    }

    private static String httpGet(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        int status = conn.getResponseCode();
        String text = read(status < 400 ? conn.getInputStream() : conn.getErrorStream());
        if (status != 200) throw new IllegalStateException("HTTP " + status + " from " + url);
        return text;
    }

    /**
     * Logs in to Reflipped's openapi (device login) off the UI thread, then completes `code`. The device secret is
     * the portal sign-in's device token, or the install's own key ({@link PortalSignIn}); a token the server no
     * longer knows (the account now plays on another device) sends the player back to the sign-in.
     */
    private static void startSession(StubContext ctx, String code, String appId) {
        Activity activity = ctx.getActivity();
        if (appId != null) lastAppId = appId;
        new Thread(() -> {
            try {
                String app = appId != null ? appId : lastAppId != null ? lastAppId : "";
                JSONObject player = loginDevice(activity, app, PortalSignIn.deviceSecret(activity, app, false));
                if (player == null) player = loginDevice(activity, app, PortalSignIn.deviceSecret(activity, app, true));
                if (player == null) throw new IllegalStateException("signed out again right after signing in");
                JSONObject idp = new JSONObject()
                        .put("idpCode", GAME_IDP_CODE)
                        .put("idpUserId", player.optString("idpId"))
                        .put("idpAccessToken", "");
                JSONObject result = new JSONObject()
                        .put("isSuccess", "true")
                        .put("resultCode", 200)
                        .put("isLoggedIn", "true")
                        .put("playerId", player.getString("playerId"))
                        .put("accessToken", player.getString("zat"))
                        .put("idpProfile", idp.toString()) // the game parses this string a second time
                        .put("appId", appId)
                        .put("isGoogleGamesLoggedIn", "false");
                ctx.complete(code, result.toString());
            } catch (PortalSignIn.AnotherServer another) {
                // SH-16 patches the game to restart at once on this, without its connection error; the restarted
                // title fetches the app infos again, where ServerSetup opens the server list (`chooseServer`).
                ShellDialogs.busy(activity, "Opening the server list…");
                ctx.complete(code, "{\"isSuccess\":\"false\",\"isLoggedIn\":\"false\",\"resultCode\":1001,\"reflippedRestart\":true}");
            } catch (Exception e) {
                Log.e(StubContext.TAG, "Reflipped login failed (" + e.getClass().getSimpleName() + ")");
                ctx.complete(code, "{\"isSuccess\":\"false\",\"isLoggedIn\":\"false\",\"resultCode\":1001}");
            }
        }, "reflipped-login").start();
    }

    /**
     * Sign out only after the player confirms it (the Kakao SDK asked too) and after revocation, then let the patched
     * game's original soft restart run. A "Signing out…" cover hides the restart until the server list appears.
     */
    private static void logOut(StubContext ctx, String code) {
        Activity activity = ctx.getActivity();
        new Thread(() -> {
            try {
                if (ShellDialogs.confirm(activity, "Sign out?",
                        "Your progress stays saved on this server. You can then pick a server and sign in, or play as a guest.",
                        "Sign out", "Cancel") != 0) {
                    // SH-16 patches the game's handler to end quietly on this, instead of showing a failed logout
                    ctx.complete(code, "{\"isSuccess\":\"false\",\"reflippedCancelled\":true,\"resultCode\":0}");
                    return;
                }
                ShellDialogs.busy(activity, "Signing out…");
                PortalSignIn.logOut(activity);
                // SH-14 patches only the destructive localStore.delete out of the original soft-restart handler; the
                // game's kept viewer ID goes when the next login plays another account (ShellConfig.viewerReset).
                ctx.complete(code, "{\"isSuccess\":\"true\",\"resultCode\":200}");
            } catch (Exception e) {
                Log.e(StubContext.TAG, "log out failed (" + e.getClass().getSimpleName() + ")");
                ShellDialogs.endBusy(activity);
                // a failed logout the game shows as such, without deleting anything
                ctx.complete(code, "{\"isSuccess\":\"false\",\"resultCode\":9999}");
            }
        }, "reflipped-logout").start();
    }

    /**
     * A guest's account button in Account Info: sign in through the app's sign-in, then close the app so the next
     * launch plays the account's save (which takes over the guest progress if the account has none yet).
     */
    private static void linkAccount(StubContext ctx) {
        Activity activity = ctx.getActivity();
        new Thread(() -> {
            try {
                if (PortalSignIn.signInNow(activity, lastAppId == null ? "" : lastAppId)) AppRestart.close(activity);
            } catch (Exception e) {
                Log.e(StubContext.TAG, "account link failed (" + e.getClass().getSimpleName() + ")");
            }
        }, "reflipped-link").start();
    }

    /**
     * A link button in the game's account menu (ACC-12): on a server with accounts, log in to one through the portal,
     * then close the app so the next launch plays that save (the running game still holds the one it started with).
     * Backing out, or a server without accounts, reports a failed link, which the game shows as such.
     */
    private static void connect(StubContext ctx, String code) {
        Activity activity = ctx.getActivity();
        new Thread(() -> {
            try {
                if (ShellConfig.serverHasPortal(activity)) {
                    if (PortalSignIn.signInNow(activity, lastAppId == null ? "" : lastAppId)) AppRestart.close(activity);
                    else ctx.complete(code, "{\"isSuccess\":\"false\",\"reflippedCancelled\":true,\"resultCode\":0}");
                    return;
                }
            } catch (Exception e) {
                Log.e(StubContext.TAG, "account menu sign-in failed (" + e.getClass().getSimpleName() + ")");
            }
            ctx.complete(code, "{\"isSuccess\":\"false\",\"resultCode\":" + CONNECT_FAILURE + "}");
        }, "reflipped-connect").start();
    }

    /**
     * POST /openapi/service/v4/auth/loginDevice with `secret` as whiteKey; returns {playerId, zat, idpCode, idpId}, or
     * null when the server refuses a device token as signed out (401 `signed-out`).
     */
    private static JSONObject loginDevice(Activity activity, String appId, String secret) throws Exception {
        String deviceId = deviceId(activity);
        JSONObject body = new JSONObject()
                .put("appId", appId)
                .put("deviceId", deviceId)
                .put("serialNo", deviceId)
                .put("whiteKey", secret)
                .put("os", "android")
                .put("lang", Locale.getDefault().getLanguage())
                .put("deviceModel", Build.MODEL)
                .put("osVer", Build.VERSION.RELEASE);
        String savedPlayer = ShellConfig.prefs(activity).getString("playerId", null);

        HttpURLConnection conn = CredentialRequests.open(ShellConfig.openApi(activity) + "/v4/auth/loginDevice");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        // SH-15: the server keeps the app version and build an account signs in with (admin Players page)
        ShellConfig.identifyApp(activity, conn);
        if (savedPlayer != null) conn.setRequestProperty("playerId", savedPlayer);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int status = conn.getResponseCode();
        String text = read(status < 400 ? conn.getInputStream() : conn.getErrorStream());
        if (status == 401 && "signed-out".equals(new JSONObject(text.isEmpty() ? "{}" : text).optString("code"))) {
            ShellSession.clear();
            return null;
        }
        if (status != 200) throw new IllegalStateException("loginDevice HTTP " + status);

        JSONObject json = new JSONObject(text);
        JSONObject player = json.getJSONObject("player");
        String playerId = player.getString("playerId");
        ShellConfig.prefs(activity).edit().putString("playerId", playerId).apply();
        ShellConfig.loggedIn(activity, playerId);
        try { ShellSession.refresh(activity); }
        catch (Exception failure) {
            ShellSession.clear();
            Log.w(StubContext.TAG, "session display hints unavailable (" + failure.getClass().getSimpleName() + ")");
        }
        return new JSONObject()
                .put("playerId", playerId)
                .put("zat", json.getString("zat"))
                .put("idpCode", player.optString("idpCode", "zd3"))
                .put("idpId", player.optString("idpId"));
    }

    private static String deviceId(Activity activity) {
        String id = Settings.Secure.getString(activity.getContentResolver(), Settings.Secure.ANDROID_ID);
        return id == null ? "reflipped-shell" : id;
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        for (int n; (n = in.read(chunk)) > 0; ) buf.write(chunk, 0, n);
        in.close();
        return buf.toString("UTF-8");
    }
}
