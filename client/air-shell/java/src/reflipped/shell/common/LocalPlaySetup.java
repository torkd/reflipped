package reflipped.shell.common;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

import reflipped.shell.service.LocalDataPack;
import reflipped.shell.service.LocalServer;

/**
 * "Local play" on the welcome screen (SH-13 step 5): sets up the server on this phone and returns its address.
 *
 * <ul>
 * <li>The server data pack (the game's tables the server reads, about 7 MB; {@link LocalDataPack}): SH-29, built
 * from the game files on the phone when they hold the official ones, without asking. Otherwise downloaded from an
 * online Reflipped server that offers it, or installed from a file the player picks: a saved data pack zip, or the
 * game data itself (a game data pack or a copy of a server's {@code .cdn} folder, {@link GamePackSetup#install}),
 * which installs the game files and then builds the pack from them. An app update whose server needs another pack
 * builds it again, or gets it from the same server ({@link #refreshPack}).</li>
 * <li>The game files (about 9 GB): already on the phone, or downloaded by the game from an online server's CDN, since
 * the local server has none, recorded as {@code localCdn} (the server the pack came from, else the server the player
 * played on, else one the player names). Files already on the phone stay when {@link GameFiles#reusable} allows
 * it.</li>
 * <li>Android 13+: asks to show notifications, so the server's "running" notification is visible.</li>
 * </ul>
 * Prefs: {@code localSource} (the online server for the pack and the game files), {@code localCdn}.
 */
public final class LocalPlaySetup {
    private static final String TITLE = "Local play";

    private LocalPlaySetup() {}

    /** Sets up Local play; returns the local server's address once it answers, or null when the player went back. */
    public static String run(Activity activity) throws Exception {
        if (!LocalDataPack.ready(activity)) {
            String refused = fromGameFiles(activity);
            if (refused != null && !getPack(activity, refused)) return null;
        }
        // game files on the phone need no server to download them from
        if (!GameFiles.present(activity) && ShellConfig.prefs(activity).getString("localCdn", "").isEmpty()
                && !chooseFilesSource(activity)) return null;
        askNotifications(activity);
        ShellDialogs.busy(activity, "Starting the server on this phone…");
        try {
            LocalServer.ensureRunning(activity, true); // the player's choice: a fresh start
        } catch (LocalServer.Failed failed) {
            ShellDialogs.endBusy(activity);
            ShellDialogs.choose(activity, "The server on this phone didn't start", failed.getMessage(), "OK");
            return null;
        }
        ShellDialogs.endBusy(activity);
        return LocalServer.ADDRESS;
    }

    /**
     * Before the local server starts: when an app update needs another data pack, builds it from the game files, else
     * gets it from the server the last one came from, with a progress cover. False when that isn't possible (the start
     * then explains what's missing).
     */
    public static boolean refreshPack(Activity activity) {
        if (LocalDataPack.ready(activity)) return true;
        try {
            if (fromGameFiles(activity) == null) return true;
        } catch (Exception failed) {
            Log.w(StubContext.TAG, "couldn't build the data pack from the game files: " + failed);
        }
        String source = ShellConfig.prefs(activity).getString("localSource", "");
        if (source.isEmpty()) return false;
        try {
            download(activity, source, "Updating the game data for Local play");
            return true;
        } catch (Exception failed) {
            Log.w(StubContext.TAG, "couldn't update the data pack from " + source + ": " + failed.getMessage());
            return false;
        }
    }

    /**
     * SH-29: builds the pack from the game files on this phone. Null when it is installed; otherwise why not (empty
     * when there are no game files, or this app can't build a pack), for the player.
     */
    private static String fromGameFiles(Activity activity) throws Exception {
        if (!GameFiles.present(activity) || !LocalDataPack.canBuild(activity)) return "";
        ShellDialogs.Progress progress = ShellDialogs.progress(activity, "Preparing Local play",
                "Reading the data tables from the game files…");
        try {
            LocalDataPack.buildFromGameFiles(activity, GameFiles.baseFiles(activity),
                    (done, total) -> progress.set(-1, megabytes(done) + " MB"));
            return null;
        } catch (LocalDataPack.Problem problem) {
            Log.i(StubContext.TAG, "no data pack from the game files: " + problem.getMessage());
            return problem.getMessage();
        } catch (java.io.IOException failed) {
            Log.w(StubContext.TAG, "data pack from the game files failed", failed);
            return "The data tables couldn't be read from the game files on this phone (" + failed.getMessage() + ").";
        } finally {
            progress.close();
        }
    }

