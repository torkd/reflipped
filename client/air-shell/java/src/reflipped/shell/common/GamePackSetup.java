package reflipped.shell.common;

import android.app.Activity;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.StatFs;
import android.util.Log;

import org.json.JSONObject;

import android.os.ParcelFileDescriptor;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import reflipped.shell.pinball.CdnCopy;
import reflipped.shell.pinball.GamePack;
import reflipped.shell.service.DownloadService;

/**
 * SH-25: before the game starts without its files, the app offers to install them from a game data pack instead of
 * downloading them, on every server. A server that doesn't hand out the base files ({@code /shell/config}
 * {@code assets.download} false, e.g. one without a CDN) offers only the pack, or another server. After the install
 * the game's next asset check takes just this server's layers (schedule, translation, mods). See
 * docs/game-data-pack.md. The file can also be a plain .tar or a .zip of a server's {@code .cdn} folder (SH-29,
 * {@link CdnCopy}): the app then installs the official files of one language from it, checked against the lists it
 * carries.
 */
public final class GamePackSetup {
    private static final String TITLE = "Game data";
    /** The official archive lists the build ships (build.py, write_game_data_lists). */
    private static final String LISTS = "gamedata-lists";
    private static final String[] LANGUAGES = {"en", "ko", "th"};
    private static final java.util.Map<String, String> LANGUAGE_NAMES = new java.util.HashMap<>();
    static {
        LANGUAGE_NAMES.put("en", "English");
        LANGUAGE_NAMES.put("ko", "Korean");
        LANGUAGE_NAMES.put("th", "Thai");
    }
    /** Room beyond the archives' size: the files extracted from them are a little larger, and the game needs some. */
    private static final long SPARE_BYTES = 1L << 30;

    private GamePackSetup() {}

    /**
     * Called on a background thread once the server is chosen and answers, before the game looks at its files. Returns
     * false when the player wants another server.
     */
    public static boolean offerIfMissing(Activity activity, String server) throws Exception {
        SharedPreferences prefs = ShellConfig.prefs(activity);
        // the game deletes its files first when a reset is pending, and then starts over: offer it after that
        if (GameFiles.present(activity) || prefs.getBoolean("serverAssetReset", false)) return true;
        // Local play downloads through the online server's CDN it recorded at setup, though the phone's server has none
        boolean download = serverAssets(prefs).optBoolean("download", true)
                || (reflipped.shell.service.LocalServer.isLocal(server) && !prefs.getString("localCdn", "").isEmpty());
        String name = ShellConfig.serverName(activity);
        while (true) {
            int choice;
            if (download) {
                choice = ShellDialogs.chooseRowWithBack(activity, TITLE,
                        "The game needs its game data, about 10 GB. Download it from " + name + " (use Wi-Fi), or"
                                + " install it from a file you already have: a game data pack, or a .tar or .zip of a"
                                + " server's game data folder.",
                        0, "Download", "Install from a file");
                if (choice == 0) return true;
            } else {
                choice = ShellDialogs.chooseRowWithBack(activity, TITLE,
                        name + " doesn't offer the game data for download. Install it from a file: a game data"
                                + " pack (about 10 GB) or a .tar or .zip of a server's game data folder (ask the"
                                + " server's owner where to get one), or choose another server.",
                        1, "Install from a file", "Change server");
                if (choice == 1) {
                    prefs.edit().putBoolean("chooseServer", true).apply();
                    return false;
                }
            }
            Uri file = LocalPlaySetup.pickFile(activity, TITLE);
            if (file == null) continue;
            String problem = install(activity, server, file);
            if (problem == null) return true;
            ShellDialogs.choose(activity, TITLE, problem, "OK");
        }
    }

