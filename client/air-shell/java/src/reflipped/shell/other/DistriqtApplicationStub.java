package reflipped.shell.other;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/**
 * `com.distriqt.Application`: the game never opens a context for it itself; our ActionScript library
 * (as3/com.distriqt.Application) does, to ask `isSupported`. It answers false, so the game doesn't read the device
 * locale from it.
 */
public class DistriqtApplicationStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.distriqt.Application";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.constant(false, "isSupported");
    }
}
