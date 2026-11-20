package reflipped.shell.common;

import android.app.Activity;
import android.content.SharedPreferences;
import android.util.Log;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Connection setup runs on the Kakao stub's worker thread, never on AIR's runtime/UI thread. */
public final class ServerSetup {
    private ServerSetup() { }

    /** The update the known server offered with its last refusal ({@link #refreshConfig}), or null. */
    private static volatile AppUpdater.Apk refusedApk;

    /** Something answered at the address, but not as a Reflipped server. */
    public static class NotReflipped extends Exception {
        NotReflipped(String message) { super(message); }
    }

    /** A server answered but is down or busy right now (5xx, 408 or 429), e.g. a proxy in front of a stopped server. */
    public static final class NotReady extends Exception {
        NotReady(String message) { super(message); }
    }

    /**
     * SH-15: a Reflipped server this app can't join: it needs a newer app (protocol or oldest supported version) or
     * runs a protocol this app no longer speaks. The message is {@link AppVersion#refusal}'s, shown as is.
     */
    public static final class NeedsUpdate extends Exception {
        /** The update the refusing server offers to install, or null. */
        final AppUpdater.Apk apk;
        NeedsUpdate(String message, AppUpdater.Apk apk) { super(message); this.apk = apk; }
    }

    /** The address answered with a redirect; credentials never follow one, so the player needs the final address. */
    public static final class Moved extends NotReflipped {
        Moved() { super("Redirect"); }
    }
    private static final class CheckedServer {
        final String address; final JSONObject config;
        CheckedServer(String address, JSONObject config) { this.address = address; this.config = config; }
    }

    public static String ensureServer(Activity activity) throws Exception {
        Log.i(StubContext.TAG, "Reflipped app " + ShellConfig.appVersion(activity) + ", build " + ShellConfig.appBuild(activity));
        ShellConfig.scopeAccount(activity);
        String known = ShellConfig.server(activity);
        String assetsFrom = ShellConfig.prefs(activity).getString("assetServer", "");
        boolean rememberedAccount = ShellConfig.prefs(activity).contains("playerId")
                || ShellConfig.prefs(activity).contains("portalToken") || ShellConfig.prefs(activity).contains("signIn");
        boolean choose = ShellConfig.prefs(activity).getBoolean("chooseServer", false) || known.isEmpty()
                || (!ShellConfig.prefs(activity).getBoolean("playModeChosen", false) && !rememberedAccount)
                || (!assetsFrom.isEmpty() && !ServerIdentity.same(assetsFrom, known));
        if (!choose) {
            // A server this app can't join stops here with its reason; Change server opens the server list.
            String refusal;
            while ((refusal = refreshConfig(activity, known)) != null) {
                AppUpdater.Apk apk = refusedApk;
                if (apk != null) {
                    // SH-15: the server offers the version it needs: install it here (Android asks to confirm)
                    int choice = ShellDialogs.chooseRowWithBack(activity, "Update the Reflipped app", refusal, 1,
                            "Install update", "Change server", "Retry");
                    if (choice == 0) {
                        AppUpdater.install(activity, apk);
                        continue;
                    }
                    if (choice == 1) {
                        ShellConfig.prefs(activity).edit().putBoolean("chooseServer", true).apply();
                        choose = true;
                        break;
                    }
                    continue;
                }
                if (ShellDialogs.choose(activity, "Update the Reflipped app", refusal, "Retry", "Change server") != 0) {
                    ShellConfig.prefs(activity).edit().putBoolean("chooseServer", true).apply();
                    choose = true;
                    break;
                }
            }
            if (!choose) return known;
        }
        while (true) {
            boolean local = reflipped.shell.service.LocalServer.available(activity);
            // SH-29: with game files on the phone, a last row saves them as a pack for another phone
            boolean export = GameDataExport.offered(activity);
            java.util.List<String> rows = new java.util.ArrayList<>(java.util.Arrays.asList("Server"));
            if (local) rows.add("Local play");
            if (export) rows.add("Export game data");
            int how = ShellDialogs.chooseRow(activity, "Welcome to Reflipped", "Choose how you want to play.",
                    local ? null : "Local play", rows.toArray(new String[0]));
            if (export && how == rows.size() - 1) {
                GameDataExport.run(activity);
                continue;
            }
            if (local && how == 1) {
                // SH-13: the server on this phone, set up (data pack, game files' CDN) and started
                String address = LocalPlaySetup.run(activity);
                if (address == null) continue;
                JSONObject config;
                try {
                    config = fetchConfig(activity, address);
                } catch (Exception failure) {
                    Log.w(StubContext.TAG, "local server config failed (" + failure.getClass().getSimpleName() + ")");
                    continue;
                }
                if (apply(activity, address, config)) return address;
                continue;
            }
            String initial = known;
            ServerBrowser.Memory memory = new ServerBrowser.Memory();
            while (true) {
                CheckedServer checked = ShellDialogs.address(activity, initial, new ShellDialogs.AddressChecker<CheckedServer>() {
                    public CheckedServer check(String typed) throws Exception {
                        String address = normalize(typed);
                        if (address == null) throw new IllegalArgumentException("Invalid server address");
                        // the local server's address typed by hand (a developer path; players use Local play)
                        if (reflipped.shell.service.LocalServer.isLocal(address)
                                && reflipped.shell.service.LocalServer.available(activity))
                            // not fresh: the server list probes its cards in the background too, and only the
                            // player's Retry may restart a server the guard gave up on (the card shows why)
                            reflipped.shell.service.LocalServer.ensureRunning(activity, false);
                        return new CheckedServer(address, fetchConfig(activity, address));
                    }
                    public ServerDirectory.Entry entry(CheckedServer result) {
                        return ServerDirectory.reported(result.address, result.config);
                    }
                }, memory);
                if (checked == null) break;
                initial = checked.address;
                if (apply(activity, checked.address, checked.config)) return checked.address;
            }
        }
    }

