package reflipped.shell.common;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;

import java.util.UUID;

/**
 * Settings baked into the APK by build.py as manifest meta-data, plus per-install state.
 *
 * `reflipped.server` is the Reflipped base URL, e.g. http://192.168.1.10:8000, or empty when the build
 * leaves it to the player ({@link ServerSetup}). The game API, CDN and openapi paths are derived from it the same way the archived mitmproxy addon (archive/mitmproxy/scripts/mitm-redirect-traffic.py) mapped hosts.
 */
public final class ShellConfig {
    // Keeps the project's old name: it holds the per-install account key, so renaming it would orphan accounts.
    private static final String PREFS = "starpoint_shell";

    private ShellConfig() {
    }

    /**
     * The Reflipped base URL: the one baked into the build, else the address the player entered (stored in
     * the prefs), else "" (nothing known yet; {@link ServerSetup} asks before the first request). A baked
     * build installed over one that asked must not keep the old address: it can't offer "Change server".
     */
    public static String server(Activity activity) {
        String baked = bakedServer(activity);
        if (!baked.isEmpty()) return baked;
        String stored = prefs(activity).getString("server", null);
        return stored != null ? stored : "";
    }

    /** The `build.py --server` value, "" for a build that asks the player. */
    public static String bakedServer(Activity activity) {
        String value = meta(activity, "reflipped.server");
        if (value == null) return "";
        return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
    }

    /** True when the player can't change the server: it was fixed at build time. */
    public static boolean serverIsBaked(Activity activity) {
        return !bakedServer(activity).isEmpty();
    }

    /**
     * Stores an accepted server address and the CDN its /shell/config named ("" for none). A different
     * address than before drops `playerId`, which belongs to the old server's accounts; `deviceKey` stays.
     */
    public static void setServer(Activity activity, String server, String cdn) {
        SharedPreferences.Editor edit = prefs(activity).edit();
        if (!server.equals(prefs(activity).getString("server", null))) edit.remove("playerId");
        edit.putString("server", server).putString("serverCdn", cdn).apply();
    }

    /** Forgets the entered address (with its CDN and account) so {@link ServerSetup} asks again. */
    public static void clearServer(Activity activity) {
        prefs(activity).edit().remove("server").remove("serverCdn").remove("playerId").apply();
    }

    /** Refreshes the CDN a server's /shell/config reported ("" for none), keeping the address. */
    public static void setServerCdn(Activity activity, String cdn) {
        prefs(activity).edit().putString("serverCdn", cdn).apply();
    }

    /** Matches infodesk appOption.gameServerAddr: the game appends /latest/api/index.php itself. */
    public static String gameServer(Activity activity) {
        return server(activity);
    }

    /**
     * Matches infodesk appOption.cdnAddr (`http://patch.wdfp.kakaogames.com/Live/2.0.0` → /patch prefix).
     * A `build.py --cdn` wins, then the CDN the server's /shell/config named, then Reflipped's own /patch.
     */
    public static String cdn(Activity activity) {
        String baked = meta(activity, "reflipped.cdn");
        if (baked != null && !baked.isEmpty()) return baked;
        String reported = prefs(activity).getString("serverCdn", null);
        if (reported != null && !reported.isEmpty()) return reported;
        return server(activity) + "/patch/Live/2.0.0";
    }

    public static String openApi(Activity activity) {
        return server(activity) + "/openapi/service";
    }

    /**
     * Answers `KGAPPOPTION_GETVALUE(key)`: the infodesk `appOption` values the game reads. News and notice
     * links point at Reflipped's /news page; null (logged by the stub) for keys nobody has needed yet.
     */
    public static String appOption(Activity activity, String key) {
        if (key == null) return null;
        switch (key) {
            case "urlHomeNews":
            case "urlHomeNewsEN":
            case "urlNotice":
            case "urlTitleMenuNews":
                return server(activity) + "/news";
            case "urlFriendFollowServer":
                return gameServer(activity);
            case "urlCommunity":
            case "urlOtherMenuOfficialCafe":
                return "https://twitter.com/Worldflipper_kg";
            default:
                return null;
        }
    }

    public static SharedPreferences prefs(Activity activity) {
        return activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Random per-install key that identifies this device's account to Reflipped (sent as whiteKey/idpId). */
    public static String deviceKey(Activity activity) {
        SharedPreferences p = prefs(activity);
        String key = p.getString("deviceKey", null);
        if (key == null) {
            key = UUID.randomUUID().toString();
            p.edit().putString("deviceKey", key).apply();
        }
        return key;
    }

    private static String meta(Activity activity, String name) {
        try {
            ApplicationInfo info = activity.getPackageManager()
                    .getApplicationInfo(activity.getPackageName(), PackageManager.GET_META_DATA);
            Bundle data = info.metaData;
            return data == null ? null : data.getString(name);
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
    }
}
