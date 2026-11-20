package reflipped.shell.service;

import android.app.ActivityManager;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The Reflipped server on the phone (SH-13, docs/on-device-server.md): Node running the server bundle, in this
 * service's own process ({@code :server} in the manifest), so Node's memory and crashes stay away from AIR and a
 * restart is a new process. Started by {@link LocalServer} from the game's process.
 *
 * Start-up guard: any uncaught error or {@code process.exit} in Node ends this process, which Android counts as a
 * crash and restarts this sticky service after 1, 4, 16, 64, 256 s. A start whose process dies before the port answers
 * counts as a failure ({@link ServerState}); after {@value #MAX_FAILURES} in a row the service gives up and records
 * the state {@code failed} with Node's last output, which the app shows; only the player's Retry (a fresh start) or an
 * app update starts it again. A server that dies after it answered is restarted as before.
 *
 * Stops (state {@code stopped}, not counted): swiping the app away ({@link #onTaskRemoved}), and the idle stop: when
 * the game has been off the screen for {@value #IDLE_STOP_DEFAULT_S} s ({@code REFLIPPED_IDLE_STOP_SECONDS} in the
 * developer settings; 0 turns it off), Node gets SIGTERM, closes the database and exits. The app starts the server
 * again when the game comes back. The service holds no wakelock; its timers run only while the CPU is awake anyway.
 */
public final class ServerService extends ForegroundServiceBase {
    static final String TAG = "ReflippedServer";
    /** Set by the app for a start the player asked for (Retry): clears the failure count and a given-up state. */
    static final String EXTRA_FRESH = "fresh";
    static final int MAX_FAILURES = 3;
    /** The admin site of the server on the phone (settings, clock, saves), opened by the app's Admin panel entry. */
    static final int ADMIN_PORT = 18001;
    /** Owner decision 2026-11-13: stop the server after 5 minutes with the game off the screen. */
    static final int IDLE_STOP_DEFAULT_S = 300;
    /** Node's heap limit, as a share of the phone's memory (2.5 GB gives about 700 MB). */
    private static final String HEAP = "--max-old-space-size-percentage=25";
    private static final int SIGTERM = 15;

    /** Whether this process took a start (Node runs or is about to); Node can't be started twice in a process. */
    private static volatile boolean started;
    /** Whether this process is stopping on purpose (idle, swipe): then onDestroy leaves Node time to close. */
    private static volatile boolean stopping;
    /** Orders the state writes of the start-up watch and of a stop, so a stop's {@code stopped} is never overwritten. */
    private static final Object stateLock = new Object();
    private static volatile long startedAt;

    @Override
    protected int notificationId() {
        return 8000;
    }

    @Override
    protected String title() {
        return "Reflipped server";
    }

    @Override
    protected String text() {
        return "Runs the game server on this phone while you play.";
    }

    @Override
    protected int type() {
        return ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            goForeground();
        } catch (RuntimeException notAllowed) {
            // Android 12+: a sticky restart while the game is in the background may not become a foreground
            // service (ForegroundServiceStartNotAllowedException). Don't run Node without it; the game's return
            // starts the server again. The state stays as it was, so a dead start-up is still counted then.
            Log.w(TAG, "can't run in the foreground now (" + notAllowed.getClass().getSimpleName()
                    + "); the app starts the server when the game is back");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (stopping) {
            // asked again while closing after an idle stop: end now (the database is closed or crash-safe) so the
            // app's next request starts a new process
            Process.killProcess(Process.myPid());
            return START_NOT_STICKY;
        }
        if (started) return START_STICKY;
        started = true;
        final boolean fresh = intent != null && intent.getBooleanExtra(EXTRA_FRESH, false);
        final boolean redelivered = intent == null;
        // the decisions read files and the log: off the main thread; Node runs on this thread afterwards
        new Thread(null, () -> startServer(fresh, redelivered), "reflipped-node", 16L << 20).start();
        return START_STICKY;
    }

    private void startServer(boolean fresh, boolean redelivered) {
        ServerState last = ServerState.read(this);
        String bundle;
        try {
            bundle = ServerBundle.id(this);
        } catch (Exception e) {
            bundle = "";
        }
        if (redelivered && ServerState.STOPPED.equals(last.state)) {
            // a sticky restart of a server that was stopped on purpose (idle, swipe) and then died: stay stopped
            end(null, 0, bundle);
            return;
        }
        int failures = last.failures;
        if (ServerState.STARTING.equals(last.state)) {
            // the previous process died during start-up: keep its output for the error message
            failures++;
            copy(ServerState.nodeLog(this), ServerState.failedLog(this));
            appendNodeErrors(last.pid, ServerState.failedLog(this));
            Log.w(TAG, "the server's previous start-up ended early (" + failures + " in a row); its last output:\n"
                    + ServerState.tail(ServerState.failedLog(this), 2000));
        } else if (!ServerState.FAILED.equals(last.state)) {
            failures = 0;
        }
        if (fresh || !bundle.equals(last.bundle)) failures = 0;
        if (last.givenUp(bundle) && !fresh) {
            end(last.message, last.failures, bundle);
            return;
        }
        if (failures >= MAX_FAILURES) {
            end("The server stopped during start-up " + failures + " times in a row.", failures, bundle);
            return;
        }
        if (!ServerBundle.inBuild(this)) {
            end("This build of the app has no server.", failures, bundle);
            return;
        }
        if (!ServerState.write(this, ServerState.STARTING, failures, "", bundle)) {
            // full storage: nothing would work; the app checks free space and says so
            end(null, failures, bundle);
            return;
        }
        startedAt = System.nanoTime();
        final String bundleId = bundle;
        new Thread(() -> watch(bundleId), "reflipped-node-watch").start();
        runNode(bundle, failures);
    }

    private void runNode(String bundle, int failures) {
        String message;
        Map<String, String> developer = developerEnv();
        try {
            ServerBundle.unpack(this);
            File root = ServerBundle.root(this);
            File compileCache = new File(getCodeCacheDir(), "node-compile-cache");
            compileCache.mkdirs();
            Map<String, String> env = new LinkedHashMap<>();
            env.put("REFLIPPED_PROFILE", "local");
            // the game-derived data (master extract, converted tables) comes as a data pack, outside the APK
            env.put("DATA_PACK_DIR", new File(root, "datapack").getAbsolutePath());
            env.put("NODE_COMPILE_CACHE", compileCache.getAbsolutePath());
            env.put("TMPDIR", getCacheDir().getAbsolutePath());
            env.put("HOME", root.getAbsolutePath());
            env.putAll(developer);
            // a Unix socket in private storage, not a TCP port another app could take; the game's 8000 is held by LocalPort
            env.put("LISTEN_SOCKET", ServerState.nodeSocket(this).getAbsolutePath());
            // the admin site, reached only through the app's one-time logins (LocalServer.adminLoginUrl)
            env.put("ADMIN_PORT", Integer.toString(ADMIN_PORT));
            env.put("ADMIN_LOGIN_CODE_FILE", ServerState.adminLoginFile(this).getAbsolutePath());
            startIdleWatch(developer);
            Log.i(TAG, "starting Node in " + root);
            int code = NodeRunner.run(root.getAbsolutePath(),
                    new String[]{HEAP, new File(root, "server.js").getAbsolutePath()}, env,
                    ServerState.nodeLog(this).getAbsolutePath());
            if (stopping) return; // closed on purpose
            message = "The server ended (exit code " + code + ").";
        } catch (Throwable t) {
            Log.e(TAG, "the server couldn't start", t);
            message = "The server couldn't start: " + t;
            ServerState.appendLine(ServerState.nodeLog(this), message);
        }
        if (ServerState.STARTING.equals(ServerState.read(this).state)) {
            // ended before it answered: a dead start-up like a crash, which the next start counts (the guard gives up
            // after MAX_FAILURES in a row), not a give-up at once
            Log.w(TAG, message + " (during start-up)");
            Process.killProcess(Process.myPid());
            return;
        }
        // ended after it answered: Node can't run again in this process; give up (no restart loop) until Retry
        copy(ServerState.nodeLog(this), ServerState.failedLog(this));
        end(message, failures + 1, bundle);
        Process.killProcess(Process.myPid());
    }

    /**
     * Gives up (message set: state {@code failed}, the bundle unpacked again next time) or just stops (message null),
     * without running Node.
     */
    private void end(String message, int failures, String bundle) {
        if (message != null) {
            ServerState.write(this, ServerState.FAILED, failures, message, bundle);
            ServerBundle.invalidate(this);
            Log.e(TAG, "not running the server: " + message);
        }
        stopForeground(true);
        stopSelf();
    }


    /**
     * Developer settings for the server: {@code KEY=VALUE} lines in {@code <files>/server-service/env}, which only the
     * app itself (or root, e.g. on an emulator) can write; e.g. {@code EVENT_SCHEDULING=off} until the data pack
     * exists, or {@code REFLIPPED_IDLE_STOP_SECONDS=30}. Not meant for players.
     */
    private Map<String, String> developerEnv() {
        Map<String, String> env = new LinkedHashMap<>();
        File file = new File(ServerState.dir(this), "env");
        if (!file.isFile()) return env;
        try (java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(
                new FileInputStream(file), java.nio.charset.StandardCharsets.UTF_8))) {
            for (String line; (line = in.readLine()) != null; ) {
                int eq = line.indexOf('=');
                if (line.trim().startsWith("#") || eq <= 0) continue;
                env.put(line.substring(0, eq).trim(), line.substring(eq + 1).trim());
            }
        } catch (Exception e) {
            Log.w(TAG, "can't read " + file, e);
        }
        if (!env.isEmpty()) Log.w(TAG, "developer settings for the server: " + env.keySet());
        return env;
    }

    /** Marks the server running once its port answers, which also ends the start-up failure count. */
    private void watch(String bundle) {
        long deadline = System.nanoTime() + 300_000_000_000L;
        while (System.nanoTime() < deadline && !stopping) {
            if (LocalServer.answers(this, 500)) {
                long ms = (System.nanoTime() - startedAt) / 1000000;
                synchronized (stateLock) {
                    if (stopping) return;
                    if (ServerState.STARTING.equals(ServerState.read(this).state))
                        ServerState.write(this, ServerState.RUNNING, 0, "", bundle);
                }
                ServerState.failedLog(this).delete();
                Log.i(TAG, "the server answers on its socket, " + ms + " ms after the start");
                return;
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    /**
     * The idle stop: checks now and then whether the game is on the screen, and stops the server once it hasn't been
     * for the idle time. Uses no wakelock or alarm: while the phone sleeps this thread sleeps too, and on waking the
     * elapsed time (which counts deep sleep) is past the limit, so the server stops then.
     */
    private void startIdleWatch(Map<String, String> developer) {
        int seconds = IDLE_STOP_DEFAULT_S;
        try {
            String value = developer.get("REFLIPPED_IDLE_STOP_SECONDS");
            if (value != null) seconds = Integer.parseInt(value);
        } catch (NumberFormatException bad) {
            Log.w(TAG, "REFLIPPED_IDLE_STOP_SECONDS isn't a number; using " + seconds);
        }
        if (seconds <= 0) return;
        final long limit = seconds * 1000L;
        final long poll = Math.max(1000L, Math.min(30_000L, limit / 5));
        Thread idle = new Thread(() -> {
            // the last moment the game was on the screen: seen by this check, or marked by the game's process at a
            // resume or pause (a visit shorter than one check would otherwise go unnoticed)
            long lastShown = SystemClock.elapsedRealtime();
            while (!stopping) {
                try {
                    Thread.sleep(poll);
                } catch (InterruptedException e) {
                    return;
                }
                long now = SystemClock.elapsedRealtime();
                if (gameOnScreen()) {
                    lastShown = now;
                } else {
                    lastShown = Math.max(lastShown, ServerState.lastShown(this));
                    if (now - lastShown >= limit) {
                        stopGracefully("the game has been off the screen for " + (now - lastShown) / 1000 + " s");
                        return;
                    }
                }
            }
        }, "reflipped-server-idle");
        idle.setDaemon(true);
        idle.start();
    }

    /** Whether the game's own process is in the foreground (visible to the player). */
    private boolean gameOnScreen() {
        ActivityManager manager = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
        List<ActivityManager.RunningAppProcessInfo> processes = manager.getRunningAppProcesses();
        if (processes == null) return false;
        for (ActivityManager.RunningAppProcessInfo process : processes) {
            if (getPackageName().equals(process.processName))
                return process.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE;
        }
        return false;
    }

    /**
     * A clean stop (idle, swipe): state {@code stopped} (not a failure), the service and its notification end, then
     * SIGTERM lets Node close its listeners and the database and exit (the local profile handles it, src/server.ts);
     * after 5 s the process is ended anyway, which SQLite's WAL survives.
     */
    private void stopGracefully(String why) {
        synchronized (stateLock) {
            if (stopping) return;
            stopping = true;
            Log.i(TAG, "stopping the server: " + why);
            ServerState.write(this, ServerState.STOPPED, 0, "", ServerState.read(this).bundle);
        }
        stopForeground(true);
        stopSelf();
        Process.sendSignal(Process.myPid(), SIGTERM);
        new Thread(() -> {
            SystemClock.sleep(5000);
            Log.w(TAG, "Node didn't exit after SIGTERM: ending the process");
            Process.killProcess(Process.myPid());
        }, "reflipped-server-stop").start();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The player swiped the app away: that is quitting, so the server stops too, rather than holding memory with
        // a notification and no game. The app starts the server again when it comes back.
        stopGracefully("app swiped away");
    }

    @Override
    public void onDestroy() {
        // Stopped from outside (the system, `am stopservice`): without the foreground service the process would be
        // cached and frozen with Node in it, answering nothing. End it; the app starts the server again.
        if (started && !stopping) {
            Log.i(TAG, "service stopped: ending the server's process");
            ServerState state = ServerState.read(this);
            if (!ServerState.FAILED.equals(state.state))
                ServerState.write(this, ServerState.STOPPED, 0, "", state.bundle);
            Process.killProcess(Process.myPid());
        }
        super.onDestroy();
    }

    /**
     * nodejs-mobile writes an uncaught error to logcat (tag {@code nodejs}) instead of stderr, so it isn't in the
     * launcher's log; an app may read its own processes' log lines, so take them from there. Not on the main thread.
     */
    private static void appendNodeErrors(int pid, File log) {
        if (pid <= 0) return;
        try {
            java.lang.Process logcat = Runtime.getRuntime().exec(new String[]{"logcat", "-d", "-v", "raw",
                    "--pid=" + pid, "-s", "nodejs:*"});
            try (InputStream in = logcat.getInputStream(); OutputStream out = new FileOutputStream(log, true)) {
                byte[] buffer = new byte[8192];
                int total = 0;
                for (int n; (n = in.read(buffer)) > 0 && total < 65536; total += n) out.write(buffer, 0, n);
            }
            logcat.waitFor();
        } catch (Exception e) {
            Log.w(TAG, "can't read Node's errors from the log", e);
        }
    }

    private static void copy(File from, File to) {
        if (!from.exists()) return;
        try (InputStream in = new FileInputStream(from); OutputStream out = new FileOutputStream(to)) {
            byte[] buffer = new byte[8192];
            for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
        } catch (Exception e) {
            Log.w(TAG, "can't keep the server's log", e);
        }
    }
}
