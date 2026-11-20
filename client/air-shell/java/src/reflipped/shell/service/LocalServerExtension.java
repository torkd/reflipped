package reflipped.shell.service;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/**
 * The initializer of the {@code reflipped.localserver} extension. The game never opens it: the extension only carries
 * the server's native libraries (its {@code libs/<abi>/}, which land in the APK's {@code lib/<abi>/}) and this package's
 * classes ({@link ServerService}, {@link LocalServer}), which the Kakao stub calls directly.
 */
public class LocalServerExtension extends StubExtension {
    static final String ID = "reflipped.localserver";

    @Override
    protected String extensionId() {
        return ID;
    }

    @Override
    protected void register(StubContext ctx) {
    }
}