    /**
     * Asks where the pack comes from until it is installed (true) or the player goes back (false). {@code refused}
     * says why the game files on the phone couldn't give it (empty when there are none).
     */
    private static boolean getPack(Activity activity, String refused) throws Exception {
        while (true) {
            int choice = ShellDialogs.chooseRowWithBack(activity, TITLE,
                    "To play on this phone, the Reflipped server here needs the game's data tables (about 7 MB), once."
                            + " Get them from an online Reflipped server that offers them, or from a file: the data"
                            + " tables saved from a server, or the game data itself (a game data pack, or a .tar or"
                            + " .zip of a server's game data folder), which also installs the game files."
                            + (refused.isEmpty() ? "" : "\n\nThe game files on this phone can't give them: " + refused),
                    2, "From a server", "From a file", "Back");
            if (choice == 2) return false;
            try {
                if (choice == 0) {
                    String source = pickServer(activity, "Choose the online Reflipped server to get the game data from."
                            + " It also gives the game files, if this phone doesn't have them yet.");
                    if (source == null) continue;
                    download(activity, source, "Getting the game data for Local play");
                    JSONObject config = ServerSetup.fetchConfig(activity, source);
                    SharedPreferences.Editor edit = ShellConfig.prefs(activity).edit().putString("localSource", source);
                    edit.putString("localCdn", cdnFor(source, config)).apply();
                    return true;
                }
                Uri picked = pickFile(activity);
                if (picked == null) continue;
                if (!isDataPack(activity, picked)) {
                    // SH-29: the game data itself: install the game files, then make the tables from them
                    if (GameFiles.present(activity)) {
                        ShellDialogs.choose(activity, TITLE, "This file is the game data itself, and this phone has"
                                + " game files already. Get the data tables from a server or a saved file instead.",
                                "OK");
                        continue;
                    }
                    String problem = GamePackSetup.install(activity, LocalServer.ADDRESS, localCdn(activity), picked);
                    if (problem != null) {
                        ShellDialogs.choose(activity, TITLE, problem, "OK");
                        continue;
                    }
                    refused = fromGameFiles(activity);
                    if (refused == null) return true;
                    ShellDialogs.choose(activity, TITLE, "The game files are installed, but the data tables couldn't be"
                            + " made from them: " + refused, "OK");
                    continue;
                }
                ShellDialogs.Progress progress = ShellDialogs.progress(activity, "Installing the game data", "");
                try {
                    InputStream in = activity.getContentResolver().openInputStream(picked);
                    if (in == null) throw new LocalDataPack.Problem("This file can't be read.");
                    LocalDataPack.installFile(activity, in, (done, total) ->
                            progress.set(total > 0 ? (int) (done * 100 / total) : -1, megabytes(done) + " MB"));
                } finally {
                    progress.close();
                }
                return true;
            } catch (LocalDataPack.Problem problem) {
                ShellDialogs.choose(activity, TITLE, problem.getMessage(), "OK");
            } catch (java.io.IOException failed) {
                Log.w(StubContext.TAG, "data pack: " + failed);
                ShellDialogs.choose(activity, TITLE, "The game data couldn't be loaded. Check the connection and try"
                        + " again.", "OK");
            }
        }
    }

    /**
     * Where the game downloads its files while on Local play: the server the player played on, or one they name.
     * True once recorded.
     */
    private static boolean chooseFilesSource(Activity activity) throws Exception {
        String current = ShellConfig.server(activity);
        if (!current.isEmpty() && !LocalServer.isLocal(current)) {
            ShellConfig.prefs(activity).edit().putString("localSource", current)
                    .putString("localCdn", ShellConfig.cdn(activity)).apply();
            return true;
        }
        String source = pickServer(activity, "Local play downloads the game files (about 9 GB) from an online"
                + " Reflipped server, once. Choose the server to download them from.");
        if (source == null) return false;
        JSONObject config = ServerSetup.fetchConfig(activity, source);
        ShellConfig.prefs(activity).edit().putString("localSource", source)
                .putString("localCdn", cdnFor(source, config)).apply();
        return true;
    }

