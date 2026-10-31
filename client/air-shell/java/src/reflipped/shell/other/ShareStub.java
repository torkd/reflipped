package reflipped.shell.other;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/** `com.digitalstrawberry.ane.share`: declared in the original descriptor, but the SWF never opens a context for it (docs/air-shell.md). */
public class ShareStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.digitalstrawberry.ane.share";
    }

    @Override
    protected void register(StubContext ctx) {
    }
}
