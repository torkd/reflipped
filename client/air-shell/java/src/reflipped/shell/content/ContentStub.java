package reflipped.shell.content;

import android.util.Log;

import com.adobe.fre.FREByteArray;
import com.adobe.fre.FREObject;

import java.nio.ByteBuffer;

import reflipped.shell.common.Args;
import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/**
 * `reflipped.content`: our own extension in the import build (build.py --content import), called by the loader SWF
 * (loader/ReflippedLoader.as), never by the game.
 * <ul>
 *   <li>`prepare(storagePath, reason)`: gets the imported game ready ({@link ImportFlow}), then sends the StatusEvent
 *       "ready" with the patched SWF's path as its level. `reason` is "start", or "damaged"/"unreadable" when the
 *       loader couldn't use the files it was given.</li>
 *   <li>`verify(bytes)`: true if `bytes` (the SWF the loader is about to run) is exactly the patched SWF this APK's
 *       op list makes (size and SHA-256).</li>
 *   <li>`started()`: the game SWF is loaded; closes the import screens.</li>
 *   <li>`log(text)`: a line for logcat (the loader's timings and the game's uncaught errors).</li>
 * </ul>
 */
public class ContentStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "reflipped.content";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.on("prepare", (c, a) -> {
            ImportFlow.start(c, Args.str(a, 0), Args.str(a, 1));
            return null;
        });
        ctx.on("verify", (c, a) -> verify(c, a.length > 0 ? a[0] : null));
        ctx.on("started", (c, a) -> {
            ImportFlow.started();
            return null;
        });
        ctx.on("log", (c, a) -> {
            Log.i(StubContext.TAG, "loader: " + Args.str(a, 0));
            return null;
        });
    }

    private static Boolean verify(StubContext ctx, FREObject argument) throws Exception {
        if (!(argument instanceof FREByteArray)) return false;
        ImportManifest manifest = ImportFlow.manifest(ctx.getActivity());
        FREByteArray bytes = (FREByteArray) argument;
        long started = System.nanoTime();
        bytes.acquire();
        String hash;
        long length;
        try {
            length = bytes.getLength();
            ByteBuffer data = bytes.getBytes();
            hash = length == manifest.outputSize ? Hashes.hex(Hashes.sha256(data)) : "";
        } finally {
            bytes.release();
        }
        boolean ok = length == manifest.outputSize && hash.equals(manifest.outputSha256);
        Log.i(StubContext.TAG, "game SWF check: " + (ok ? "ok" : "MISMATCH") + ", " + length + " B in "
                + (System.nanoTime() - started) / 1000000 + " ms");
        return ok;
    }
}