    /**
     * Whether the picked file is a server data pack zip (else it may be the game data: a game data pack or a copy of
     * the {@code .cdn} folder). A file that can't be read counts as a pack, whose install then says so.
     */
    private static boolean isDataPack(Activity activity, Uri file) {
        try {
            InputStream in = activity.getContentResolver().openInputStream(file);
            return in == null || LocalDataPack.looksLikePack(in);
        } catch (Exception unreadable) {
            return true;
        }
    }

    /**
     * The CDN recorded for game files installed for the server on this phone, which has none: the online one Local
     * play downloads from, else the address the app would use for the local server (CdnSelection).
     */
    private static String localCdn(Activity activity) {
        String cdn = ShellConfig.prefs(activity).getString("localCdn", "");
        return cdn.isEmpty() ? LocalServer.ADDRESS.replaceAll("/+$", "") + "/patch/Live/2.0.0" : cdn;
    }

    /** The CDN a server reports, else its own /patch, as the app would use while playing there (CdnSelection). */
    static String cdnFor(String server, JSONObject config) {
        String reported = ServerSetup.cdnOf(config);
        return reported.isEmpty() ? server.replaceAll("/+$", "") + "/patch/Live/2.0.0" : reported;
    }

    private static void download(Activity activity, String source, String title) throws Exception {
        ShellDialogs.Progress progress = ShellDialogs.progress(activity, title, "Connecting…");
        try {
            LocalDataPack.download(activity, source, (done, total) -> progress.set(
                    total > 0 ? (int) (done * 100 / total) : -1, megabytes(done) + " MB"));
        } finally {
            progress.close();
        }
    }

    /** A checked server: its address with its /shell/config. */
    private static final class Picked {
        final String address;
        final JSONObject config;
        Picked(String address, JSONObject config) { this.address = address; this.config = config; }
    }

    /** An online server from the server list (the local one is refused), or null on Back. */
    private static String pickServer(Activity activity, String why) throws Exception {
        if (ShellDialogs.choose(activity, TITLE, why, "Choose a server", "Back") != 0) return null;
        Picked picked = ShellDialogs.address(activity, "", new ShellDialogs.AddressChecker<Picked>() {
            public Picked check(String typed) throws Exception {
                String address = ServerSetup.normalize(typed);
                if (address == null) throw new IllegalArgumentException("Invalid server address");
                if (LocalServer.isLocal(address)) throw new ServerSetup.NotReflipped("The server on this phone");
                return new Picked(address, ServerSetup.fetchConfig(activity, address));
            }
            public ServerDirectory.Entry entry(Picked result) {
                return ServerDirectory.reported(result.address, result.config);
            }
        }, new ServerBrowser.Memory().onlineOnly());
        return picked == null ? null : picked.address;
    }

    /** A file from the system picker, or null when the player cancelled (also used by GamePackSetup). */
    static Uri pickFile(Activity activity) throws Exception {
        return pickFile(activity, TITLE);
    }

    static Uri pickFile(Activity activity, String title) throws Exception {
        BlockingQueue<Object[]> result = new ArrayBlockingQueue<>(1);
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        activity.runOnUiThread(() -> ActivityResults.start(activity, intent,
                (code, data) -> result.offer(new Object[]{code, data})));
        Object[] answer = result.take();
        int code = (Integer) answer[0];
        Intent data = (Intent) answer[1];
        if (code == ActivityResults.NOT_STARTED) {
            ShellDialogs.choose(activity, title, "There is no app on this phone to choose files with.", "OK");
            return null;
        }
        return code == Activity.RESULT_OK && data != null ? data.getData() : null;
    }

    /** Android 13+: the server's notification shows only with this permission. A refusal changes nothing else. */
    private static void askNotifications(Activity activity) throws InterruptedException {
        BlockingQueue<Integer> result = new ArrayBlockingQueue<>(1);
        activity.runOnUiThread(() -> ActivityResults.requestPermission(activity,
                "android.permission.POST_NOTIFICATIONS", 33, (code, data) -> result.offer(code)));
        result.take();
    }

    private static String megabytes(long bytes) {
        return String.format(java.util.Locale.ROOT, "%.1f", bytes / 1048576.0);
    }
}
