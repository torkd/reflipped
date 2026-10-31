package reflipped.shell.other;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/** `com.distriqt.Core`: declared in the original descriptor, but the SWF never opens a context for it (docs/air-shell.md). */
public class DistriqtCoreStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.distriqt.Core";
    }

    @Override
    protected void register(StubContext ctx) {
    }
}
