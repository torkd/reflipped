package reflipped.shell.common;

import android.util.Log;

import com.adobe.fre.FREContext;
import com.adobe.fre.FREExtension;

/**
 * Base initializer: subclasses name the extension and register its functions.
 *
 * A name the context doesn't register throws Error #3500 in ActionScript. The game calls the Sesisoft and pinball
 * functions itself, so their stubs list every name it uses; the other extensions are called through our own
 * ActionScript libraries (as3/), which catch that error and answer null, as a no-op would.
 */
public abstract class StubExtension implements FREExtension {
    protected abstract String extensionId();

    protected abstract void register(StubContext ctx);

    @Override
    public void initialize() {
        Log.i(StubContext.TAG, extensionId() + " initialized");
    }

    @Override
    public FREContext createContext(String contextType) {
        Log.i(StubContext.TAG, extensionId() + " createContext");
        StubContext ctx = new StubContext(extensionId());
        register(ctx);
        return ctx;
    }

    @Override
    public void dispose() {
    }
}
