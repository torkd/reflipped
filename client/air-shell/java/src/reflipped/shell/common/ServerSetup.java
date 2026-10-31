package reflipped.shell.common;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.text.InputType;
import android.util.Log;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.LinearLayout;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;

/**
 * Finds out which Reflipped server to talk to when the build didn't fix one (`build.py --server`),
 * with native dialogs over the game. Everything here blocks, so call it from a background thread
 * (the Kakao stub's async calls already run on one); never from the AIR runtime thread.
 *
 * The first launch asks for an address and accepts it only if `<address>/shell/config` answers
 * `{"reflipped": 1}` (src/routes/shell.ts). That reply also names an optional CDN, which is stored
 * and refreshed on every launch so a server can move its CDN without a rebuild.
 */
public final class ServerSetup {
    private static final String EXAMPLE = "http://192.168.1.10:8000";

    private ServerSetup() {
    }

    /** Returns the server to use, asking the player first if none is known yet. */
    public static String ensureServer(Activity activity) throws Exception {
        String known = ShellConfig.server(activity);
        if (!known.isEmpty()) {
            refreshConfig(activity, known);
            return known;
        }
        String initial = "";
        String error = null;
        while (true) {
            String typed = promptAddress(activity, initial, error);
            String server = normalize(typed);
            initial = typed;
            if (server == null) {
                error = "That is not an http:// or https:// address.";
                continue;
            }
            try {
                ShellConfig.setServer(activity, server, cdnOf(fetchConfig(server)));
                return server;
            } catch (Exception e) {
                Log.w(StubContext.TAG, "no Reflipped server at " + server, e);
                error = "No Reflipped server at that address.";
            }
        }
    }

    /**
     * Tells the player the server didn't answer and waits for the choice. Returns to retry; a build with
     * a baked server only offers Retry, otherwise "Change server" forgets the address so the next
     * {@link #ensureServer} asks again.
     */
    public static void unreachable(Activity activity, String server) throws Exception {
        boolean retry = choose(activity, "Can't reach " + server,
                "Check that the server is running and the phone can reach it.", "Retry",
                ShellConfig.serverIsBaked(activity) ? null : "Change server");
        if (!retry) ShellConfig.clearServer(activity);
    }

    /** Trims, defaults the scheme to https and drops trailing slashes; null unless it is an http(s) URL with a host. */
    public static String normalize(String text) {
        if (text == null) return null;
        String s = text.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) s = "https://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        try {
            URI uri = new URI(s);
            String scheme = uri.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return null;
            if (uri.getHost() == null || uri.getHost().isEmpty()) return null;
            if (uri.getRawQuery() != null || uri.getRawFragment() != null) return null;
            return s;
        } catch (URISyntaxException e) {
            return null;
        }
    }

    /** Best effort at every launch: keep the stored CDN when the server doesn't answer. */
    private static void refreshConfig(Activity activity, String server) {
        try {
            ShellConfig.setServerCdn(activity, cdnOf(fetchConfig(server)));
        } catch (Exception e) {
            Log.w(StubContext.TAG, "shell config refresh failed, keeping the stored CDN", e);
        }
    }

    /** GET <server>/shell/config; throws unless the reply is a Reflipped one. */
    private static JSONObject fetchConfig(String server) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(server + "/shell/config").openConnection();
        conn.setConnectTimeout(5000);
        conn.setReadTimeout(5000);
        int status = conn.getResponseCode();
        if (status != 200) throw new IllegalStateException("HTTP " + status);
        JSONObject json = new JSONObject(read(conn.getInputStream()));
        if (json.optInt("reflipped", 0) != 1) throw new IllegalStateException("not a Reflipped reply");
        Log.i(StubContext.TAG, "server " + server + " is Reflipped \"" + json.optString("name") + "\"");
        return json;
    }

    /** The reply's CDN base URL without a trailing slash, "" when it names none or something other than http(s). */
    private static String cdnOf(JSONObject config) {
        String cdn = config.isNull("cdn") ? "" : config.optString("cdn", "").trim();
        while (cdn.endsWith("/")) cdn = cdn.substring(0, cdn.length() - 1);
        return cdn.startsWith("http://") || cdn.startsWith("https://") ? cdn : "";
    }

    /** Reads at most 64 KB: the reply comes from an address the player typed. */
    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        try {
            for (int n; (n = in.read(chunk)) > 0; ) {
                buf.write(chunk, 0, n);
                if (buf.size() > 65536) throw new IllegalStateException("reply too large");
            }
        } finally {
            in.close();
        }
        return buf.toString("UTF-8");
    }

    // ---------------------------------------------------------------- dialogs (shown on the UI thread, awaited here)

    private static String promptAddress(final Activity activity, final String initial, final String error) throws Exception {
        final BlockingQueue<String[]> answer = new ArrayBlockingQueue<>(1);
        activity.runOnUiThread(() -> {
            try {
                final EditText input = new EditText(activity);
                input.setSingleLine(true);
                input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
                input.setHint(EXAMPLE);
                input.setText(initial);
                LinearLayout box = new LinearLayout(activity);
                int pad = (int) (20 * activity.getResources().getDisplayMetrics().density);
                box.setPadding(pad, 0, pad, 0);
                box.addView(input, new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
                String message = "Address of your Reflipped server, e.g. " + EXAMPLE + " or https://wf.example.org";
                new AlertDialog.Builder(activity)
                        .setTitle("Server address")
                        .setMessage(error == null ? message : error + "\n\n" + message)
                        .setView(box)
                        .setCancelable(false)
                        .setPositiveButton("Connect", (d, w) -> {
                            // the keyboard outlives the dialog otherwise and covers the game's first prompts
                            InputMethodManager ime = (InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE);
                            if (ime != null) ime.hideSoftInputFromWindow(input.getWindowToken(), 0);
                            answer.offer(new String[]{input.getText().toString()});
                        })
                        .show();
            } catch (Throwable t) {
                Log.e(StubContext.TAG, "can't show the server dialog", t);
                answer.offer(new String[]{null});
            }
        });
        String typed = answer.take()[0];
        if (typed == null) throw new IllegalStateException("no window to ask for the server address");
        return typed;
    }

    /** Shows a two-button dialog (one button when `negative` is null); true for the positive one. */
    private static boolean choose(final Activity activity, final String title, final String message,
                                  final String positive, final String negative) throws Exception {
        final BlockingQueue<Object> answer = new ArrayBlockingQueue<>(1);
        activity.runOnUiThread(() -> {
            try {
                AlertDialog.Builder builder = new AlertDialog.Builder(activity)
                        .setTitle(title)
                        .setMessage(message)
                        .setCancelable(false)
                        .setPositiveButton(positive, (d, w) -> answer.offer(true));
                if (negative != null) builder.setNegativeButton(negative, (d, w) -> answer.offer(false));
                builder.show();
            } catch (Throwable t) {
                Log.e(StubContext.TAG, "can't show the dialog", t);
                answer.offer(t);
            }
        });
        Object result = answer.take();
        if (result instanceof Throwable) throw new IllegalStateException("no window to show the dialog", (Throwable) result);
        return (Boolean) result;
    }
}
