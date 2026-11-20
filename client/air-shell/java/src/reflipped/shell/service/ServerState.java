package reflipped.shell.service;

import android.content.Context;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.Properties;

/**
 * What the local server's process ({@link ServerService}, {@code :server}) tells the game's process about it, kept in
 * files because the two processes share nothing else: {@code <files>/server-service/state.properties} (written whole
 * and renamed into place) and {@code node.log}, the current run's console output, which the launcher writes.
 *
 * States: {@code starting} (Node is starting or the process died while it was), {@code running} (the port answered),
 * {@code failed} (the service gave up: the start-up guard, Node ended, the port is taken; {@link #message} says why;
 * only the player's Retry starts it again), {@code stopped} (swiped away, idle, or stopped from outside; not a
 * failure).
 */
public final class ServerState {
    public static final String STARTING = "starting", RUNNING = "running", FAILED = "failed", STOPPED = "stopped";

    public final String state;
    /** Start-ups in a row that died before the port answered. */
    public final int failures;
    public final String message;
    /** The bundle (app version and install time) the last start used. */
    public final String bundle;
    /** When the state was written (System.currentTimeMillis). */
    public final long at;
    /** The process that wrote it (0: unknown). */
    final int pid;

    ServerState(String state, int failures, String message, String bundle, long at, int pid) {
        this.state = state;
        this.failures = failures;
        this.message = message;
        this.bundle = bundle;
        this.at = at;
        this.pid = pid;
    }

    /** Whether the service gave up on this install's bundle: then only the player's Retry starts it again. */
    public boolean givenUp(String currentBundle) {
        return FAILED.equals(state) && bundle.equals(currentBundle);
    }

    static File dir(Context context) {
        File dir = new File(context.getFilesDir(), "server-service");
        if (!dir.isDirectory()) dir.mkdirs(); // a failure shows when a file in it can't be written
        return dir;
    }

    /**
     * The game's process marks when it was last on the screen ({@link SystemClock#elapsedRealtime()}, which every
     * process shares and the phone's clock settings don't move), at every resume and pause, so the idle stop counts a
     * visit shorter than its own check. Never throws: a missed mark only makes the idle stop come sooner. The mark
     * carries Android's boot count, since elapsedRealtime starts again at a reboot.
     */
    public static void markShown(Context context) {
        try (FileOutputStream out = new FileOutputStream(new File(dir(context), "shown"))) {
            out.write((SystemClock.elapsedRealtime() + " " + bootCount(context)).getBytes(StandardCharsets.US_ASCII));
        } catch (Exception e) {
            Log.w(ServerService.TAG, "can't mark the game as shown", e);
        }
    }

    /** The last {@link #markShown} time, or -1 (none in this boot of the phone, or unreadable). */
    static long lastShown(Context context) {
        File file = new File(dir(context), "shown");
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] data = new byte[64];
            int n = in.read(data);
            String[] parts = n > 0 ? new String(data, 0, n, StandardCharsets.US_ASCII).trim().split(" ") : new String[0];
            // elapsedRealtime starts again at a reboot: a mark from another boot means nothing
            if (parts.length != 2 || Integer.parseInt(parts[1]) != bootCount(context)) return -1;
            long at = Long.parseLong(parts[0]);
            return at <= SystemClock.elapsedRealtime() ? at : -1;
        } catch (Exception e) {
            return -1;
        }
    }

    /** Android's count of boots since the phone was set up (API 24+), or -1 where a phone doesn't keep it. */
    private static int bootCount(Context context) {
        try {
            return Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT);
        } catch (Exception e) {
            return -1;
        }
    }

    /** Appends one line to a log file (for the error dialog); never throws. */
    static void appendLine(File file, String line) {
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            // the message is in logcat too
        }
    }

        /** The one-time admin login code (SH-13 step 5b): written by the app, read and deleted by the server. */
    static File adminLoginFile(Context context) {
        return new File(dir(context), "admin-login");
    }

    /**
     * Node's Unix socket (SH-13): in this app's private storage, so no other app on the phone can open it or take its
     * place, unlike a TCP port on 127.0.0.1 (security review 2026-11-13). LocalPort passes the game's port 8000 here.
     */
    static File nodeSocket(Context context) {
        return new File(dir(context), "node.sock");
    }

    static File nodeLog(Context context) {
        return new File(dir(context), "node.log");
    }

    /** The log of the run that made the guard give up, kept for the error message. */
    static File failedLog(Context context) {
        return new File(dir(context), "failed.log");
    }

    public static ServerState read(Context context) {
        Properties p = new Properties();
        File file = new File(dir(context), "state.properties");
        if (file.exists()) {
            try (FileInputStream in = new FileInputStream(file)) {
                p.load(in);
            } catch (Exception unreadable) {
                // treated as no state: a fresh start
            }
        }
        int failures, pid;
        long at;
        try {
            failures = Integer.parseInt(p.getProperty("failures", "0"));
            at = Long.parseLong(p.getProperty("at", "0"));
            pid = Integer.parseInt(p.getProperty("pid", "0"));
        } catch (NumberFormatException bad) {
            failures = 0;
            at = 0;
            pid = 0;
        }
        return new ServerState(p.getProperty("state", STOPPED), failures, p.getProperty("message", ""),
                p.getProperty("bundle", ""), at, pid);
    }

    /**
     * Stores the state. Returns false when it can't (full storage) and never throws: a throw in the service would
     * crash its process into Android's restart loop.
     */
    static boolean write(Context context, String state, int failures, String message, String bundle) {
        Properties p = new Properties();
        p.setProperty("state", state);
        p.setProperty("failures", Integer.toString(failures));
        p.setProperty("message", message == null ? "" : message);
        p.setProperty("bundle", bundle == null ? "" : bundle);
        p.setProperty("at", Long.toString(System.currentTimeMillis()));
        p.setProperty("pid", Integer.toString(android.os.Process.myPid()));
        try {
            File dir = dir(context);
            File temp = new File(dir, "state.properties.tmp");
            try (FileOutputStream out = new FileOutputStream(temp)) {
                p.store(out, null);
                out.getFD().sync();
            }
            if (temp.renameTo(new File(dir, "state.properties"))) return true;
            Log.e(ServerService.TAG, "can't store the server state");
        } catch (Exception e) {
            Log.e(ServerService.TAG, "can't write the server state (storage full?)", e);
        }
        return false;
    }

    /** The last {@code max} bytes of a log, as text: what the error message shows of Node's own output. */
    public static String tail(File log, int max) {
        if (!log.exists()) return "";
        try (RandomAccessFile file = new RandomAccessFile(log, "r")) {
            long start = Math.max(0, file.length() - max);
            byte[] bytes = new byte[(int) (file.length() - start)];
            file.seek(start);
            file.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8).trim();
        } catch (Exception unreadable) {
            return "";
        }
    }

    /** Node's last output from the run that failed, or else from the current run. */
    public static String lastOutput(Context context, int max) {
        String failed = tail(failedLog(context), max);
        return failed.isEmpty() ? tail(nodeLog(context), max) : failed;
    }
}
