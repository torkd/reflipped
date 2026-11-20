package reflipped.shell.common;

import java.util.ArrayList;
import java.util.List;

/** New bookmark behavior regressions, with no Android runtime, network or credential store. */
public final class ServerListModelTest {
    public static void main(String[] args) {
        ServerListModel<String> model = new ServerListModel<>(new ArrayList<>());
        ServerListModel.Row<String> first = model.save(null, "  My nickname  ", "HTTPS://Example.COM:443/", "Actual reported name");
        check(first.address.equals("https://example.com"), "canonical origin");
        check(first.nickname.equals("My nickname"), "nickname trimmed separately");
        check(first.metadata.equals("Actual reported name"), "nickname never replaces actual metadata");
        duplicate(() -> model.save(null, "Overwrite attempt", "https://example.com", "Changed name"), "https://example.com");
        check(model.rows().get(0).nickname.equals("My nickname"), "duplicate add cannot overwrite");
        model.save(null, "Second", "http://second.example:80", "Second metadata");
        model.save(null, "Third", "https://third.example", "Third metadata");
        duplicate(() -> model.save("https://third.example", "Collision", "http://second.example", "No"), "http://second.example");
        check(model.rows().get(2).nickname.equals("Third"), "duplicate edit rolls back");
        model.save("HTTPS://EXAMPLE.COM:443/", "Renamed", "https://renamed.example:8443", "New origin metadata");
        check(model.rows().get(0).address.equals("https://renamed.example:8443"), "edit retains original index");
        check(model.rows().get(1).address.equals("http://second.example"), "other rows retain order");
        check(model.updateMetadata("HTTPS://RENAMED.EXAMPLE:8443/", "Fresh reported name"), "explicit metadata refresh");
        check(model.rows().get(0).nickname.equals("Renamed"), "metadata refresh preserves nickname");
        check(!model.updateMetadata("https://missing.example", "Must not add"), "probe refresh never creates bookmark");
        check(model.rows().size() == 3, "metadata refresh keeps list size");
        List<ServerListModel.Row<String>> copy = model.rows(); copy.clear();
        check(model.rows().size() == 3, "returned list cannot mutate saved list");
        check(model.remove("HTTP://SECOND.EXAMPLE:80/"), "remove alias targets same bookmark");
        check(!model.remove("http://second.example"), "repeated remove harmless");
        check(model.rows().get(1).address.equals("https://third.example"), "remove preserves remaining order");
        check(ServerListModel.publicText("  Owner\nwrapped\tdescription\u0000  ", 500).equals("Owner wrapped description"), "wrapped owner description stays safe display text");
        check(ServerListModel.publicText("123456789", 4).equals("1234"), "oversized display text is capped instead of blocking Join");
        check(ServerListModel.publicText("123\ud83d\ude00", 4).equals("123"), "display truncation does not split a surrogate pair");
        String emoji = "\ud83d\ude00";
        StringBuilder nickname = new StringBuilder(); for (int i = 0; i < 32; i++) nickname.append(emoji);
        model.save(null, nickname.toString(), "https://unicode.example", "offline metadata");
        bad(() -> model.save(null, nickname + emoji, "https://too-long.example", "metadata"));
        bad(() -> model.save(null, "two\nlines", "https://bad-name.example", "metadata"));
        for (String invalid : new String[]{"bare.example", "file:///tmp/server", "https://u:p@host", "https://host/path", "https://host?token=x", "https://host#fragment", "https://host:0", "https://host:65536"})
            bad(() -> model.save(null, "", invalid, "metadata"));
        bad(() -> model.save("https://deleted.example", "Edit", "https://new.example", "metadata"));
        ServerListModel<String> full = new ServerListModel<>(new ArrayList<>());
        for (int i = 0; i < 50; i++) full.save(null, "", "https://host" + i + ".example", "unreachable/offline");
        try { full.save(null, "", "https://overflow.example", "metadata"); throw new AssertionError("full list accepted new bookmark"); }
        catch (ServerListModel.Full expected) { check(expected.getMessage().contains("join without saving"), "full list remains compatible with an unsaved Join"); }
        check(full.rows().size() == 50, "maximum is stable");
        full.save("https://host25.example", "Editable while full", "https://replacement.example", "metadata");
        check(full.rows().get(25).address.equals("https://replacement.example"), "full list still permits edit");
        check(full.remove("https://host0.example"), "remove frees a slot");
        full.save(null, "", "https://new-last.example", "metadata");
        check(full.rows().get(49).address.equals("https://new-last.example"), "new bookmark appends after removal");
        List<ServerListModel.Row<String>> legacy = new ArrayList<>();
        legacy.add(new ServerListModel.Row<>("https://legacy.example", "", "first public history metadata"));
        legacy.add(new ServerListModel.Row<>("HTTPS://LEGACY.EXAMPLE:443/", "", "duplicate history metadata"));
        check(new ServerListModel<>(legacy).rows().size() == 1, "history duplicate origins keep first stable row");
        List<ServerListModel.Row<String>> pinned = new ArrayList<>();
        List<String> provided = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            pinned.add(new ServerListModel.Row<>("https://provided" + i + ".example", "", "public metadata"));
            provided.add("HTTPS://PROVIDED" + i + ".EXAMPLE:443/");
        }
        ServerListModel<String> reclaimed = new ServerListModel<>(pinned);
        bad(() -> reclaimed.saveCustom(null, "two\nlines", "https://new-custom.example", "metadata", provided));
        check(reclaimed.rows().size() == 50 && reclaimed.rows().get(0).address.equals("https://provided0.example"), "invalid new custom does not prune");
        duplicate(() -> reclaimed.saveCustom(null, "Duplicate", "https://provided0.example", "metadata", provided), "https://provided0.example");
        reclaimed.saveCustom(null, "Custom", "https://new-custom.example", "metadata", provided);
        check(reclaimed.rows().size() == 50 && reclaimed.rows().get(49).address.equals("https://new-custom.example"), "full provided bookmarks reclaim one slot for custom");
        check(reclaimed.rows().get(0).address.equals("https://provided1.example"), "remaining provided order preserved");
        reclaimed.saveCustom("https://new-custom.example", "Edited", "https://edited-custom.example", "metadata", provided);
        check(reclaimed.rows().get(49).address.equals("https://edited-custom.example"), "edit while full keeps its index without pruning");
        try { reclaimed.saveCustom(null, "", "https://another-custom.example", "metadata", new ArrayList<>()); throw new AssertionError("unpinned row pruned"); }
        catch (ServerListModel.Full expected) { }
        System.out.println("Server bookmark offline/add/edit/remove/nickname/order/limit regressions passed");
    }
    private static void duplicate(Runnable action, String address) {
        try { action.run(); throw new AssertionError("duplicate accepted"); }
        catch (ServerListModel.Duplicate expected) { check(expected.address.equals(address), "duplicate exposes existing canonical origin"); }
    }
    private static void bad(Runnable action) {
        try { action.run(); throw new AssertionError("invalid operation accepted"); }
        catch (IllegalArgumentException expected) { }
    }
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
