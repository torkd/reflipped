package reflipped.shell.pinball;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/** `pinball.vibration`: vibrate(ms). No-op for now. */
public class VibrationStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "pinball.vibration";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.noop("vibrate");
    }
}
