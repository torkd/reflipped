package reflipped.shell.common;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** Bounds untrusted compressed artwork before bitmap inspection or allocation. */
public final class ArtworkBody {
    private ArtworkBody() { }
    public static byte[] read(InputStream input, long deadline) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096]; int count;
        while ((count = input.read(buffer)) != -1) {
            if (Thread.currentThread().isInterrupted() || System.nanoTime() > deadline
                    || bytes.size() + count > ThumbnailPolicy.MAX_BYTES) throw new IOException("Artwork limit exceeded");
            bytes.write(buffer, 0, count);
        }
        return bytes.toByteArray();
    }
}
