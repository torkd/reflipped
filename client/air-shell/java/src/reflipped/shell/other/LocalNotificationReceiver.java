package reflipped.shell.other;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The alarms of {@link LocalNotifications}, and the re-arming after a reboot ({@code BOOT_COMPLETED}) or an app update
 * ({@code MY_PACKAGE_REPLACED}). Declared in the descriptor, not exported: only the system and our own alarms reach it.
 */
public final class LocalNotificationReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            LocalNotifications.rearm(context);
            return;
        }
        String label = LocalNotifications.labelOf(intent);
        if (label != null) LocalNotifications.fire(context, label);
    }
}
