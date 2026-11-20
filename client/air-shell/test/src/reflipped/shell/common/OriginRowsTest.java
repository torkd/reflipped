package reflipped.shell.common;

import java.util.Arrays;
import java.util.List;

public final class OriginRowsTest {
    private static final class Row {
        final String address, name;
        Row(String address, String name) { this.address = address; this.name = name; }
    }
    public static void main(String[] args) {
        Row saved = new Row("http://EXAMPLE.org:80/", "Old saved name");
        Row catalog = new Row("http://example.org", "Catalogue name");
        Row other = new Row("https://other.example", "Other server");
        Row live = new Row("http://example.org/", "Owner's current name");
        List<Row> source = Arrays.asList(saved, catalog, other);
        List<Row> rows = OriginRows.updated(source, live, row -> row.address);
        if (rows.size() != 2 || rows.get(0) != live || rows.get(1) != other) throw new AssertionError("Alias duplicated or live metadata lost");
        if (source.get(0) != saved) throw new AssertionError("Probe mutated persisted input");
        if (OriginRows.updated(source, null, row -> row.address).size() != 2) throw new AssertionError("Initial aliases not deduplicated");
        Row manual = new Row("https://new.example", "Manual server");
        if (OriginRows.updated(rows, manual, row -> row.address).size() != 3) throw new AssertionError("Manual result lost");
        System.out.println("Canonical-origin rows refresh live metadata without persisting selection");
    }
}
