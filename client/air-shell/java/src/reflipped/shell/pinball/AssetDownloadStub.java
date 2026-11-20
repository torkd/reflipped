package reflipped.shell.pinball;

import com.adobe.fre.FREArray;
import com.adobe.fre.FREObject;

import java.util.ArrayList;
import java.util.List;

import reflipped.shell.common.Args;
import reflipped.shell.common.NotificationPermission;
import reflipped.shell.common.ShellConfig;
import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;
import reflipped.shell.service.DownloadService;

/**
 * `pinball.assetDownload`: downloads and extracts the asset archives listed by `asset/get_path`.
 *
 * startDownload(archives, downloadDir, partialFile): `archives` is an Array of {location, size}
 * (full archives first, then each diff version in order); the work happens in {@link AssetDownloader}.
 * The wrapper listens for StatusEvents `progress` (then calls getProgressRatio), `completed` (level =
 * latest archive Last-Modified), `error`, `ioError`, `timeout` and `cancel`. See docs/air-shell.md.
 *
 * While a download runs, {@link DownloadService} (SH-7) keeps it going with the app in the background and shows its
 * progress, titled with the texts the game passes to setMessageTexts.
 */
public class AssetDownloadStub extends StubExtension {
    private AssetDownloader current;
    private int idleTimeoutMsec = 30000;
    private int totalTimeoutMsec = 60000;
    private String debugOauthKey = "";
    /** The app's context for the service: the activity can be gone while the download goes on in the background. */
    private volatile android.content.Context app;

    @Override
    protected String extensionId() {
        return "pinball.assetDownload";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.on("startDownload", (c, a) -> {
            List<AssetDownloader.Archive> archives = archives(c, a.length > 0 ? a[0] : null);
            String dir = Args.str(a, 1);
            String partial = Args.str(a, 2);
            app = c.getActivity().getApplicationContext();
            AssetDownloader started;
            synchronized (this) {
                if (current != null) current.cancel();
                started = new AssetDownloader(c, archives, dir, partial, idleTimeoutMsec, totalTimeoutMsec, debugOauthKey);
                current = started;
                started.setListener(completed -> ended(started, completed));
            }
            DownloadService.begin(app, started::progressRatio, null, started::cancel);
            started.start();
            NotificationPermission.askOnce(c.getActivity());
            return 0;
        });
        ctx.on("getProgressRatio", (c, a) -> {
            AssetDownloader d = current;
            return d == null ? 0.0 : d.progressRatio();
        });
        ctx.on("finishDownload", (c, a) -> {
            synchronized (this) {
                if (current != null) current.cancel();
                current = null;
            }
            end(false);
            return 0;
        });
        ctx.on("setTimeout", (c, a) -> {
            idleTimeoutMsec = Args.integer(a, 0, idleTimeoutMsec);
            totalTimeoutMsec = Args.integer(a, 1, totalTimeoutMsec);
            return 0;
        });
        ctx.on("setDebugOauthKey", (c, a) -> {
            String key = Args.str(a, 0);
            debugOauthKey = key == null ? "" : key;
            return 0;
        });
        // {downloadChannelName, downloadTitle, downloadOnGoing, downloadCompleted}: the game's own (translated) texts
        ctx.on("setMessageTexts", (c, a) -> {
            FREObject texts = a.length > 0 ? a[0] : null;
            DownloadService.texts(new DownloadService.Texts(property(texts, "downloadTitle"),
                    property(texts, "downloadOnGoing"), property(texts, "downloadCompleted")));
            return 0;
        });
        ctx.onDispose(() -> {
            synchronized (this) {
                if (current != null) current.cancel();
                current = null;
            }
            end(false);
        });
    }

    /** A run ended: stop the service, unless a newer startDownload replaced that run (its service carries on). */
    private void ended(AssetDownloader run, boolean completed) {
        synchronized (this) {
            if (current != run) return;
        }
        end(completed);
    }

    private void end(boolean completed) {
        if (app != null) DownloadService.end(app, completed);
    }

    private static String property(FREObject object, String name) {
        try {
            FREObject value = object == null ? null : object.getProperty(name);
            return value == null ? null : value.getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    /** Reads the AS3 archive list on the calling (runtime) thread; FREObjects can't leave it. */
    private static List<AssetDownloader.Archive> archives(StubContext ctx, FREObject list) throws Exception {
        List<AssetDownloader.Archive> out = new ArrayList<>();
        if (!(list instanceof FREArray)) return out;
        FREArray array = (FREArray) list;
        String cdn = ShellConfig.cdn(ctx.getActivity());
        for (long i = 0, n = array.getLength(); i < n; i++) {
            FREObject item = array.getObjectAt(i);
            String location = item.getProperty("location").getAsString().replace("{$cdnAddress}", cdn);
            long size = (long) item.getProperty("size").getAsDouble();
            out.add(new AssetDownloader.Archive(location, size));
        }
        return out;
    }
}
