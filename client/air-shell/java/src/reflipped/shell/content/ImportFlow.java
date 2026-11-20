package reflipped.shell.content;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ColorSpace;
import android.net.Uri;
import android.os.Build;
import android.os.StatFs;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

import reflipped.shell.common.ActivityResults;
import reflipped.shell.common.AppRestart;
import reflipped.shell.common.StubContext;

/**
 * What happens between the loader asking for the game and the game running: nothing at all when the imported files
 * are ready; a short "Updating the game files" screen after an app update changed the op list (or "Repairing" after
 * the loader found the patched SWF damaged); otherwise the first-launch screens that import the game from the
 * installed game app or from an APK file. Runs on its own thread and ends by sending "ready" to the loader.
 *
 * Android may destroy the game's activity and create a new one while the flow runs (low memory, "Don't keep
 * activities"), most likely while the file picker is open. AIR keeps running in the same process and doesn't start the
 * loader again, so the flow carries on: the picker's result reaches it through the recreated fragment
 * (ActivityResults), and its screens move to the new activity (a question that was showing is shown again).
 *
 * One flow at a time, the newest wins: a prepare call while a flow runs interrupts the old flow, waits for it to end
 * and starts again with the new caller's context. Only the newest flow sends "ready", and a flow that has sent it no
 * longer counts as running, so the loader's next call (a damaged file) is never dropped.
 */
final class ImportFlow {
    private static final String TAG = StubContext.TAG;
    private static final long SPACE_MARGIN = 32L * 1024 * 1024;
    /** How long a new flow waits for an interrupted one to end (an import in progress finishes first) */
    private static final long SUPERSEDE_WAIT_MS = 60000;

    private static final Object LOCK = new Object();
    private static Thread running;
    private static int generation;
    private static ImportManifest manifest;
    private static byte[] opsFile;
    private static ImportScreens screens;
    private static int damaged;
    private static long readyAt;

    private final StubContext ctx;
    private final Activity firstActivity;
    private final int id;
    private GameFiles files;
    private OpPatch ops;

    private ImportFlow(StubContext ctx, int id) {
        this.ctx = ctx;
        this.firstActivity = ctx.getActivity();
        this.id = id;
    }

    /**
     * The game's current activity. Android may destroy it and create a new one while this flow runs (while the file
     * picker is open, for one); AIR keeps running in the same process and hands its contexts the new one.
     */
    private Activity activity() {
        Activity current = null;
        try {
            current = ctx.getActivity();
        } catch (RuntimeException ignored) {
            // the context is gone
        }
        return current != null ? current : firstActivity;
    }

    static void start(StubContext ctx, String storage, String reason) {
        synchronized (LOCK) {
            Thread previous = running;
            int id = ++generation;
            if (previous != null && previous.isAlive()) {
                Log.w(TAG, "import: prepare while another flow runs: that one stops, this one starts");
                previous.interrupt();
            }
            if (screens != null) screens.close();  // they may belong to an activity that is gone
            screens = null;
            running = new Thread(() -> {
                if (previous != null) {
                    try {
                        previous.join(SUPERSEDE_WAIT_MS);
                    } catch (InterruptedException e) {
                        return;  // superseded in turn
                    }
                }
                new ImportFlow(ctx, id).run(storage, reason == null ? "start" : reason);
            }, "reflipped-import");
            running.start();
        }
    }

    /** The game SWF is running: the import screens can go. */
    static void started() {
        if (readyAt > 0) Log.i(TAG, "import: game loaded " + (System.currentTimeMillis() - readyAt) + " ms after ready");
        synchronized (LOCK) {
            if (screens != null) screens.close();
            screens = null;
        }
    }

    static synchronized ImportManifest manifest(Activity activity) throws IOException {
        if (manifest == null) {
            try (InputStream in = activity.getAssets().open(ImportManifest.ASSET_DIR + "/" + ImportManifest.FILE)) {
                manifest = ImportManifest.read(in);
            }
        }
        return manifest;
    }

    private static synchronized byte[] opsFile(Activity activity, ImportManifest m) throws IOException {
        if (opsFile == null) {
            try (InputStream in = activity.getAssets().open(ImportManifest.ASSET_DIR + "/" + m.opsName)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
                byte[] data = out.toByteArray();
                if (!Hashes.hex(Hashes.sha256(data)).equals(m.opsSha256)) throw new IOException("op list hash mismatch");
                opsFile = data;
            }
        }
        return opsFile;
    }

