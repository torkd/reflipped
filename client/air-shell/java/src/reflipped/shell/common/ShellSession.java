package reflipped.shell.common;

import android.app.Activity;
import org.json.JSONObject;

/** Display hints from an authenticated device secret. The admin site always performs its own login/role check. */
public final class ShellSession {
    private static String origin = "";
    private static String admin;

    private ShellSession() { }

    public static synchronized void clear() { origin = ""; admin = null; }

    public static synchronized String adminUrl(Activity activity) {
        return origin.equals(ShellConfig.server(activity)) ? admin : null;
    }

    /** Call off the UI thread after login and immediately before opening the admin site. */
    public static void refresh(Activity activity) throws Exception {
        clear();
        String server = ShellConfig.server(activity);
        String secret = ShellConfig.prefs(activity).getString("portalToken", null);
        if (secret == null) secret = ShellConfig.deviceKey(activity);
        JSONObject reply = new JSONObject(PortalSignIn.post(server + "/shell/session", new JSONObject().put("whiteKey", secret)));
        String url = reply.isNull("adminUrl") ? null : reply.optString("adminUrl", null);
        String normalized = ServerIdentity.resourceAddress(url);
        synchronized (ShellSession.class) {
            if (!server.equals(ShellConfig.server(activity))) return;
            origin = server;
            admin = reply.optBoolean("isAdmin", false) && normalized != null ? normalized : null;
        }
    }
}