    /**
     * Makes `server` the chosen one: what happens to the downloaded game files, the sign-in choice, and the stored
     * address and metadata. False when the player went back (or applying it failed), so the list stays open.
     */
    private static boolean apply(Activity activity, String server, JSONObject config) {
        try {
            SharedPreferences prefs = ShellConfig.prefs(activity);
            // read now, not when the welcome screen opened: Local play's setup may have installed game files (SH-29)
            String assetsFrom = prefs.getString("assetServer", "");
            boolean resetPending = prefs.getBoolean("serverAssetReset", false);
            String name = ServerDirectory.reported(server, config).name;
            // Game files from another server (or of unknown origin) are replaced before playing, unless nothing of
            // that server's layers can stay behind (SH-13: GameFiles), or a server can put back what they changed
            // (SH-27: restoreFrom); then the new server's layers come on top.
            boolean differs = !assetsFrom.isEmpty() ? !ServerIdentity.same(assetsFrom, server) : resetPending;
            JSONObject assets = config.optJSONObject("assets");
            JSONObject previous = storedAssets(prefs);
            boolean candidate = differs && !resetPending && GameFiles.present(activity);
            boolean keep = candidate && GameFiles.reusable(previous, assets);
            // SH-29: from the originals kept on this phone when it can, else from a server
            boolean restoreHere = candidate && !keep && GameFiles.canRestoreLocally(activity, previous, assets);
            String restoreFrom = candidate && !keep && !restoreHere
                    ? GameFiles.restoreSource(activity, server, previous, assets) : null;
            boolean refresh = differs && !keep && !restoreHere && restoreFrom == null;
            if (refresh) {
                // SH-25: a server without the download gets the files from a game data pack after the reset
                boolean download = assets == null || assets.optBoolean("download", true);
                if (ShellDialogs.confirm(activity, "Switch to " + name + "?", download
                        ? "The game data will be downloaded again for this server, or installed from a game data pack"
                                + " file. A download is several GB, so use Wi-Fi. Your progress stays saved on each server."
                        : "The game data will be replaced for this server. It doesn't offer the game data for download,"
                                + " so you'll install it from a game data pack file (about 10 GB). Your progress stays"
                                + " saved on each server.",
                        "Switch", "Cancel") != 0) return false;
            }
            PortalSignIn.Choice choice = PortalSignIn.chooseBeforeJoin(activity, server, name,
                    config.optInt("portal", 0) == 1);
            if (choice == PortalSignIn.Choice.ANOTHER_SERVER) return false;
            // Only now, so going back to the list never leaves a refresh pending for a server not chosen.
            if (refresh) prefs.edit().putBoolean("serverAssetReset", true).apply();
            if (prefs.contains("deviceKey") && !prefs.contains("legacyDeviceOrigin")) {
                if (ShellDialogs.choose(activity, "Older guest save",
                        "This installation has sign-in information for an older guest save, but its server was not recorded. Recover that save only on its original server. Starting a new guest keeps the old recovery information on this device for later.",
                        "New guest", "Recover original guest") == 1)
                    DeviceKeys.associateLegacy(ShellConfig.keyStore(activity), server);
            }
            ShellConfig.setServer(activity, server, cdnFor(activity, server, config), config.optInt("portal", 0) == 1);
            if (restoreHere || restoreFrom != null) {
                ShellDialogs.Progress cover = ShellDialogs.progress(activity, "Updating the game files",
                        "Putting back the files the last server changed. This takes a moment.");
                boolean restored;
                try {
                    cover.set(-1, "Putting back the files the last server changed. This takes a moment.");
                    restored = restoreHere ? GameFiles.restoreLocally(activity)
                            : GameFiles.restore(activity, restoreFrom, previous.optString("base"));
                } finally {
                    cover.close();
                }
                keep = restored;
                if (!restored) {
                    prefs.edit().putBoolean("serverAssetReset", true).apply();
                    ShellDialogs.choose(activity, "Game data will be downloaded again",
                            "The game files couldn't be updated for " + name + ", so the game data will be downloaded"
                                    + " again (several GB: use Wi-Fi) or installed from a game data pack file.", "OK");
                }
            }
            if (keep) {
                if (GameFiles.relayer(activity, ShellConfig.cdn(activity))) {
                    prefs.edit().putString("assetServer", server)
                            .putString("assetInfo", assets == null ? "" : assets.toString()).apply();
                } else {
                    prefs.edit().putBoolean("serverAssetReset", true).apply();
                }
            }
            saveMetadata(activity, server, config);
            UpdateNoticeDialog.showOnce(activity, server, config); // SH-15: "update available", never blocks
            SharedPreferences.Editor done = prefs.edit().remove("chooseServer").putBoolean("playModeChosen", true);
            if (choice == PortalSignIn.Choice.GUEST) done.putString("signIn", "guest");
            done.apply();
            return true;
        } catch (Exception failure) {
            Log.w(StubContext.TAG, "server connection failed (" + failure.getClass().getSimpleName() + ")");
            return false; // keep setup available if applying the selected server failed
        }
    }

