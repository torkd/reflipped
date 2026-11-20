package reflipped.shell.common;

public final class ThumbnailPolicyTest {
    public static void main(String[] args) throws Exception {
        for (String valid : new String[]{"https://example.org/image.png?width=192", "http://10.0.2.2:8302/thumbnail.png"})
            if (!valid.equals(ThumbnailPolicy.validate(valid))) throw new AssertionError("Rejected public artwork");
        for (String invalid : new String[]{"file:///private/image", "javascript:alert(1)", "https://user:secret@example.org/image", "https://example.org/image#", "https://example.org/im age", "http://example.org:0/image", "http://example.org:99999/image"})
            if (!ThumbnailPolicy.validate(invalid).isEmpty()) throw new AssertionError("Accepted unsafe artwork");
        if (!ThumbnailPolicy.validate(null).isEmpty()) throw new AssertionError("Null is optional");
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(2);
        if (ArtworkBody.read(new java.io.ByteArrayInputStream(new byte[ThumbnailPolicy.MAX_BYTES]), deadline).length != ThumbnailPolicy.MAX_BYTES) throw new AssertionError();
        for (boolean oversized : new boolean[]{true, false}) {
            try {
                ArtworkBody.read(new java.io.ByteArrayInputStream(new byte[oversized ? ThumbnailPolicy.MAX_BYTES + 1 : 1]), oversized ? deadline : 0);
                throw new AssertionError("Untrusted artwork bound not enforced");
            } catch (java.io.IOException expected) { }
        }
        System.out.println("Optional public artwork URL policy checks passed");
    }
}
