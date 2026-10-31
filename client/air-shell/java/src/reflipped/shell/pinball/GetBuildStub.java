package reflipped.shell.pinball;

import android.os.Build;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/** `pinball.ane.getbuild`: device model and Android version. */
public class GetBuildStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "pinball.ane.getbuild";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.on("getModel", (c, a) -> Build.MODEL);
        ctx.on("getVersionRelease", (c, a) -> Build.VERSION.RELEASE);
    }
}
