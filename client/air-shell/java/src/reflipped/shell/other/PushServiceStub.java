package reflipped.shell.other;

import android.content.Context;

import reflipped.shell.common.Args;
import reflipped.shell.common.NotificationPermission;
import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;
import reflipped.shell.service.DownloadService;

/**
 * `com.sesisoft.PushService`: the game's local notifications (SH-6), scheduled by {@link LocalNotifications}.
 *
 * <ul>
 *   <li>TRY_INITIALIZE_PUSH (where the original asked for the notification permission; this client never calls
 *       it): asks once, see {@link NotificationPermission}.</li>
 *   <li>IS_PUSH_INITIALIZED: true; the game schedules nothing while it is false.</li>
 *   <li>scheduleLocalNotificationByMsec(message, delayMsec, label, priority, notificationId): the game's
 *       `notification/notification` row (`stamina`: delay = time until stamina is full, only while the Settings
 *       switch is on). The priority (the original's exact-alarm choice) is ignored: see LocalNotifications. The
 *       first one asks for the notification permission if nothing asked before.</li>
 *   <li>cancelLocalNotification(label), cancelAllLocalNotification.</li>
 *   <li>focus (the game came back to the front; a no-op in the original): clears the reminders and the "download
 *       complete" notification already shown.</li>
 * </ul>
 */
public class PushServiceStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.sesisoft.PushService";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.on("TRY_INITIALIZE_PUSH", (c, a) -> {
            NotificationPermission.askOnce(c.getActivity());
            return 0;
        });
        ctx.constant(true, "IS_PUSH_INITIALIZED");
        ctx.on("scheduleLocalNotificationByMsec", (c, a) -> {
            String message = Args.str(a, 0);
            int delay = Args.integer(a, 1, 0);
            String label = Args.str(a, 2);
            int group = Args.integer(a, 4, 1);
            LocalNotifications.schedule(app(c), label, message, delay, group);
            NotificationPermission.askOnce(c.getActivity());
            return 0;
        });
        ctx.on("cancelLocalNotification", (c, a) -> {
            LocalNotifications.cancel(app(c), Args.str(a, 0));
            return 0;
        });
        ctx.on("cancelAllLocalNotification", (c, a) -> {
            LocalNotifications.cancelAll(app(c));
            return 0;
        });
        ctx.on("focus", (c, a) -> {
            LocalNotifications.clearShown(app(c));
            DownloadService.clearCompleted(app(c));
            return 0;
        });
    }

    private static Context app(StubContext ctx) {
        return ctx.getActivity().getApplicationContext();
    }
}