    /** The {@code assets} of the server the game files came from, as recorded; null when unknown. */
    private static JSONObject storedAssets(SharedPreferences prefs) {
        try {
            String text = prefs.getString("assetInfo", "");
            return text.isEmpty() ? null : new JSONObject(text);
        } catch (org.json.JSONException damaged) {
            return null;
        }
    }

    /** The CDN to use for `server`: the reported one, but for the local server the online one Local play recorded. */
    static String cdnFor(Activity activity, String server, JSONObject config) {
        if (reflipped.shell.service.LocalServer.isLocal(server)) {
            String local = ShellConfig.prefs(activity).getString("localCdn", "");
            if (!local.isEmpty()) return local;
        }
        return cdnOf(config);
    }

    public static void unreachable(Activity activity, String server) throws Exception {
        if (ShellDialogs.choose(activity, "Can't reach server", "Check that the server is running and your device can reach it.",
                "Retry", "Change server") != 0) ShellConfig.prefs(activity).edit().putBoolean("chooseServer", true).apply();
    }

    public static String normalize(String text) {
        return ServerIdentity.connectionAddress(text);
    }

    /**
     * Refreshes the known server's config. Returns why this app can't join it, or null: an unreachable server is left
     * to the game's own connection, which offers Retry.
     */
    private static String refreshConfig(Activity activity, String server) {
        refusedApk = null;
        try {
            JSONObject config = fetchConfig(activity, server);
            ShellConfig.setServerConfig(activity, cdnFor(activity, server, config), config.optInt("portal", 0) == 1);
            saveMetadata(activity, server, config);
            UpdateNoticeDialog.showOnce(activity, server, config); // SH-15: "update available", never blocks
        } catch (NeedsUpdate refusal) {
            Log.w(StubContext.TAG, "server needs another app version: " + refusal.getMessage());
            refusedApk = refusal.apk;
            return refusal.getMessage();
        } catch (Exception failure) {
            Log.w(StubContext.TAG, "shell config refresh failed (" + failure.getClass().getSimpleName() + ")");
        }
        return null;
    }

