package reflipped.shell.other;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.text.TextUtils;
import android.util.Log;

import com.adobe.fre.FREArray;
import com.adobe.fre.FREObject;

import java.util.ArrayList;
import java.util.List;

import reflipped.shell.common.Args;
import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/**
 * `com.digitalstrawberry.ane.share`: the Share button of the co-op room (its invitation text with the room link) and of
 * the profile (the follow link) opens Android's share sheet.
 *
 * The ANE's own AS3 wrapper (`Share`) calls `isSupported` (share does nothing unless it is true), `setTitle(String)`
 * with the "share_title" text, then `share(Vector.<SharedData>, ShareOptions)`. Each SharedData's `data` is a String or
 * a BitmapData; the game only shares text. The wrapper turns the StatusEvent codes `ShareEvent::complete`, `::cancel`
 * and `::error` (level: the chosen activity or the error) into ShareEvents, which the game doesn't listen to.
 */
public class ShareStub extends StubExtension {
    static final String COMPLETE = "ShareEvent::complete";
    static final String ERROR = "ShareEvent::error";

    /** The share sheet's title, from the last setTitle. */
    private static volatile String title = null;

    @Override
    protected String extensionId() {
        return "com.digitalstrawberry.ane.share";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.constant(true, "isSupported");
        ctx.on("setTitle", (c, a) -> {
            title = Args.str(a, 0);
            return null;
        });
        ctx.on("share", (c, a) -> {
            // FREObjects can only be read on the calling (runtime) thread
            List<String> texts = texts(a.length > 0 ? a[0] : null);
            String mimeType = mimeType(a.length > 1 ? a[1] : null);
            share(c, texts, mimeType);
            return null;
        });
    }

    /** The String items of the shared Vector; BitmapData items are skipped. */
    private static List<String> texts(FREObject data) throws Exception {
        List<String> out = new ArrayList<>();
        if (!(data instanceof FREArray)) return out;
        FREArray items = (FREArray) data;
        for (long i = 0, n = items.getLength(); i < n; i++) {
            FREObject item = items.getObjectAt(i);
            if (item == null) continue;
            try {
                String text = item.getProperty("data").getAsString();
                if (text != null && !text.isEmpty()) out.add(text);
            } catch (Exception notText) {
                Log.i(StubContext.TAG, "share: item " + i + " isn't text, skipped");
            }
        }
        return out;
    }

    private static String mimeType(FREObject options) {
        if (options == null) return "text/plain";
        try {
            String type = options.getProperty("mimeType").getAsString();
            return type == null || type.isEmpty() ? "text/plain" : type;
        } catch (Exception unset) {
            return "text/plain";
        }
    }

    private static void share(StubContext ctx, List<String> texts, String mimeType) {
        if (texts.isEmpty()) {
            ctx.dispatchStatusEventAsync(ERROR, "Nothing to share");
            return;
        }
        String text = TextUtils.join("\n", texts); // String.join needs API 26
        String sheetTitle = title;
        Activity activity = ctx.getActivity();
        activity.runOnUiThread(() -> {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mimeType.startsWith("text/") ? mimeType : "text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            if (sheetTitle != null && !sheetTitle.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, sheetTitle);
            try {
                activity.startActivity(Intent.createChooser(send, sheetTitle));
                // the plain chooser reports no choice back; the game doesn't wait for one
                ctx.dispatchStatusEventAsync(COMPLETE, "");
            } catch (ActivityNotFoundException e) {
                Log.w(StubContext.TAG, "share: no app can share text", e);
                ctx.dispatchStatusEventAsync(ERROR, "No app can share this");
            }
        });
    }
}
