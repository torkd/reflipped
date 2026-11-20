package reflipped.shell.common;

/** Holder identity prevents a late old-URL completion from replacing a newer image. */
public final class ArtworkBinding {
    private String url = "";
    private long revision;
    private boolean closed;

    public long bind(String value) {
        url = value;
        return ++revision;
    }

    public boolean accepts(String value, long token) {
        return !closed && revision == token && url.equals(value);
    }

    public void close() {
        closed = true;
        revision++;
    }
}
