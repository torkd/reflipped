package reflipped.shell.other;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/** `com.sesisoft.PushService`: local notifications. No-op. */
public class PushServiceStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.sesisoft.PushService";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.constant(false, "IS_PUSH_INITIALIZED");
        ctx.noop("TRY_INITIALIZE_PUSH", "focus", "scheduleLocalNotificationByMsec",
                "cancelLocalNotification", "cancelAllLocalNotification");
    }
}
