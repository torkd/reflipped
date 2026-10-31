package reflipped.shell.other;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/** `com.distriqt.Application`: declared in the original descriptor, but the SWF never opens a context for it (docs/air-shell.md). */
public class DistriqtApplicationStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.distriqt.Application";
    }

    @Override
    protected void register(StubContext ctx) {
    }
}
