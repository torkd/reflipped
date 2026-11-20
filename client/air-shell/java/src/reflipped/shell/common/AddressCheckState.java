package reflipped.shell.common;

/** Rejects delayed address checks after an edit, a newer check, or leaving the page. */
public final class AddressCheckState {
    private int revision;
    private boolean closed;
    public synchronized void edit() { revision++; }
    public synchronized int start() { return ++revision; }
    public synchronized boolean accept(int attempt) { return !closed && revision == attempt; }
    public synchronized void close() { closed = true; revision++; }
}
