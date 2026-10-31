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

import reflipped.shell.common.Args;
import reflipped.shell.common.ServerSetup;
import reflipped.shell.common.ShellConfig;
import reflipped.shell.common.StubContext;
import reflipped.shell.common.WebViewDialog;
import reflipped.shell.common.StubExtension;

/**
 * Replaces the Kakao Game SDK ANE (`com.sesisoft.KakaoGameSdk`). See docs/air-shell.md.
 *
 * Async calls: the AS3 wrapper waits for a StatusEvent whose code is the call name, then reads
 * GETLASTRESULT (a JSON string; every handler checks `isSuccess == "true"`).
 */
public class KakaoGameSdkStub extends StubExtension {
    static final String ID = "com.sesisoft.KakaoGameSdk";
    private static final String IDP_CODE = "zd3"; // what Reflipped's loginDevice assigns to device accounts

    @Override
    protected String extensionId() {
        return ID;
    }

    @Override
    protected void register(StubContext ctx) {
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
                "KGSESSION_CONNECT", "KGSESSION_LOGOUT", "KGSESSION_UNREGISTER", "KGSESSION_PAUSE", "KGSESSION_RESUME",
                "KGSESSIONFORCUSTOMUI_CONNECT", "KGSESSIONFORCUSTOMUI_LOGOUT", "KGSESSIONFORCUSTOMUI_UNREGISTER",
                "KGSUPPORT_SHOWNOTICEVIEW", "KGSUPPORT_SHOWNOTICEVIEWFORONEDAY", "KGSUPPORT_SHOWNOTICEONLYVIEW",
                "KGSUPPORT_SHOWINAPPWEBVIEW", "KGSUPPORT_SHOWGACHAODDSVIEW", "KGSUPPORT_SHOWEVENTWALL",
                "KGSUPPORT_SHOWEVENTPROGRESSWALL", "KGSUPPORT_SHOWDAUMCAFEVIEW", "KGSUPPORT_SHOWCWVIEW",
                "KGPROMOTION_SHOWSTARTINGPROMOTIONPOPUPS", "KGPROMOTION_SHOWENDINGPROMOTIONPOPUPS",
                "KGPLAYER_LOADFRIENDPLAYERS", "KGIDPPROFILE_REFRESHLOCALIDPPROFILE", "KGCOUPON_SHOWCOUPONPOPUP",
                "KGLOG_WRITEROUNDLOG", "KGLOG_WRITERESOURCELOG", "KGLOG_WRITENETWORKLOG", "KGLOG_WRITEITEMLOG",
                "KGLOG_WRITEACTIONLOG", "KGPUSH_ENABLEPUSH", "KGLOCALPLAYER_GETCURRENTPLAYER"}) {
            ctx.on(name, (c, a) -> {
                c.complete(name, "{\"isSuccess\":\"true\",\"resultCode\":200}");
                return null;
            });
        }
        // in-app web views: the game passes the URL (from KGAPPOPTION_GETVALUE) to SHOWINAPPWEBVIEW; the notice
        // views have no URL of their own, so they show Reflipped's news page
        ctx.on("KGSUPPORT_SHOWINAPPWEBVIEW", (c, a) -> {
            WebViewDialog.show(c.getActivity(), Args.str(a, 0));
            c.complete("KGSUPPORT_SHOWINAPPWEBVIEW", "{\"isSuccess\":\"true\",\"resultCode\":200}");
            return null;
        });
        for (String name : new String[]{"KGSUPPORT_SHOWNOTICEVIEW", "KGSUPPORT_SHOWNOTICEVIEWFORONEDAY",
                "KGSUPPORT_SHOWNOTICEONLYVIEW"}) {
            ctx.on(name, (c, a) -> {
                WebViewDialog.show(c.getActivity(), ShellConfig.server(c.getActivity()) + "/news");
                c.complete(name, "{\"isSuccess\":\"true\",\"resultCode\":200}");
                return null;
            });
        }
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
                String apps;
                while (true) {
                    String server = ServerSetup.ensureServer(activity);
                    try {
                        String text = httpGet(server + "/infodesk/v2/appGroup?appGroupId=wdfp_service");
                        apps = new JSONObject(text).getJSONObject("content").getJSONArray("apps").toString();
                        break;
                    } catch (Exception e) {
                        Log.w(StubContext.TAG, "appGroup fetch from " + server + " failed", e);
                        ServerSetup.unreachable(activity, server);
                    }
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

    private static String httpGet(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        int status = conn.getResponseCode();
        String text = read(status < 400 ? conn.getInputStream() : conn.getErrorStream());
        if (status != 200) throw new IllegalStateException("HTTP " + status + " from " + url);
        return text;
    }

    /** Logs in to Reflipped's openapi (device login) off the UI thread, then completes `code`. */
    private static void startSession(StubContext ctx, String code, String appId) {
        Activity activity = ctx.getActivity();
        new Thread(() -> {
            try {
                JSONObject player = loginDevice(activity, appId == null ? "" : appId);
                JSONObject idp = new JSONObject()
                        .put("idpCode", player.optString("idpCode", IDP_CODE))
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
            } catch (Exception e) {
                Log.e(StubContext.TAG, "Reflipped login failed", e);
                ctx.complete(code, "{\"isSuccess\":\"false\",\"isLoggedIn\":\"false\",\"resultCode\":1001}");
            }
        }, "reflipped-login").start();
    }

    /** POST /openapi/service/v4/auth/loginDevice; returns {playerId, zat, idpCode, idpId}. */
    private static JSONObject loginDevice(Activity activity, String appId) throws Exception {
        String deviceId = deviceId(activity);
        JSONObject body = new JSONObject()
                .put("appId", appId)
                .put("deviceId", deviceId)
                .put("serialNo", deviceId)
                .put("whiteKey", ShellConfig.deviceKey(activity))
                .put("os", "android")
                .put("lang", Locale.getDefault().getLanguage())
                .put("deviceModel", Build.MODEL)
                .put("osVer", Build.VERSION.RELEASE);
        String savedPlayer = ShellConfig.prefs(activity).getString("playerId", null);

        HttpURLConnection conn = (HttpURLConnection) new URL(ShellConfig.openApi(activity) + "/v4/auth/loginDevice").openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        if (savedPlayer != null) conn.setRequestProperty("playerId", savedPlayer);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int status = conn.getResponseCode();
        String text = read(status < 400 ? conn.getInputStream() : conn.getErrorStream());
        if (status != 200) throw new IllegalStateException("loginDevice HTTP " + status + ": " + text);

        JSONObject json = new JSONObject(text);
        JSONObject player = json.getJSONObject("player");
        String playerId = player.getString("playerId");
        ShellConfig.prefs(activity).edit().putString("playerId", playerId).apply();
        return new JSONObject()
                .put("playerId", playerId)
                .put("zat", json.getString("zat"))
                .put("idpCode", player.optString("idpCode", IDP_CODE))
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