    private static void saveMetadata(Activity activity, String server, JSONObject config) {
        String name = config.optString("name", "Reflipped").trim();
        ShellConfig.setMetadata(activity, server, name.isEmpty() ? "Reflipped" : name, config.optString("version", ""));
        // SH-13: the layers of the current server, and of the one the game files come from while it is that server
        JSONObject assets = config.optJSONObject("assets");
        String text = assets == null ? "" : assets.toString();
        SharedPreferences prefs = ShellConfig.prefs(activity);
        SharedPreferences.Editor edit = prefs.edit().putString("serverAssets", text);
        if (ServerIdentity.same(prefs.getString("assetServer", ""), server)) edit.putString("assetInfo", text);
        edit.apply();
    }

    static JSONObject fetchConfig(Activity activity, String server) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(server + "/shell/config").openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setInstanceFollowRedirects(false);
        ShellConfig.identifyApp(activity, connection);
        try {
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new Moved();
            if (status >= 500 || status == 408 || status == 429) throw new NotReady("HTTP " + status);
            if (status != 200) throw new NotReflipped("HTTP " + status);
            JSONObject json;
            try {
                json = new JSONObject(read(connection.getInputStream()));
            } catch (org.json.JSONException notJson) {
                throw new NotReflipped("Not JSON");
            }
            if (json.optInt("reflipped", 0) != 1) throw new NotReflipped("Not a Reflipped server");
            // SH-15: servers from before the handshake send neither field and accept every app
            String refusal = AppVersion.refusal(ShellConfig.appVersion(activity), json.optInt("protocol", 0),
                    json.isNull("minAppVersion") ? "" : json.optString("minAppVersion", ""));
            if (refusal != null) throw new NeedsUpdate(refusal, AppUpdater.Apk.of(json.optJSONObject("updateApk")));
            return json;
        } finally { connection.disconnect(); }
    }

    static String cdnOf(JSONObject config) {
        String value = config.isNull("cdn") ? "" : config.optString("cdn", "").trim();
        String normalized = ServerIdentity.resourceAddress(value);
        return normalized == null ? "" : normalized;
    }

    private static String read(InputStream input) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(8);
        try {
            byte[] chunk = new byte[4096];
            for (int count; (count = input.read(chunk)) > 0;) {
                if(Thread.currentThread().isInterrupted()||System.nanoTime()>deadline)throw new IllegalStateException("Reply timeout");
                buffer.write(chunk, 0, count);
                if (buffer.size() > 65536) throw new IllegalStateException("Reply too large");
            }
            return buffer.toString("UTF-8");
        } finally { input.close(); }
    }
}
