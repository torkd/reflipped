package reflipped.shell.common;

import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Refresh can never occupy the workers reserved for selection and fresh Join checks. */
public final class ServerProbeQueues {
    public enum Priority { BACKGROUND, INTERACTIVE, JOIN }

    private final ScheduledThreadPoolExecutor background = pool(2), interactive = pool(1), join = pool(1);

    private static ScheduledThreadPoolExecutor pool(int threads) {
        ScheduledThreadPoolExecutor pool = new ScheduledThreadPoolExecutor(threads);
        pool.setRemoveOnCancelPolicy(true);
        return pool;
    }

    /** The browser coalesces to one pending future per bounded server record across all lanes. */
    public ScheduledFuture<?> submit(Priority priority, Runnable request) {
        return (priority == Priority.JOIN                  ? join
                        : priority == Priority.INTERACTIVE ? interactive
                                                           : background)
                .schedule(request, 0, TimeUnit.MILLISECONDS);
    }

    public void close() {
        background.shutdownNow();
        interactive.shutdownNow();
        join.shutdownNow();
    }
}
