package reflipped.shell.common;

import android.util.Log;

import com.adobe.fre.FREContext;
import com.adobe.fre.FREExtension;

/** Base initializer: subclasses name the extension and register its functions. */
public abstract class StubExtension implements FREExtension {
    protected abstract String extensionId();

    protected abstract void register(StubContext ctx);

    @Override
    public void initialize() {
        Log.i(StubContext.TAG, extensionId() + " initialized");
    }

    @Override
    public FREContext createContext(String contextType) {
        Log.i(StubContext.TAG, extensionId() + " createContext(\"" + contextType + "\")");
        StubContext ctx = new StubContext(extensionId());
        register(ctx);
        // Every other function the original AS3 wrapper may call: log and return null.
        for (String name : KnownFunctions.forExtension(extensionId())) {
            if (!ctx.has(name)) ctx.noop(name);
        }
        return ctx;
    }

    @Override
    public void dispose() {
    }
}
