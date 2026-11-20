package reflipped.shell.common;

/** Optional browser selection is not a credential provenance assertion. Fresh installs have no selection. */
public final class BrowserStart {
    public final String address, origin;

    public static String address(String initial) {
        String valid = ServerIdentity.connectionAddress(initial);
        return valid == null ? "" : valid;
    }

    public BrowserStart(String initial) {
        address = address(initial);
        origin = address.isEmpty() ? "" : ServerIdentity.origin(address);
    }
}
