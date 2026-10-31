package reflipped.shell.pinball;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/** `pinball.checkapp`: root check and Play in-app update check. */
public class CheckAppStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "pinball.checkapp";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.constant(false, "isRootUser");
        ctx.noop("checkAppUpdate");
    }
}
