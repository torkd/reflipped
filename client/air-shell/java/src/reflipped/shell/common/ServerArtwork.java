package reflipped.shell.common;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.BitmapDrawable;
import android.widget.ImageView;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.WeakHashMap;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Per-browser shared thumbnails: synchronous cache hits, one request per URL and stale-while-refresh. */
public final class ServerArtwork {
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(
            2, 2, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<Runnable>(50), new ThreadPoolExecutor.AbortPolicy());
    private final ArtworkCache<Bitmap> cache = new ArtworkCache<>(4 * 1024 * 1024, 32, 52, 30000, 100);
    private final Map<ImageView, Binding> bindings = new WeakHashMap<>();
    private final Map<ArtworkCache.Ticket, List<Delivery>> waiters = new LinkedHashMap<>();
    private boolean closed, draining;

    private static final class Binding {
        final ArtworkBinding guard = new ArtworkBinding();
        String url;
        long token;

        Binding(String url) {
            this.url = url;
            token = guard.bind(url);
        }
    }

    private static final class Delivery {
        final WeakReference<ImageView> image;
        final Binding binding;
        final long token;

        Delivery(ImageView image, Binding binding) {
            this.image = new WeakReference<>(image);
            this.binding = binding;
            token = binding.token;
        }
    }

    /** UI-thread only. A cached bitmap is applied before returning, without installing a placeholder first. */
    public void bind(Activity activity, ImageView image, String value, Drawable fallback) {
        if (closed) return;
        String url = ThumbnailPolicy.validate(value);
        Binding old = bindings.get(image);
        if (old != null && old.url.equals(url)) return;
        if (old != null) old.guard.close();
        for (List<Delivery> pending : waiters.values()) {
            java.util.Iterator<Delivery> iterator = pending.iterator();
            while (iterator.hasNext()) {
                ImageView target = iterator.next().image.get();
                if (target == null || target == image) iterator.remove();
            }
        }
        Binding binding = new Binding(url);
        bindings.put(image, binding);
        if (old != null && !hasBindings(old.url)) cache.forgetDeferred(old.url);
        if (url.isEmpty()) {
            image.setImageDrawable(fallback);
            return;
        }
        request(activity, image, binding, false, fallback);
    }

    /** Explicit Refresh only: keep current images visible while revalidating each shared URL once. */
    public void refresh(Activity activity, String value) {
        String url = ThumbnailPolicy.validate(value);
        if (closed || url.isEmpty()) return;
        for (Map.Entry<ImageView, Binding> entry : new ArrayList<>(bindings.entrySet())) {
            ImageView image = entry.getKey();
            if (image != null && entry.getValue().url.equals(url))
                request(activity, image, entry.getValue(), true, null);
        }
    }

    private void request(Activity activity, ImageView image, Binding binding, boolean refresh, Drawable fallback) {
        ArtworkCache.Request<Bitmap> request =
                cache.begin(binding.url, android.os.SystemClock.elapsedRealtime(), refresh);
        if (request.value != null)
            image.setImageBitmap(request.value);
        else if (fallback != null) {
            Drawable shown = image.getDrawable();
            Bitmap photo = shown instanceof BitmapDrawable ? ((BitmapDrawable) shown).getBitmap() : null;
            if (photo == null || photo.isRecycled()) image.setImageDrawable(fallback);
        }
        if (request.ticket == null) return;
        List<Delivery> pending = waiters.get(request.ticket);
        if (pending == null) {
            pending = new ArrayList<>();
            waiters.put(request.ticket, pending);
        }
        boolean exists = false;
        for (Delivery delivery : pending)
            if (delivery.image.get() == image && delivery.binding == binding) exists = true;
        if (!exists) pending.add(new Delivery(image, binding));
        if (!request.start) return;
        try {
            worker.execute(() -> {
                Bitmap bitmap = fetch(binding.url);
                activity.runOnUiThread(() -> finish(activity, binding.url, request.ticket, bitmap));
            });
        } catch (java.util.concurrent.RejectedExecutionException full) {
            finish(activity, binding.url, request.ticket, null);
        }
    }

    private void finish(Activity activity, String url, ArtworkCache.Ticket ticket, Bitmap bitmap) {
        List<Delivery> pending = waiters.remove(ticket);
        if (!cache.complete(url, ticket, bitmap, bitmap == null ? 0 : bitmap.getAllocationByteCount(),
                    android.os.SystemClock.elapsedRealtime()))
            return;
        if (!closed && bitmap != null && pending != null)
            for (Delivery delivery : pending) {
                ImageView image = delivery.image.get();
                if (image != null && bindings.get(image) == delivery.binding
                        && delivery.binding.guard.accepts(url, delivery.token))
                    image.setImageBitmap(bitmap);
            }
        drain(activity);
    }

    private boolean hasBindings(String url) {
        for (Binding binding : bindings.values())
            if (binding.url.equals(url)) return true;
        return false;
    }

    public void unbind(ImageView image) {
        Binding binding = bindings.remove(image);
        if (binding == null) return;
        binding.guard.close();
        for (List<Delivery> pending : waiters.values()) {
            java.util.Iterator<Delivery> iterator = pending.iterator();
            while (iterator.hasNext()) {
                ImageView target = iterator.next().image.get();
                if (target == null || target == image) iterator.remove();
            }
        }
        if (!hasBindings(binding.url)) cache.forgetDeferred(binding.url);
    }

    private void drain(Activity activity) {
        if (closed || draining) return;
        draining = true;
        try {
            ArtworkCache.Deferred next;
            while ((next = cache.takeDeferred()) != null) {
                for (Map.Entry<ImageView, Binding> entry : new ArrayList<>(bindings.entrySet())) {
                    ImageView image = entry.getKey();
                    if (image != null && entry.getValue().url.equals(next.key))
                        request(activity, image, entry.getValue(), next.refresh, null);
                }
            }
        } finally {
            draining = false;
        }
    }

    private Bitmap fetch(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(4000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Cookie", "");
            connection.setRequestProperty("Authorization", "");
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
            if (connection.getResponseCode() != 200 || connection.getContentLength() > ThumbnailPolicy.MAX_BYTES)
                return null;
            byte[] data;
            try (InputStream input = connection.getInputStream()) {
                data = ArtworkBody.read(input, deadline);
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth > 8192 || bounds.outHeight > 8192)
                return null;
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / options.inSampleSize > 256) options.inSampleSize *= 2;
            return BitmapFactory.decodeByteArray(data, 0, data.length, options);
        } catch (Exception ignored) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    public void close() {
        closed = true;
        for (Binding binding : bindings.values()) binding.guard.close();
        bindings.clear();
        waiters.clear();
        cache.close();
        worker.shutdownNow();
    }
}
