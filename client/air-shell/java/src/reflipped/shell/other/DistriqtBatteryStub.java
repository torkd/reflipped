package reflipped.shell.other;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/**
 * `com.distriqt.Battery`: the device battery for the header's gauge.
 *
 * Distriqt's AS3 wrapper calls isSupported and getBatteryInfo, then listens for the StatusEvent
 * `battery:info` whose level is "<percent>|<state>"; it turns that into the BatteryEvent the game
 * draws from. The state is BatteryManager's status (the game treats 2, charging, as "plugged in").
 * Android pushes changes through ACTION_BATTERY_CHANGED, so the event is sent once on request and
 * again on every change while the context lives.
 */
public class DistriqtBatteryStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.distriqt.Battery";
    }

    @Override
    protected void register(StubContext ctx) {
        final Receiver receiver = new Receiver(ctx);
        ctx.constant(true, "isSupported");
        ctx.constant("3.0.003", "version");
        ctx.constant("Android", "implementation");
        ctx.on("getBatteryInfo", (c, a) -> {
            receiver.start(c.getActivity());
            return null;
        });
        ctx.noop("cancel");
        ctx.onDispose(receiver::stop);
    }

    private static final class Receiver extends BroadcastReceiver {
        private final StubContext ctx;
        private Activity activity;
        private volatile boolean stopped;

        Receiver(StubContext ctx) {
            this.ctx = ctx;
        }

        /** Registers once; the sticky broadcast delivers the current state straight away. */
        synchronized void start(Activity owner) {
            if (stopped || activity != null || owner == null) return;
            activity = owner;
            owner.registerReceiver(this, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        }

        synchronized void stop() {
            stopped = true;
            if (activity == null) return;
            try {
                activity.unregisterReceiver(this);
            } catch (IllegalArgumentException ignored) {
                // already gone
            }
            activity = null;
        }

        @Override
        public void onReceive(Context context, Intent battery) {
            if (stopped) return;
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            if (level < 0 || scale <= 0) return;
            int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, 0);
            ctx.dispatchStatusEventAsync("battery:info", Math.round(100.0 * level / scale) + "|" + status);
        }
    }
}
