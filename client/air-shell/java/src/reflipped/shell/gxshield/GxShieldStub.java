package reflipped.shell.gxshield;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/**
 * Replaces the GxShield ANE (`com.sesisoft.gxshield`). The game polls GXSHIELD_GET_DETECTED every
 * 20 frames and force-quits on certain detection codes; null means "nothing detected".
 */
public class GxShieldStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.sesisoft.gxshield";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.noop("GXSHIELD_GET_DETECTED");
    }
}
