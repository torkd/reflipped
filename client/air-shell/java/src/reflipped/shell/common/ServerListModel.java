package reflipped.shell.common;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.HashSet;
import java.util.Set;

/** Pure public-bookmark rules. No credentials, account selection, networking or downloaded-file state. */
public final class ServerListModel<T> {
    public static final int MAX_SERVERS = 50;
    public static final class Row<T> {
        public final String address, nickname;
        public final T metadata;
        public Row(String address, String nickname, T metadata) {
            this.address = canonical(address);
            this.nickname = nickname(nickname);
            if (metadata == null) throw new IllegalArgumentException("Missing server information.");
            this.metadata = metadata;
        }
    }
    public static final class Duplicate extends IllegalArgumentException {
        public final String address;
        Duplicate(String address) { super("That server is already in My servers."); this.address = address; }
    }
    public static final class Full extends IllegalArgumentException {
        Full() { super("My servers is full. You can still join without saving, or remove a saved server first (50 maximum)."); }
    }
    private final List<Row<T>> rows = new ArrayList<>();
    public ServerListModel(List<Row<T>> initial) {
        for (Row<T> row : initial) if (rows.size() < MAX_SERVERS && find(row.address) < 0) rows.add(row);
    }
    public List<Row<T>> rows() { return new ArrayList<>(rows); }
    public Row<T> save(String previousAddress, String nickname, String address, T metadata) {
        Row<T> next = new Row<>(address, nickname, metadata);
        boolean edit = previousAddress != null && !previousAddress.trim().isEmpty();
        int previous = edit ? find(canonical(previousAddress)) : -1;
        if (edit && previous < 0) throw new IllegalArgumentException("This server is no longer in My servers.");
        int duplicate = find(next.address);
        if (duplicate >= 0 && duplicate != previous) throw new Duplicate(rows.get(duplicate).address);
        if (edit) rows.set(previous, next);
        else {
            if (rows.size() >= MAX_SERVERS) throw new Full();
            rows.add(next);
        }
        return next;
    }
    /** Reclaim only a redundant provided-origin bookmark, after normal input and collision checks pass. */
    public Row<T> saveCustom(String previousAddress, String nickname, String address, T metadata, Iterable<String> provided) {
        try { return save(previousAddress, nickname, address, metadata); }
        catch (Full full) {
            Set<String> trusted = new HashSet<>();
            if (provided != null) for (String origin : provided) {
                try { trusted.add(canonical(origin)); } catch (IllegalArgumentException invalidProvided) { }
            }
            if (trusted.contains(canonical(address))) throw full;
            List<Row<T>> candidate = rows();
            int redundant = -1;
            for (int i = 0; i < candidate.size(); i++) if (trusted.contains(candidate.get(i).address)) { redundant = i; break; }
            if (redundant < 0) throw full;
            candidate.remove(redundant);
            ServerListModel<T> replacement = new ServerListModel<>(candidate);
            Row<T> saved = replacement.save(previousAddress, nickname, address, metadata);
            rows.clear(); rows.addAll(replacement.rows());
            return saved;
        }
    }
    public boolean remove(String address) {
        int index = find(canonical(address));
        if (index < 0) return false;
        rows.remove(index);
        return true;
    }
    public boolean updateMetadata(String address, T metadata) {
        int index = find(canonical(address));
        if (index < 0) return false;
        Row<T> previous = rows.get(index);
        rows.set(index, new Row<>(previous.address, previous.nickname, metadata));
        return true;
    }
    private int find(String address) {
        for (int i = 0; i < rows.size(); i++) if (rows.get(i).address.equals(address)) return i;
        return -1;
    }
    public static String canonical(String address) {
        try {
            URI input = new URI(address);
            String path = input.getRawPath();
            String scheme = input.getScheme() == null ? "" : input.getScheme().toLowerCase(Locale.ROOT);
            if (!(scheme.equals("http") || scheme.equals("https")) || input.getHost() == null
                    || input.getRawUserInfo() != null || input.getRawQuery() != null || input.getRawFragment() != null
                    || address.length() > 2048 || (path != null && !path.isEmpty() && !path.equals("/"))
                    || input.getPort() == 0 || input.getPort() > 65535 || input.getRawAuthority() == null
                    || input.getRawAuthority().endsWith(":")) throw new IllegalArgumentException("Invalid server address.");
            int port = input.getPort();
            if ((port == 80 && scheme.equals("http")) || (port == 443 && scheme.equals("https"))) port = -1;
            return new URI(scheme, null, input.getHost().toLowerCase(Locale.ROOT), port, null, null, null).toString();
        } catch (Exception invalid) { throw new IllegalArgumentException("Use the server's HTTP or HTTPS address without a path, password, query or fragment."); }
    }
    /** Untrusted display information must never prevent a valid address being saved or joined. */
    public static String publicText(String value, int max) {
        StringBuilder clean = new StringBuilder();
        if (value != null) for (char c : value.toCharArray())
            clean.append(c < 32 || (c >= 127 && c <= 159) || c == 0x2028 || c == 0x2029 ? ' ' : c);
        String text = clean.toString().trim();
        if (text.length() > max) {
            text = text.substring(0, max);
            if (!text.isEmpty() && Character.isHighSurrogate(text.charAt(text.length() - 1)))
                text = text.substring(0, text.length() - 1);
        }
        return text;
    }
    private static String nickname(String value) {
        value = value == null ? "" : value.trim();
        if (value.length() > 64 || value.matches("(?s).*[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029].*"))
            throw new IllegalArgumentException("A nickname may have up to 64 characters on one line.");
        return value;
    }
}
