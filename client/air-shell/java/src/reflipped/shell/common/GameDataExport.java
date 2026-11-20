package reflipped.shell.common;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.os.StatFs;
import android.provider.DocumentsContract;
import android.util.Log;

import java.io.BufferedOutputStream;
import java.io.OutputStream;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import reflipped.shell.pinball.GameFilesExport;
import reflipped.shell.pinball.GamePack;
import reflipped.shell.service.DownloadService;

/**
 * SH-29: "Export game data" on the welcome screen saves the game data this phone holds as a game data pack (format 2,
 * {@link GameFilesExport}), so another phone can install it with "Install from a file" without a computer or a server
 * download. The player picks where to save it (Android's "save as"); the export runs in the download service, so it
 * goes on in the background. A refused or stopped export deletes the half-written file.
 */
public final class GameDataExport {
    private static final String TITLE = "Export game data";

    private GameDataExport() {}

    /** Whether the welcome screen offers the export: the game has its files. */
    static boolean offered(Activity activity) {
        return GameFiles.present(activity);
    }

    /** Runs the export flow; call off the UI thread. */
    static void run(Activity activity) throws Exception {
        String lang = GameFiles.lang(activity);
        GameFilesExport.Plan plan;
        try {
            if (lang == null) throw new GamePack.Refused("The app can't tell which language these game files are in.");
            plan = GameFilesExport.plan(GameFiles.root(activity), GameFiles.downloadDir(activity), lang, false);
        } catch (GamePack.Refused refused) {
            ShellDialogs.choose(activity, TITLE, refused.getMessage(), "OK");
            return;
        }
        String size = gigabytes(plan.totalSize);
        long free = new StatFs(Environment.getExternalStorageDirectory().getPath()).getAvailableBytes();
        String space = free < plan.totalSize
                ? " This phone's storage has only " + gigabytes(free) + " GB free, so save it on a memory card or USB stick."
                : "";
        if (ShellDialogs.confirm(activity, TITLE, "Save this phone's game data (" + plan.files.size() + " files, about "
                + size + " GB) as a file, to install it on another phone with Install from a file. You choose where to"
                + " save it next." + space, "Choose where", "Cancel") != 0) return;
        Uri target = saveAs(activity, "reflipped-gamedata-" + lang + "-export.tar");
        if (target == null) return;
        String problem = export(activity, plan, target);
        if (problem != null) {
            try { DocumentsContract.deleteDocument(activity.getContentResolver(), target); }
            catch (Exception ignored) { /* nothing written, or the provider can't delete */ }
            ShellDialogs.choose(activity, TITLE, problem, "OK");
            return;
        }
        ShellDialogs.choose(activity, TITLE, "The game data is saved. On the other phone, open the Reflipped app, choose"
                + " Install from a file when it asks for the game data, and pick this file.", "OK");
    }

    /** Null when done, else what went wrong, for the player. */
    private static String export(Activity activity, GameFilesExport.Plan plan, Uri target) {
        ShellDialogs.Progress cover = ShellDialogs.progress(activity, "Exporting game data", "Starting…");
        AtomicLong done = new AtomicLong();
        AtomicBoolean closed = new AtomicBoolean();
        DownloadService.begin(activity, () -> (double) done.get() / Math.max(1, plan.totalSize), new DownloadService.Texts(
                "Exporting game data", "Exporting…", "The game data is exported."), () -> closed.set(true));
        boolean completed = false;
        try (OutputStream raw = activity.getContentResolver().openOutputStream(target, "w")) {
            if (raw == null) return "The file couldn't be created there. Choose another place.";
            OutputStream out = new BufferedOutputStream(raw, 1 << 20);
            cover.set(0, "Saving the game data. This takes a few minutes.");
            boolean finished = GameFilesExport.write(plan, out, (bytes, of) -> {
                done.set(bytes);
                cover.set((int) (bytes * 100 / Math.max(1, of)), gigabytes(bytes) + " of " + gigabytes(of) + " GB");
            }, closed::get, false);
            out.flush();
            if (!finished) return "The export stopped. Try again.";
            completed = true;
            Log.i(StubContext.TAG, "exported the game data: " + plan.files.size() + " files, " + plan.totalSize + " bytes");
            return null;
        } catch (GamePack.Refused refused) {
            return refused.getMessage();
        } catch (Exception failure) {
            Log.w(StubContext.TAG, "game data export failed", failure);
            return "The game data couldn't be exported (" + failure.getClass().getSimpleName() + "). Check the free space"
                    + " where you save it, then try again.";
        } finally {
            DownloadService.end(activity, completed);
            cover.close();
        }
    }

    private static Uri saveAs(Activity activity, String name) throws Exception {
        BlockingQueue<Object[]> result = new ArrayBlockingQueue<>(1);
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/x-tar").putExtra(Intent.EXTRA_TITLE, name);
        activity.runOnUiThread(() -> ActivityResults.start(activity, save,
                (code, data) -> result.offer(new Object[]{code, data})));
        Object[] answer = result.take();
        int code = (Integer) answer[0];
        Intent data = (Intent) answer[1];
        if (code == ActivityResults.NOT_STARTED) {
            ShellDialogs.choose(activity, TITLE, "There is no app on this phone to save files with.", "OK");
            return null;
        }
        return code == Activity.RESULT_OK && data != null ? data.getData() : null;
    }

    private static String gigabytes(long bytes) {
        return String.format(java.util.Locale.ROOT, "%.1f", bytes / 1e9);
    }
}
