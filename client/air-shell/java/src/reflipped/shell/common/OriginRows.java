package reflipped.shell.common;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/** Canonical origins identify rows; a successful probe replaces suggested/stored display information. */
public final class OriginRows {
    public interface Address<T> { String of(T value); }
    private OriginRows() { }
    public static <T> List<T> updated(List<T> rows, T latest, Address<T> address) {
        LinkedHashMap<String, T> unique = new LinkedHashMap<>();
        String current = latest == null ? "" : ServerIdentity.origin(address.of(latest));
        for (T row : rows) {
            String origin = ServerIdentity.origin(address.of(row));
            if (!origin.isEmpty() && !unique.containsKey(origin)) unique.put(origin, origin.equals(current) ? latest : row);
        }
        if (!current.isEmpty()) unique.put(current, latest);
        return new ArrayList<>(unique.values());
    }
}
