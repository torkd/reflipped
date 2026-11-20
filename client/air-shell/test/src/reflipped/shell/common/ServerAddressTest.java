package reflipped.shell.common;

/** Connection acceptance must not alias deployments with different URL prefixes onto one credential origin. */
public final class ServerAddressTest {
    public static void main(String[] args) {
        for (String valid : new String[]{"https://host", "http://host:8000/", "HTTPS://HOST:443///", "http://[::1]:80/", "host:8000"})
            check(ServerIdentity.connectionAddress(valid) != null, "valid connection address rejected");
        check(ServerIdentity.connectionAddress("host:8000").equals("https://host:8000"), "bare address keeps HTTPS default");
        check(ServerIdentity.same("https://HOST:443///", "https://host"), "default-port/trailing-slash aliases");
        for (String invalid : new String[]{"http://host/deployment", "http://host/deployment///", "https://host/%2f", "https://host/.",
                "http://host:0", "http://host:-1", "http://host:65536", "http://host:", "http://user:pass@host", "https://host?q=x", "https://host#x", "https://host?", "https://host#"})
            check(ServerIdentity.connectionAddress(invalid) == null, "unsupported connection address accepted: " + invalid);
        check(ServerIdentity.resourceAddress("https://cdn.example/assets/Live/2.0.0/").equals("https://cdn.example/assets/Live/2.0.0"), "CDN path support preserved");
        check(ServerIdentity.resourceAddress("https://admin.example/panel/").equals("https://admin.example/panel"), "admin URL path support preserved");
        check(ServerIdentity.recorded("http://host/old-deployment", null).isEmpty(), "path-bearing old record cannot prove root-origin credentials");
        check(!ServerIdentity.same("http://host/old-deployment", "http://host"), "old deployment must not alias root origin");
        check(ServerIdentity.recorded("http://host:0", "https://known.example").equals("https://known.example"), "invalid historical account origin falls back only to valid recorded server");
        System.out.println("Host-only server address and resource URL policy checks passed");
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
