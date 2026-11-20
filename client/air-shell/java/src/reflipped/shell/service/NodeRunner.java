package reflipped.shell.service;

import android.system.Os;
import android.text.TextUtils;

import java.util.Map;

/**
 * Runs Node (nodejs-mobile's libnode.so) through our JNI launcher, libreflippednode.so (client/air-shell/native/
 * launcher.c). Only one Node can run in a process and it can't be started again there, so this runs once per
 * {@code :server} process; a restart is a new process.
 */
final class NodeRunner {
    private NodeRunner() {}

    private static boolean started;

    /**
     * Sets the environment, then runs Node with {@code args} (after argv[0]) in {@code cwd}, copying its console output
     * to logcat (tag NodeJS) and to {@code log}. Blocks until Node's event loop ends and returns its exit code;
     * {@code process.exit} or an uncaught error ends the whole process instead. Negative codes are the launcher's own
     * failures (bad environment, no pipe).
     */
    static synchronized int run(String cwd, String[] args, Map<String, String> env, String log) throws Exception {
        if (started) throw new IllegalStateException("Node already ran in this process");
        started = true;
        long loadStart = System.nanoTime();
        // loads libnode.so and libc++_shared.so with it (its DT_NEEDED)
        System.loadLibrary("reflippednode");
        android.util.Log.i(ServerService.TAG, "loaded Node in " + (System.nanoTime() - loadStart) / 1000000 + " ms");
        for (Map.Entry<String, String> e : env.entrySet()) Os.setenv(e.getKey(), e.getValue(), true);
        Os.setenv("REFLIPPED_NODE_ARGS", TextUtils.join("\n", args), true);
        Os.setenv("REFLIPPED_NODE_CWD", cwd, true);
        Os.setenv("REFLIPPED_NODE_LOG", log, true);
        return start();
    }

    private static native int start();
}
