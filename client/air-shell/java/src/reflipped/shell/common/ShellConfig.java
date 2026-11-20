package reflipped.shell.common;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;


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
     * An explicit new player selection wins; otherwise a baked default wins over pre-upgrade remembered prefs.
     * With neither, setup asks for an address. This marker prevents a stale address silently changing a baked build.
     */
    public static String server(Activity activity) {
        String selected = ServerIdentity.selected(bakedServer(activity), prefs(activity).getString("server", null),
                prefs(activity).getBoolean("serverSelected", false));
        String valid = ServerIdentity.connectionAddress(selected);
        return valid == null ? "" : valid;
    }

    public static void scopeAccount(Activity activity) {
        SharedPreferences prefs = prefs(activity);
        String current = server(activity);
        String legacyOrigin = prefs.getString("legacyDeviceOrigin", null);
        if (legacyOrigin != null && ServerIdentity.recorded(legacyOrigin, null).isEmpty()) {
            // A formerly accepted URL prefix is not proof that its key belongs to the host's root deployment.
            // Preserve the key, but make recovery explicit instead of aliasing that deployment to the root.
            prefs.edit().remove("legacyDeviceOrigin").putBoolean("chooseServer", true)
                    .putBoolean("serverAssetReset", true).apply();
        }
        String recordedCdnServer = ServerIdentity.recorded(prefs.getString("accountServer", null), prefs.getString("server", null));
        CdnSelection.initialize(keyStore(activity), bakedServer(activity), meta(activity, "reflipped.cdn"), recordedCdnServer,
                prefs.contains("deviceKey") || prefs.contains("playerId") || prefs.contains("portalToken") || prefs.contains("signIn"));
        if (!prefs.contains("serverCdnFor") && !recordedCdnServer.isEmpty())
            prefs.edit().putString("serverCdnFor", recordedCdnServer).apply();
        if (!prefs.getBoolean("keyMigrationChecked", false)) {
            String recorded = ServerIdentity.recorded(prefs.getString("accountServer", null), prefs.getString("server", null));
            if (!recorded.isEmpty()) DeviceKeys.associateLegacy(keyStore(activity), recorded);
            else if (prefs.contains("deviceKey") || prefs.contains("playerId") || prefs.contains("portalToken") || prefs.contains("signIn")) {
                // An older baked build may have changed addresses with no historical origin stored.
                // Keep the legacy guest key recoverable, but never send its unscoped account token implicitly.
                SharedPreferences.Editor unknown = prefs.edit();
                forgetAccount(unknown);
                unknown.putBoolean("chooseServer", true).putBoolean("serverAssetReset", true).apply();
            }
            if (!recorded.isEmpty() && !prefs.contains("assetServer")
                    && (prefs.contains("deviceKey") || prefs.contains("playerId") || prefs.contains("portalToken")))
                prefs.edit().putString("assetServer", recorded).apply();
            prefs.edit().putBoolean("keyMigrationChecked", true).apply();
        }
        String bound = prefs.getString("accountServer", null);
        if (bound == null) bound = prefs.getString("server", current);
        SharedPreferences.Editor edit = prefs.edit();
        if (!ServerIdentity.same(current, bound)) forgetAccount(edit);
        edit.putString("accountServer", current).apply();
    }

    /** The `build.py --server` value, "" for a build that asks the player. */
    public static String bakedServer(Activity activity) {
        String value = meta(activity, "reflipped.server");
        String valid = ServerIdentity.connectionAddress(value);
        return valid == null ? "" : valid;
    }

    /**
     * Stores an accepted server address with what its /shell/config reported: the CDN ("" for none) and whether it
     * has the player portal. A different address than before drops `playerId` and the portal sign-in
     * ({@link PortalSignIn}), which belong to the old server's accounts; `deviceKey` stays.
     */
    public static void setServer(Activity activity, String server, String cdn, boolean portal) {
        String previous = server(activity);
        CdnSelection.accepted(keyStore(activity), bakedServer(activity), meta(activity, "reflipped.cdn"), server);
        SharedPreferences.Editor edit = prefs(activity).edit();
        if (!ServerIdentity.same(server, previous)) forgetAccount(edit);
        if (!prefs(activity).contains("assetServer")) edit.putString("assetServer", server);
        edit.putString("accountServer", server).putString("server", server).putBoolean("serverSelected", true)
                .putString("serverCdn", cdn).putString("serverCdnFor", server).putBoolean("serverPortal", portal).apply();
        ShellSession.clear();
    }

    /** Forgets the entered address (with its CDN and account) so {@link ServerSetup} asks again. */
    public static void clearServer(Activity activity) {
        ShellSession.clear();
        SharedPreferences.Editor edit = prefs(activity).edit().remove("server").remove("serverCdn").remove("serverCdnFor").remove("serverPortal").remove("serverName").remove("serverVersion").remove("serverConfigFor");
        forgetAccount(edit);
        edit.apply();
    }

    private static void forgetAccount(SharedPreferences.Editor edit) {
        edit.remove("playerId").remove("portalToken").remove("signIn");
        ShellSession.clear();
    }

    /** The server and account this process last logged in to ({@link #loggedIn}); null before the first login. */
    private static String sessionAccount;

    /** Records the account a successful device login plays, for {@link #viewerReset}. */
    public static synchronized void loggedIn(Activity activity, String playerId) {
        sessionAccount = server(activity) + " " + playerId;
    }

    /**
     * FIX-12: answers the patched game's `viewerReset` question, asked when it chooses between tool/signup and /load
     * after a login. "true" when that login's server and account differ from the ones the game's kept viewer ID came
     * from (`viewerAccount`; unknown on a first run or an older install): the game then deletes its stored account
     * and signs up, so the server hands it this account's own viewer ID instead of /load refusing the old account's.
     * `cleared` is the game's acknowledgment (`viewerCleared`) once it deleted it: the ID it signs up for next is this
     * account's.
     */
    private static synchronized String viewerReset(Activity activity, boolean cleared) {
        SharedPreferences prefs = prefs(activity);
        if (sessionAccount == null || sessionAccount.equals(prefs.getString("viewerAccount", null))) return "false";
        if (cleared) prefs.edit().putString("viewerAccount", sessionAccount).apply();
        return "true";
    }

    /** Refreshes what a server's /shell/config reported, keeping the address. */
    public static void setServerConfig(Activity activity, String cdn, boolean portal) {
        prefs(activity).edit().putString("serverCdn", cdn).putString("serverCdnFor", server(activity)).putBoolean("serverPortal", portal).apply();
    }

    /** Metadata is usable only for the origin whose config supplied it (including baked-default upgrades). */
    public static void setMetadata(Activity activity, String server, String name, String version) {
        prefs(activity).edit().putString("serverConfigFor", server).putString("serverName", name)
                .putString("serverVersion", version).apply();
    }

    public static String serverName(Activity activity) {
        if (!server(activity).equals(prefs(activity).getString("serverConfigFor", ""))) return "Reflipped";
        return prefs(activity).getString("serverName", "Reflipped");
    }

    public static String serverVersion(Activity activity) {
        if (!server(activity).equals(prefs(activity).getString("serverConfigFor", ""))) return "";
        return prefs(activity).getString("serverVersion", "");
    }

    /** SH-15: the Reflipped app version build.py baked in (client/air-shell/VERSION), "" for a build without one. */
    public static String appVersion(Activity activity) {
        String value = metaText(activity, "reflipped.version");
        return value == null ? "" : value;
    }

    /** SH-15: the build ID build.py baked in (commit[-dirty].yyyymmdd.baked|picker), "" for a build without one. */
    public static String appBuild(Activity activity) {
        String value = metaText(activity, "reflipped.build");
        return value == null ? "" : value;
    }

    /** Names this app on a request to the server (/shell/config, sign-in), as src/lib/appVersion.ts reads it. */
    public static void identifyApp(Activity activity, java.net.URLConnection connection) {
        String version = appVersion(activity), build = appBuild(activity);
        if (!version.isEmpty()) connection.setRequestProperty(AppVersion.VERSION_HEADER, version);
        if (!build.isEmpty()) connection.setRequestProperty(AppVersion.BUILD_HEADER, build);
    }

    /** The title screen's version line: "Server name · app 0.1.0 · server 1.0.1". */
    public static String versionLine(Activity activity) {
        String app = AppVersion.label(appVersion(activity)), server = serverVersion(activity);
        return serverName(activity) + (app.isEmpty() ? "" : " · " + app) + (server.isEmpty() ? "" : " · server " + server);
    }

    /** The in-game account button's URL for a guest; never opened as a page. */
    public static final String LINK_ACCOUNT_PATH = "/portal/shell";

    /** Playing without an account on a server that has accounts. */
    public static boolean playsAsGuest(Activity activity) {
        return serverHasPortal(activity) && !prefs(activity).contains("portalToken");
    }

    /** Whether the server's /shell/config said it has the player portal (ACC-3), so the shell can sign in there. */
    public static boolean serverHasPortal(Activity activity) {
        return prefs(activity).getBoolean("serverPortal", false);
    }

    /** Matches infodesk appOption.gameServerAddr: the game appends /latest/api/index.php itself. */
    public static String gameServer(Activity activity) {
        return server(activity);
    }

    /**
     * Matches infodesk appOption.cdnAddr (`http://patch.wdfp.kakaogames.com/Live/2.0.0` → /patch prefix).
     * A `build.py --cdn` applies only to its associated server origin. Other origins use their own reported CDN
     * or their own /patch; no prior server's override or reported metadata crosses a server switch.
     */
    public static String cdn(Activity activity) {
        return CdnSelection.select(keyStore(activity), server(activity), bakedServer(activity), meta(activity, "reflipped.cdn"),
                prefs(activity).getString("serverCdn", null), prefs(activity).getString("serverCdnFor", null));
    }

    public static String openApi(Activity activity) {
        return server(activity) + "/openapi/service";
    }

    /**
     * Answers `KGAPPOPTION_GETVALUE(key)`: the infodesk `appOption` values the game reads. News and notice
     * links point at Reflipped's /game/news page; null (logged by the stub) for keys nobody has needed yet.
     */
    public static String appOption(Activity activity, String key) {
        if (key == null) return null;
        if (key.endsWith("EN") || key.endsWith("KO") || key.endsWith("TH")) key = key.substring(0, key.length() - 2);
        switch (key) {
            case "serverAssetReset": return prefs(activity).getBoolean("serverAssetReset", false) ? "true" : "false";
            case "assetsCleared":
                // the files are this server's now, with its layers (SH-13: GameFiles)
                prefs(activity).edit().remove("serverAssetReset").putString("assetServer", server(activity))
                        .putString("assetInfo", prefs(activity).getString("serverAssets", "")).apply();
                return "true";
            case "viewerReset": return viewerReset(activity, false);
            case "viewerCleared": return viewerReset(activity, true);
            case "serverName": return serverName(activity);
            case "serverInfo": return versionLine(activity);
            case "serverVersion": return serverVersion(activity);
            case "hideFacebook": return "true";
            // the Admin panel entry: admins of an online server, and always on the server on this phone (SH-13)
            case "useCoupon": return ShellSession.adminUrl(activity) != null || (reflipped.shell.service.LocalServer
                    .isLocal(server(activity)) && reflipped.shell.service.LocalServer.available(activity)) ? "true" : "false";
            case "urlTermsAndConditions": return server(activity) + "/game/terms";
            case "urlPrivacyPolicy": return server(activity) + "/game/privacy";
            case "urlCredits": return server(activity) + "/game/credits";
            // A guest's Account Info button links an account through the app's sign-in (KakaoGameSdkStub intercepts
            // this exact URL); a signed-in player manages the account on the portal.
            case "urlAccount": return server(activity) + (playsAsGuest(activity) ? LINK_ACCOUNT_PATH : "/portal");
            case "accountLabel": return playsAsGuest(activity) ? "Link an account" : "Reflipped account";
            case "urlHomeNews":
            case "urlHomeNewsEN":
            case "urlNotice":
            case "urlTitleMenuNews":
                return server(activity) + "/game/news";
            case "urlFriendFollowServer":
                return gameServer(activity);
            case "urlCommunity":
            case "urlOtherMenuOfficialCafe":
            case "daumCafeUrl":
                return server(activity) + "/game/community";
            case "urlTitleMenuContact":
            case "urlOtherMenuContact":
                return server(activity) + "/game/support";
            default:
                return null;
        }
    }

    public static SharedPreferences prefs(Activity activity) {
        return activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Random per-install key that identifies this device's account to Reflipped (sent as whiteKey/idpId). */
    public static String deviceKey(Activity activity) {
        return DeviceKeys.forServer(keyStore(activity), server(activity));
    }

    public static DeviceKeys.Store keyStore(Activity activity) {
        final SharedPreferences stored = prefs(activity);
        return new DeviceKeys.Store() {
            public String get(String name) { return stored.getString(name, null); }
            public void put(String name, String value) { stored.edit().putString(name, value).apply(); }
        };
    }

    /** A meta-data value as text even if the manifest parser typed it (a value like "1" becomes an Integer). */
    private static String metaText(Activity activity, String name) {
        try {
            ApplicationInfo info = activity.getPackageManager()
                    .getApplicationInfo(activity.getPackageName(), PackageManager.GET_META_DATA);
            Object value = info.metaData == null ? null : info.metaData.get(name);
            return value == null ? null : String.valueOf(value).trim();
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
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
