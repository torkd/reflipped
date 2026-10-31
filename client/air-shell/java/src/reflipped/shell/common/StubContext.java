package reflipped.shell.common;

import android.util.Log;

import com.adobe.fre.FREContext;
import com.adobe.fre.FREFunction;
import com.adobe.fre.FREObject;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * An ANE context whose functions are plain Java lambdas.
 *
 * Every call is logged under the tag {@value #TAG} with its arguments and return value, so a
 * device run (`adb logcat -s ReflippedShell`) shows exactly what the game asks for. Functions
 * registered with {@link #noop} only log and return null.
 */
public class StubContext extends FREContext {
    public static final String TAG = "ReflippedShell";

    public interface Handler {
        Object call(StubContext ctx, FREObject[] args) throws Exception;
    }

    private final String extension;
    private final Map<String, Handler> handlers = new LinkedHashMap<>();

    /** Last JSON result for SDKs that answer async calls through a GETLASTRESULT call. */
    public volatile String lastResult = "{\"isSuccess\":\"true\"}";

    private Runnable onDispose;

    public StubContext(String extension) {
        this.extension = extension;
    }

    public String extension() {
        return extension;
    }

    public StubContext on(String name, Handler handler) {
        handlers.put(name, handler);
        return this;
    }

    /** Runs when AIR disposes this context (stop receivers or threads started by a handler). */
    public StubContext onDispose(Runnable cleanup) {
        onDispose = cleanup;
        return this;
    }

    public boolean has(String name) {
        return handlers.containsKey(name);
    }

    public StubContext noop(String... names) {
        for (String name : names) handlers.put(name, (ctx, args) -> null);
        return this;
    }

    /** Returns a fixed value for each of the given names. */
    public StubContext constant(Object value, String... names) {
        for (String name : names) handlers.put(name, (ctx, args) -> value);
        return this;
    }

    /** Sets {@link #lastResult} and fires the StatusEvent the AS3 wrapper waits for (code = call name). */
    public void complete(String code, String resultJson) {
        lastResult = resultJson;
        Log.i(TAG, extension + " <- event " + code + " result=" + resultJson);
        dispatchStatusEventAsync(code, "");
    }

    @Override
    public Map<String, FREFunction> getFunctions() {
        Map<String, FREFunction> out = new HashMap<>();
        for (Map.Entry<String, Handler> e : handlers.entrySet()) {
            final String name = e.getKey();
            final Handler handler = e.getValue();
            out.put(name, (ctx, args) -> invoke(name, handler, args));
        }
        return out;
    }

    private FREObject invoke(String name, Handler handler, FREObject[] args) {
        StringBuilder line = new StringBuilder(extension).append('.').append(name).append('(');
        for (int i = 0; args != null && i < args.length; i++) {
            if (i > 0) line.append(", ");
            line.append(Args.describe(args[i]));
        }
        line.append(')');
        try {
            Object result = handler.call(this, args == null ? new FREObject[0] : args);
            Log.i(TAG, line + " -> " + (result instanceof String ? "\"" + result + "\"" : result));
            return Args.toFre(result);
        } catch (Throwable t) {
            Log.e(TAG, line + " threw", t);
            return null;
        }
    }

    @Override
    public void dispose() {
        Log.i(TAG, extension + " context disposed");
        if (onDispose != null) onDispose.run();
    }
}
