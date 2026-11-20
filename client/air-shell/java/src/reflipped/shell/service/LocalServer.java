package reflipped.shell.service;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.lang.ref.WeakReference;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import reflipped.shell.common.ShellDialogs;

/**
 * The game process's side of the server on the phone (SH-13): holds the game's port ({@link LocalPort}), starts
 * {@link ServerService} and waits until Node answers. Until "Play on this phone" exists (SH-13 step 5), choosing that address in the server
 * list (Add server, {@code http://127.0.0.1:8000}) is how a developer selects the local server.
 */
public final class LocalServer {
    /** The local server's address for the game: the port {@link LocalPort} holds in the game's process. */
    public static final String ADDRESS = "http://127.0.0.1:8000";
    private static final long WAIT_MS = 120_000;
    /** Below this much free storage the server can't keep the save (SQLITE_FULL on every write). */
    private static final long MIN_FREE_BYTES = 32L << 20;
    private static final String PROCESS_SUFFIX = ":server";
    /** A request made while the game is away waits at most this long for it to come back, then fails. */
    private static final long AWAY_WAIT_MS = 30 * 60_000L;
    private static volatile boolean lifecycleHooked;
    private static final AtomicBoolean resuming = new AtomicBoolean();
    private static final AtomicBoolean explaining = new AtomicBoolean();
    /** After the player closes that dialog, failing requests don't bring it back for a minute. */
    private static volatile long explainedClosedAt;
    /** Whether the game is on the screen, and its activity then (for dialogs); kept by the lifecycle hook. */
    private static final Object shownLock = new Object();
    private static volatile boolean shown = true;
    private static volatile WeakReference<Activity> current = new WeakReference<>(null);
    /** Writes the idle stop's "shown" marks off the UI thread, in order. */
    private static final ExecutorService marks = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "reflipped-shown-mark");
        thread.setDaemon(true);
        return thread;
    });

    private LocalServer() {}

    /** The local server didn't start; the message is for the player, {@link #output} Node's last console lines. */
    public static final class Failed extends Exception {
        public final String output;

        Failed(String message, String output) {
            super(message);
            this.output = output == null ? "" : output;
        }
    }

    /**
     * A one-time login to the phone's admin site (SH-13 step 5b): a new random code in the file only this app can
     * write, which the server compares and deletes ({@code GET /login/once/<code>}); it lasts two minutes.
     */
    public static String adminLoginUrl(Context context) throws java.io.IOException {
        byte[] random = new byte[32];
        new java.security.SecureRandom().nextBytes(random);
        StringBuilder code = new StringBuilder();
        for (byte b : random) code.append(String.format("%02x", b));
        java.io.File file = ServerState.adminLoginFile(context);
        java.io.File temp = new java.io.File(file.getParentFile(), "admin-login.tmp");
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(temp)) {
            out.write(code.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        }
        if (!temp.renameTo(file)) throw new java.io.IOException("can't write the admin login");
        return "http://127.0.0.1:" + ServerService.ADMIN_PORT + "/login/once/" + code;
    }

    /** Whether {@code server} is the local server's address (http, 127.0.0.1, port 8000). */
    public static boolean isLocal(String server) {
        return server != null && reflipped.shell.common.ServerIdentity.same(server, ADDRESS);
    }

    /** Whether this app can run the server: Android 7+ (libnode's minimum) and a build that carries it. */
    public static boolean available(Context context) {
        return Build.VERSION.SDK_INT >= 24 && ServerBundle.inBuild(context);
    }

    /**
     * Asks the service to start (it ignores the request when Node runs already). Doesn't wait. False when Android
     * refuses: a foreground service can't be started while the game is in the background (Android 12+).
     */
    public static boolean start(Context context, boolean fresh) {
        if (available(context)) {
            try {
                LocalPort.open(context);
            } catch (Failed taken) {
                return false; // ensureRunning reports it
            }
        }
        Intent intent = new Intent(context, ServerService.class).putExtra(ServerService.EXTRA_FRESH, fresh);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
            return true;
        } catch (RuntimeException refused) {
            Log.w(ServerService.TAG, "can't start the server now (" + refused.getClass().getSimpleName() + ")");
            return false;
        }
    }

    /** Whether the service gave up on this install (until the player's Retry). */
    public static boolean givenUp(Context context) {
        try {
            return ServerState.read(context).givenUp(ServerBundle.id(context));
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Starts the server if it doesn't answer and waits until it does. A start-up that dies is retried through the
     * service's guard until it gives up; then this throws {@link Failed} with its reason. Call off the UI thread.
     * {@code fresh} is the player's Retry: it clears the guard. Without it, a server the service gave up on isn't
     * started again (no notification flashing on every return to the game).
     */
    public static void ensureRunning(Context context, boolean fresh) throws Failed {
        if (Build.VERSION.SDK_INT < 24 || !ServerBundle.inBuild(context)) {
            // a build without the server, pointed at 127.0.0.1:8000 by hand (adb reverse, Termux): use what answers
            if (answers(ADDRESS, 1000)) return;
            throw new Failed(Build.VERSION.SDK_INT < 24 ? "Playing on this phone needs Android 7 or newer."
                    : "This build of the Reflipped app has no server for playing on this phone.", "");
        }
        LocalPort.open(context);
        // ours only if our process runs: something else answering there is another app's (the service says so)
        if (processAlive(context) && answers(context, 1000)) return;
        if (!LocalDataPack.ready(context))
            throw new Failed("The game data for Local play is missing, or it doesn't fit this version of the app."
                    + " Choose Change server, then Local play, to get it.", "");
        if (!fresh && givenUp(context)) {
            ServerState state = ServerState.read(context);
            throw new Failed(state.message, ServerState.lastOutput(context, 1500));
        }
        checkStorage(context);
        // Start it only while the game is on the screen. A request the game makes in the background waits for the
        // game to come back: Android 12+ refuses a foreground service started from the background, and before that a
        // start would undo the idle stop.
        waitUntilShown();
        long began = System.currentTimeMillis();
        long deadline = began + WAIT_MS;
        long asked = began;
        boolean asking = start(context, fresh);
        while (System.currentTimeMillis() < deadline) {
            if (answers(context, 500) && processAlive(context)) {
                Log.i(ServerService.TAG, "the local server answered after " + (System.currentTimeMillis() - began) + " ms");
                return;
            }
            ServerState state = ServerState.read(context);
            if (ServerState.FAILED.equals(state.state) && state.at >= asked)
                throw new Failed(state.message, ServerState.lastOutput(context, 1500));
            // Android restarts a crashed sticky service only after a growing delay; asking again starts it at once
            // (and the service counts the dead start-up). A start Android refused is asked again once the game is
            // back on the screen.
            if (System.currentTimeMillis() - asked > 2000 && (!asking || !processAlive(context))) {
                boolean refused = !asking;
                waitUntilShown();
                checkStorage(context);
                asked = System.currentTimeMillis();
                asking = start(context, false);
                if (refused) deadline = asked + WAIT_MS;
            }
            try {
                Thread.sleep(150);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new Failed("Stopped waiting for the server.", "");
            }
        }
        throw new Failed("The server on this phone didn't answer within " + WAIT_MS / 1000 + " seconds.",
                ServerState.lastOutput(context, 1500));
    }

    /** Whether the game is on the screen; true until the lifecycle hook is in place (the game is starting then). */
    static boolean gameShown() {
        return !lifecycleHooked || shown;
    }

    /** Waits, without polling, until the game is on the screen; fails after {@link #AWAY_WAIT_MS}. */
    private static void waitUntilShown() throws Failed {
        long until = System.currentTimeMillis() + AWAY_WAIT_MS;
        synchronized (shownLock) {
            while (!gameShown()) {
                long left = until - System.currentTimeMillis();
                if (left <= 0) throw new Failed("The game was away too long.", "");
                try {
                    shownLock.wait(left);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new Failed("Stopped waiting for the server.", "");
                }
            }
        }
    }

    private static void setShown(Activity activity, boolean on) {
        synchronized (shownLock) {
            shown = on;
            if (on) current = new WeakReference<>(activity);
            shownLock.notifyAll();
        }
        Context app = activity.getApplicationContext();
        marks.execute(() -> ServerState.markShown(app));
    }

    /**
     * Tells the player why the server on this phone isn't running and offers Retry (the player's fresh start, behind
     * the "Starting" cover) or Close. One dialog at a time; only once the game is past its start-up (the start-up has
     * its own dialog) and on the screen. Blocks: call off the UI thread.
     */
    static void explain(Context context, Failed failed) {
        Activity activity = current.get();
        if (!lifecycleHooked || !shown || activity == null
                || System.currentTimeMillis() - explainedClosedAt < 60_000 || !explaining.compareAndSet(false, true)) return;
        Context app = context.getApplicationContext();
        try {
            while (true) {
                if (ShellDialogs.choose(activity, "The server on this phone isn't running", failed.getMessage(),
                        "Retry", "Close") != 0) {
                    explainedClosedAt = System.currentTimeMillis();
                    return;
                }
                ShellDialogs.busy(activity, "Starting the server on this phone…");
                try {
                    ensureRunning(app, true);
                    return;
                } catch (Failed again) {
                    failed = again;
                } finally {
                    ShellDialogs.endBusy(activity);
                }
            }
        } catch (Exception gone) {
            // the activity went away
        } finally {
            explaining.set(false);
        }
    }

    private static void checkStorage(Context context) throws Failed {
        if (context.getFilesDir().getUsableSpace() < MIN_FREE_BYTES)
            throw new Failed("The phone's storage is full, so the server on this phone can't keep your game. Free"
                    + " some space and tap Retry.", "");
    }

    /**
     * Starts the server again whenever the game comes back to the screen without it (it stops after the game has been
     * away a while, when the app is swiped away, and Android may end it), with a cover saying so until it answers, so
     * the game's next request finds it. Hooked once per process.
     */
    public static synchronized void keepRunningWhileShown(Activity activity, java.util.concurrent.Callable<Boolean> local) {
        if (lifecycleHooked) return;
        setShown(activity, true); // hooked from the game's start-up, on the screen
        lifecycleHooked = true;
        activity.getApplication().registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            public void onActivityResumed(Activity resumed) {
                setShown(resumed, true);
                if (!resuming.compareAndSet(false, true)) return;
                new Thread(() -> {
                    boolean covered = false;
                    Context app = resumed.getApplicationContext();
                    try {
                        if (!local.call() || !available(app)) return;
                        if (givenUp(app)) {
                            ServerState state = ServerState.read(app);
                            throw new Failed(state.message, "");
                        }
                        if (processAlive(app) && answers(app, 300)) return;
                        Log.i(ServerService.TAG, "the game is back: starting the local server");
                        ShellDialogs.busy(resumed, "Starting the server on this phone…");
                        covered = true;
                        ensureRunning(app, false);
                    } catch (Failed failed) {
                        Log.w(ServerService.TAG, "the local server isn't running: " + failed.getMessage());
                        if (covered) ShellDialogs.endBusy(resumed);
                        covered = false;
                        explain(app, failed);
                    } catch (Exception e) {
                        Log.w(ServerService.TAG, "couldn't restart the local server", e);
                    } finally {
                        if (covered) ShellDialogs.endBusy(resumed);
                        resuming.set(false);
                    }
                }, "reflipped-server-resume").start();
            }
            public void onActivityCreated(Activity a, Bundle b) {}
            public void onActivityStarted(Activity a) {}
            public void onActivityPaused(Activity a) {
                setShown(a, false); // on the screen until now: the idle stop counts from here
            }
            public void onActivityStopped(Activity a) {}
            public void onActivitySaveInstanceState(Activity a, Bundle b) {}
            public void onActivityDestroyed(Activity a) {}
        });
    }

    /** Whether the server's process runs (the app sees only its own processes). */
    static boolean processAlive(Context context) {
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        List<ActivityManager.RunningAppProcessInfo> processes = manager.getRunningAppProcesses();
        if (processes == null) return false;
        String name = context.getPackageName() + PROCESS_SUFFIX;
        for (ActivityManager.RunningAppProcessInfo process : processes) if (name.equals(process.processName)) return true;
        return false;
    }

    /**
     * Whether our Node answers as a Reflipped server on its Unix socket within {@code timeoutMs}: a plain HTTP request
     * for /shell/config over {@link android.net.LocalSocket}.
     */
    static boolean answers(Context context, int timeoutMs) {
        android.net.LocalSocket socket = new android.net.LocalSocket();
        try {
            socket.connect(new android.net.LocalSocketAddress(ServerState.nodeSocket(context).getAbsolutePath(),
                    android.net.LocalSocketAddress.Namespace.FILESYSTEM));
            socket.setSoTimeout(timeoutMs);
            socket.getOutputStream().write(("GET /shell/config HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nConnection: close\r\n\r\n")
                    .getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            ByteArrayOutputStream reply = new ByteArrayOutputStream();
            InputStream in = socket.getInputStream();
            byte[] buffer = new byte[4096];
            for (int n; (n = in.read(buffer)) > 0 && reply.size() < 65536; ) reply.write(buffer, 0, n);
            String text = reply.toString("UTF-8");
            int body = text.indexOf("\r\n\r\n");
            if (!text.startsWith("HTTP/1.1 200") || body < 0) return false;
            String json = text.substring(body + 4);
            int start = json.indexOf('{');  // a chunked body has a size line before it
            int end = json.lastIndexOf('}');
            return start >= 0 && end > start
                    && new org.json.JSONObject(json.substring(start, end + 1)).optInt("reflipped") == 1;
        } catch (Exception notYet) {
            return false;
        } finally {
            try { socket.close(); } catch (java.io.IOException ignored) { /* closed */ }
        }
    }

    /** Whether a Reflipped server answers {@code /shell/config} at {@code base} within {@code timeoutMs}. */
    static boolean answers(String base, int timeoutMs) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(base + "/shell/config").openConnection();
            connection.setConnectTimeout(timeoutMs);
            connection.setReadTimeout(timeoutMs);
            connection.setInstanceFollowRedirects(false);
            if (connection.getResponseCode() != 200) return false;
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[4096];
                for (int n; (n = in.read(buffer)) > 0 && body.size() < 65536; ) body.write(buffer, 0, n);
            }
            return new org.json.JSONObject(body.toString("UTF-8")).optInt("reflipped") == 1;
        } catch (Exception notYet) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