    /**
     * Installs the pack, or the copy of the {@code .cdn} folder (SH-29), in {@code file}; null when done, else what
     * went wrong, for the player.
     */
    private static String install(Activity activity, String server, Uri file) {
        ShellDialogs.Progress cover = ShellDialogs.progress(activity, "Installing game data", "Checking the file…");
        AtomicLong done = new AtomicLong();
        AtomicLong total = new AtomicLong(1);
        java.util.concurrent.atomic.AtomicBoolean closed = new java.util.concurrent.atomic.AtomicBoolean();
        boolean started = false;
        ParcelFileDescriptor descriptor = null;
        try {
            try {
                descriptor = activity.getContentResolver().openFileDescriptor(file, "r");
            } catch (Exception streamOnly) {
                Log.w(StubContext.TAG, "game data file has no file descriptor", streamOnly);
            }
            if (descriptor == null) return "The file can't be read where it is stored. Copy it to the phone (for"
                    + " example into Downloads), then pick it again.";
            FileChannel channel = new FileInputStream(descriptor.getFileDescriptor()).getChannel();
            CdnCopy copy = CdnCopy.open(channel);
            GamePack pack = null;
            GamePack.Manifest manifest;
            if (copy.isPack()) {
                channel.position(0);
                pack = new GamePack(new BufferedInputStream(Channels.newInputStream(channel), 1 << 20));
                manifest = pack.manifest();
            } else {
                manifest = chooseLanguage(activity, copy);
            }
            total.set(Math.max(1, manifest.totalSize));
            long free = new StatFs(activity.getApplicationInfo().dataDir).getAvailableBytes();
            if (free < manifest.totalSize + SPARE_BYTES)
                return "Not enough free space: the game data needs about " + gigabytes(manifest.totalSize + SPARE_BYTES)
                        + " GB, and the phone has " + gigabytes(free) + " GB free.";
            // the install goes on with the app in the background, like a download (SH-7)
            DownloadService.begin(activity, () -> (double) done.get() / total.get(), new DownloadService.Texts(
                    "Installing game data", "Installing…", "The game data is installed."), () -> closed.set(true));
            started = true;
            cover.set(0, "Installing the game data from the file. This takes a few minutes.");
            GamePack.Progress progress = (bytes, of) -> {
                done.set(bytes);
                int percent = (int) (bytes * 100 / Math.max(1, of));
                cover.set(percent, gigabytes(bytes) + " of " + gigabytes(of) + " GB");
            };
            File target = GameFiles.downloadDir(activity);
            boolean complete = pack != null ? pack.install(target, progress, closed::get)
                    : copy.install(manifest, target, progress, closed::get);
            if (!complete) return "The installation stopped. Try again.";
            GameFiles.installedFromPack(activity, manifest.lang, manifest.totalSize, ShellConfig.cdn(activity));
            // the files now hold the base set, and the game takes this server's layers on top
            prefs(activity).edit().putString("assetServer", server)
                    .putString("assetInfo", prefs(activity).getString("serverAssets", "")).apply();
            DownloadService.end(activity, true);
            started = false;
            return null;
        } catch (GamePack.Refused refused) {
            return refused.getMessage();
        } catch (Exception failure) {
            Log.w(StubContext.TAG, "game data install failed", failure);
            return "The game data couldn't be installed (" + failure.getClass().getSimpleName() + "). Check the free"
                    + " space and the file, then try again.";
        } finally {
            if (started) DownloadService.end(activity, false);
            cover.close();
            if (descriptor != null) try { descriptor.close(); } catch (java.io.IOException ignored) { }
        }
    }

    /**
     * A copy of the {@code .cdn} folder: the language whose official files it holds in full (the player picks when it
     * holds several). Refused when it holds none in full.
     */
    private static GamePack.Manifest chooseLanguage(Activity activity, CdnCopy copy)
            throws Exception {
        List<GamePack.Manifest> complete = new ArrayList<>();
        GamePack.Manifest closest = null;
        int closestMissing = Integer.MAX_VALUE;
        for (String lang : LANGUAGES) {
            GamePack.Manifest list;
            try (InputStream in = activity.getAssets().open(LISTS + "/" + lang + ".tsv")) {
                list = GamePack.officialList(lang, in);
            }
            int missing = copy.missing(list);
            if (missing == 0) complete.add(list);
            else if (missing < list.archives.size() && missing < closestMissing) {
                closest = list;
                closestMissing = missing;
            }
        }
        if (complete.isEmpty() && closest != null)
            throw new GamePack.Refused("This copy of the game data is incomplete: " + closestMissing + " of the "
                    + closest.archives.size() + " " + LANGUAGE_NAMES.get(closest.lang) + " Android files are missing or"
                    + " cut short (" + copy.firstMissing(closest) + " first). Copy the folder again.");
        if (complete.isEmpty())
            throw new GamePack.Refused("This file holds no game data for Android: neither a game data pack nor a copy"
                    + " of the game data folder (.cdn, with its en, ko or th folders).");
        if (complete.size() == 1) return complete.get(0);
        String[] names = new String[complete.size()];
        for (int i = 0; i < names.length; i++) names[i] = LANGUAGE_NAMES.get(complete.get(i).lang);
        int choice = ShellDialogs.chooseRow(activity, TITLE, "This copy holds the game data in several languages."
                + " Which one should the app install? Pick the one your server uses (most use English).", null, names);
        return complete.get(choice);
    }

    private static SharedPreferences prefs(Activity activity) {
        return ShellConfig.prefs(activity);
    }

    /** The current server's {@code assets}, as saveMetadata recorded it; empty for a server from before it. */
    private static JSONObject serverAssets(SharedPreferences prefs) {
        try {
            String text = prefs.getString("serverAssets", "");
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } catch (org.json.JSONException damaged) {
            return new JSONObject();
        }
    }

    private static String gigabytes(long bytes) {
        return String.format(java.util.Locale.ROOT, "%.1f", bytes / 1e9);
    }
}