    private ImportScreens screens() throws InterruptedException {
        synchronized (LOCK) {
            if (id != generation) throw new InterruptedException("superseded");
            return liveScreens();
        }
    }

    /** The screens, on the current activity: a new window if Android recreated the activity. */
    private ImportScreens liveScreens() {
        synchronized (LOCK) {
            Activity current = activity();
            if (screens != null && (screens.stale() || !screens.belongsTo(current))) {
                screens.close();
                screens = null;
            }
            if (screens == null) screens = new ImportScreens(current);
            return screens;
        }
    }

    // ---------------------------------------------------------------- the flow

    private void run(String storage, String reason) {
        try {
            runFlow(storage, reason);
        } catch (InterruptedException e) {
            Log.i(TAG, "import: flow " + id + " stopped (a newer one took over)");
        }
    }

    private void runFlow(String storage, String reason) throws InterruptedException {
        long t0 = System.currentTimeMillis();
        try {
            ImportManifest m = manifest(activity());
            ops = new OpPatch(opsFile(activity(), m));
            if (!Hashes.hex(ops.outputSha256).equals(m.outputSha256) || ops.outputSize != m.outputSize) {
                throw new IOException("op list and manifest disagree");
            }
            files = new GameFiles(new File(storage), m);
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "import: this build's import files are unusable (" + e.getMessage() + ")");
            ask("This app is incomplete", "This build of the Reflipped app is missing the files it needs to set up "
                    + "the game. Install a complete build of the app.", null, true, -1, "Close the app");
            AppRestart.close(activity());
            return;
        }
        try {
            boolean repair = !"start".equals(reason);
            if (repair) {
                damaged++;
                Log.w(TAG, "import: the loader reported the game SWF " + reason + " (" + damaged + ")");
                files.invalidate();
                if (damaged >= 2) {
                    ask("The game files are damaged", "Reflipped's copy of the game on this phone doesn't pass its "
                            + "check, so it won't be started. Set the game up again from the original game app or "
                            + "its APK file.", null, true, -1, "Set up again");
                    files.clear();
                    damaged = 0;
                }
            }
            GameFiles.State state = files.state();
            Log.i(TAG, "import: state " + state + " (" + (System.currentTimeMillis() - t0) + " ms)");
            if (state == GameFiles.State.READY) {
                // an import from before the title logo got its REFLIPPED line (or one interrupted while adding it)
                if (new BundleLogo(files).pending(false)) {
                    addLogo(false, "Updating the game files", "Reflipped was updated, so it prepares its copy of "
                            + "the game again. This takes a few seconds.");
                }
                ready();
            } else if (state == GameFiles.State.REPATCH) {
                repatch(repair);
            } else {
                importGame(null);
            }
        } catch (RuntimeException e) {
            // never leave the loader waiting on a black screen
            Log.e(TAG, "import: unexpected " + e.getClass().getSimpleName() + " " + e.getMessage());
            if (ask("The game couldn't be started", "Something went wrong while Reflipped was getting the game "
                    + "ready. Try again. If it keeps happening, close the app and open it again.", null, true, -1,
                    "Try again", "Close the app") == 0) {
                runFlow(storage, "start");
            } else {
                AppRestart.close(activity());
            }
        }
    }

    /** Patches the kept original again: after an app update changed the op list, or to repair a damaged game.swf. */
    private void repatch(boolean repair) throws InterruptedException {
        String title = repair ? "Repairing the game files" : "Updating the game files";
        String body = repair
                ? "Reflipped's copy of the game didn't pass its check, so Reflipped prepares it again. This takes a "
                        + "few seconds."
                : "Reflipped was updated, so it prepares its copy of the game again. This takes a few seconds.";
        while (true) {
            screens().progress(title, body, "Preparing the game for Reflipped…", -1);
            long t0 = System.currentTimeMillis();
            try {
                files.repatch(ops, repair ? "repair" : "update");
                Log.i(TAG, "import: re-patched in " + (System.currentTimeMillis() - t0) + " ms");
                addLogo(true, null, null);
                ready();
                return;
            } catch (OpPatch.Mismatch e) {
                Log.w(TAG, "import: re-patch failed (" + e.getMessage() + ")");
                files.clear();
                importGame(repair
                        ? "Reflipped's copy of the game is damaged. It needs the original game app once more to set "
                                + "the game up again."
                        : "Reflipped was updated and needs the original game app once more to update its copy of "
                                + "the game.");
                return;
            } catch (OutOfMemoryError e) {
                Log.w(TAG, "import: re-patch ran out of memory (max " + maxMemoryMb() + " MB)");
                if (ask("Not enough memory", outOfMemoryText(), null, true, 0, "Try again", "Close the app") == 1) {
                    AppRestart.close(activity());
                    return;
                }
            } catch (IOException e) {
                Log.w(TAG, "import: re-patch failed (" + e.getClass().getSimpleName() + ")");
                int choice = ask("The game files couldn't be " + (repair ? "repaired" : "updated"), "Reflipped "
                        + "couldn't write its copy of the game. Check that the phone has some free space, then try "
                        + "again.", null, true, 0, "Try again", "Set up the game again");
                if (choice == 1) {
                    files.clear();
                    importGame(null);
                    return;
                }
            }
        }
    }

    private static String outOfMemoryText() {
        return "The phone ran out of memory while Reflipped was preparing the game. Close other apps, then try again.";
    }

    private static long maxMemoryMb() {
        return Runtime.getRuntime().maxMemory() / 1048576;
    }

    private static final int WELCOME = 0, PICK = 1, RUN = 2;

    /** The installed game app, if Android lets us see it (it does through the manifest's queries element). */
    private static final class Installed {
        final String version;
        final List<File> apks = new ArrayList<>();

        Installed(PackageInfo info) {
            version = info.versionName == null ? "?" : info.versionName;
            apks.add(new File(info.applicationInfo.sourceDir));
            if (info.applicationInfo.splitSourceDirs != null) {
                for (String split : info.applicationInfo.splitSourceDirs) apks.add(new File(split));
            }
        }
    }

    private Installed installed() {
        try {
            return new Installed(activity().getPackageManager().getPackageInfo(files.manifest.gamePackage, 0));
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            return null;
        }
    }

    private void importGame(String note) throws InterruptedException {
        String version = files.manifest.gameVersion;
        int next = WELCOME;
        Installed app = null;
        Uri file = null;
        while (true) {
            if (next == WELCOME) {
                app = installed();
                String body = "Reflipped plays the game with your own copy of it. Once, it needs the original game "
                        + "app, version " + version + ": it copies the game from it and keeps it in Reflipped. "
                        + "Nothing is downloaded or sent anywhere, and afterwards Reflipped doesn't need the original "
                        + "app or its file any more.";
                String found;
                String[] buttons;
                if (app != null && version.equals(app.version)) {
                    found = "Found on this phone: the original game app, version " + version + ".";
                    buttons = new String[] {"Use the installed game", "Choose an APK file instead"};
                } else if (app != null) {
                    found = "Found on this phone: the original game app, version " + app.version + ". Reflipped "
                            + "needs version " + version + ": choose the APK file of that version.";
                    buttons = new String[] {"Choose an APK file", "Try the installed game anyway"};
                } else {
                    found = "The original game app isn't installed on this phone. Choose its APK file, version "
                            + version + ", for example the one you downloaded.";
                    buttons = new String[] {"Choose the APK file"};
                }
                int choice = ask("Set up the game", body + "\n\n" + found, note, note != null, -1, buttons);
                boolean useInstalled = app != null && (version.equals(app.version) ? choice == 0 : choice == 1);
                if (useInstalled) {
                    file = null;
                    next = RUN;
                } else {
                    next = PICK;
                }
                note = null;
            } else if (next == PICK) {
                Object picked = pick();
                app = null;
                if (picked instanceof Uri) {
                    file = (Uri) picked;
                    next = RUN;
                } else {
                    if (picked == NO_PICKER) {
                        ask("No app to choose files", "This phone has no app that lets Reflipped choose a file. "
                                + "Install the original game app instead, or a file manager app, then try again.",
                                null, true, 0, "Back");
                    }
                    next = WELCOME;
                }
            } else {
                if (!enoughSpace()) continue;
                GameImporter.Failure failure = runImport(app, file);
                if (failure == null) {
                    addLogo(true, null, null);
                    ready();
                    return;
                }
                next = problem(failure, app != null);
            }
        }
    }

    private boolean enoughSpace() throws InterruptedException {
        ImportManifest m = files.manifest;
        long bundle = m.importBytes() - m.entry(m.swfEntry).size;  // the game unpacks the bundle once more
        long needed = m.importBytes() + m.outputSize + bundle + SPACE_MARGIN;
        long free;
        try {
            free = new StatFs(files.storage.getPath()).getAvailableBytes();
        } catch (RuntimeException e) {
            return true;  // can't tell: try, and report a failed write if it comes to that
        }
        if (free >= needed) return true;
        Log.w(TAG, "import: " + free / 1048576 + " MB free, " + needed / 1048576 + " MB needed");
        int choice = ask("Not enough free space", "Setting up the game needs about " + mb(needed) + " of free space "
                + "on this phone, and " + mb(free) + " is free. Free up some space, then try again. (After that, the "
                + "game downloads about 10 GB of its data.)", null, true, -1, "Try again", "Close the app");
        if (choice == 1) AppRestart.close(activity());
        return false;
    }

    private static String mb(long bytes) {
        return String.format(Locale.ROOT, "%d MB", (bytes + 1048575) / 1048576);
    }

    private GameImporter.Failure runImport(Installed app, Uri file) throws InterruptedException {
        String title = "Setting up the game";
        String body = "Reflipped copies the game from " + (app != null ? "the installed game app" : "the file you chose")
                + " and prepares it. This takes a few seconds.";
        screens();  // stops here if a newer flow took over
        long[] times = {System.currentTimeMillis(), 0, 0};
        int[] shown = {-1};
        GameImporter importer = new GameImporter(files, ops, new GameImporter.Progress() {
            @Override
            public void reading(long done, long total) {
                int percent = total > 0 ? (int) (done * 100 / total) : 0;
                if (percent == shown[0]) return;
                shown[0] = percent;
                liveScreens().progress(title, body, "Copying the game… " + percent + " %", percent);
            }

            @Override
            public void patching() {
                times[1] = System.currentTimeMillis();
                liveScreens().progress(title, body, "Preparing the game for Reflipped…", -1);
            }

            @Override
            public void saving() {
                times[2] = System.currentTimeMillis();
                liveScreens().progress(title, body, "Saving…", -1);
            }
        });
        liveScreens().progress(title, body, "Opening " + (app != null ? "the game app…" : "the file…"), -1);
        Log.i(TAG, "import: from " + (app != null ? "the installed app" : "a file") + ", Java heap limit "
                + maxMemoryMb() + " MB");
        try {
            if (app != null) {
                importer.fromApkFiles(app.apks, "installed");
            } else {
                importer.fromPickedFile(() -> activity().getContentResolver().openInputStream(file),
                        new File(activity().getCacheDir(), "reflipped-import.apk"), "file");
            }
            long end = System.currentTimeMillis();
            Log.i(TAG, "import: done from " + (app != null ? "the installed app"
                    : importer.readFromCopy ? "a file (read from a copy)" : "a file") + " in " + (end - times[0])
                    + " ms (copy " + (times[1] - times[0]) + ", patch " + (times[2] - times[1]) + ", save "
                    + (end - times[2]) + ")");
            return null;
        } catch (GameImporter.Failure failure) {
            Log.w(TAG, "import: failed, " + failure.getMessage());
            return failure;
        }
    }

    /** Explains a failed import; returns where to go next. */
    private int problem(GameImporter.Failure failure, boolean fromInstalled) throws InterruptedException {
        String version = files.manifest.gameVersion;
        switch (failure.problem) {
            case WRONG_VERSION:
                return ask("Wrong version of the game", (fromInstalled ? "The installed game app" : "This file")
                        + " has a different version of the game. Reflipped works only with version " + version
                        + " of the original game app. Choose the APK file of version " + version + ".", null, true, 1,
                        "Choose another file", "Back") == 0 ? PICK : WELCOME;
            case NOT_GAME:
                return ask("This isn't the game app", (fromInstalled ? "The installed game app doesn't contain"
                        : "The file you chose doesn't contain") + " the game. Choose the APK file of the original "
                        + "game app, version " + version + " (a file ending in .apk or .xapk).", null, true, 1,
                        "Choose another file", "Back") == 0 ? PICK : WELCOME;
            case UNREADABLE:
                return ask(fromInstalled ? "The game app couldn't be read" : "The file couldn't be read",
                        fromInstalled ? "Reflipped couldn't read the installed game app to the end: it may be "
                                + "damaged. Choose its APK file instead."
                                : "Reflipped couldn't read the whole file, or the file is damaged. If it is in a "
                                + "cloud folder or on a memory card, copy it to the phone's Downloads folder first, "
                                + "then choose it there.", null, true, 1, "Choose another file", "Back") == 0
                        ? PICK : WELCOME;
            case PATCH_FAILED:
                return ask("The game couldn't be prepared", "Your copy of the game is the right version, but "
                        + "preparing it for Reflipped failed. Try again. If it keeps failing, tell the Reflipped "
                        + "project, with this message.", null, true, 1, "Try again", "Back") == 0 ? RUN : WELCOME;
            case OUT_OF_MEMORY:
                Log.w(TAG, "import: out of memory (max " + maxMemoryMb() + " MB)");
                return ask("Not enough memory", outOfMemoryText(), null, true, 1, "Try again", "Back") == 0
                        ? RUN : WELCOME;
            default:
                return ask("The game couldn't be saved", "Reflipped couldn't write the game files to this phone's "
                        + "storage. Check that the phone has some free space, then try again.", null, true, 1,
                        "Try again", "Back") == 0 ? RUN : WELCOME;
        }
    }

    private static final Object CANCELLED = new Object();
    private static final Object NO_PICKER = new Object();

    /** The system file picker: the chosen file's Uri, {@link #CANCELLED} or {@link #NO_PICKER}. */
    private Object pick() throws InterruptedException {
        BlockingQueue<Object> answer = new ArrayBlockingQueue<>(1);
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // APK files come with many types (or none) depending on where they were saved: offer every file, and let the
        // importer tell a wrong one apart
        intent.setType("*/*");
        Activity activity = activity();
        activity.runOnUiThread(() -> ActivityResults.start(activity, intent, (result, data) -> {
            Uri uri = result == Activity.RESULT_OK && data != null ? data.getData() : null;
            if (uri != null) answer.offer(uri);
            else answer.offer(result == ActivityResults.NOT_STARTED ? NO_PICKER : CANCELLED);
        }));
        // If Android recreates the activity while the picker is open, ActivityResults hands the result to the
        // recreated fragment, so the answer still comes here.
        return answer.take();
    }

    /** Shows a question and waits for the answer; shows it again if Android recreates the activity meanwhile. */
    private int ask(String title, String body, String note, boolean problem, int back, String... buttons)
            throws InterruptedException {
        while (true) {
            int chosen = screens().ask(title, body, note, problem, back, buttons);
            if (chosen != ImportScreens.STALE) return chosen;
            Log.i(TAG, "import: the activity was recreated under a question: showing it again");
            Thread.sleep(300);  // until Android has created the new activity
        }
    }

    /**
     * Adds the REFLIPPED line to the title logo in the imported bundle.zip (BundleLogo), if it isn't there yet. Never
     * stops the game from starting: a bundle that isn't the expected one, or a failure, leaves the game's own logo.
     * `title` (with `body`) shows a screen first; without it the step text of the screen showing changes.
     */
    private void addLogo(boolean retryFailed, String title, String body) throws InterruptedException {
        BundleLogo logo = new BundleLogo(files);
        if (!logo.pending(retryFailed)) return;
        String step = "Preparing the title screen…";
        if (title != null) {
            screens().progress(title, body, step, -1);
        } else {
            screens().step(step);
        }
        long t0 = System.currentTimeMillis();
        BundleLogo.Result result = logo.apply(ImportFlow::decodePng, retryFailed);
        Log.i(TAG, "import: title logo " + result + " in " + (System.currentTimeMillis() - t0) + " ms");
    }

    /** BundleLogo's PNG decoder: the exact (non-premultiplied) pixels, or null if the image has another size. */
    private static int[] decodePng(byte[] png, int width, int height) {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        options.inPremultiplied = false;  // premultiplying would round the semi-transparent edges
        options.inScaled = false;
        if (Build.VERSION.SDK_INT >= 26) options.inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB);
        Bitmap bitmap = BitmapFactory.decodeByteArray(png, 0, png.length, options);
        if (bitmap == null) return null;
        try {
            if (bitmap.getWidth() != width || bitmap.getHeight() != height) return null;
            int[] pixels = new int[width * height];
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
            return pixels;
        } finally {
            bitmap.recycle();
        }
    }

    private void ready() {
        String path = files.game().getAbsolutePath();
        synchronized (LOCK) {
            if (id != generation) {
                Log.i(TAG, "import: flow " + id + " is done, but a newer one runs: it starts the game");
                return;
            }
            // a prepare call from here on starts a new flow at once (the loader asks again if the file fails its check)
            if (running == Thread.currentThread()) running = null;
            if (screens != null) screens.step("Starting the game…");
        }
        readyAt = System.currentTimeMillis();
        ctx.dispatchStatusEventAsync("ready", path);
    }
}
