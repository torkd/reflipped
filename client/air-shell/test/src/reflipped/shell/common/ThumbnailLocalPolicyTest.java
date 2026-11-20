package reflipped.shell.common;

/** Card images on local-network addresses are accepted only from that same server host. */
public final class ThumbnailLocalPolicyTest {
    private static void expect(String server, String image, boolean accepted) {
        String result = ThumbnailPolicy.validateFor(server, image);
        if (accepted != image.equals(result)) throw new AssertionError((accepted ? "Rejected " : "Accepted ") + image + " from " + server);
    }

    public static void main(String[] args) {
        String publicServer = "https://reflipped.example.org";
        expect(publicServer, "https://cdn.example.net/card.png?w=192", true);
        expect(publicServer, "https://8.8.8.8/card.png", true);
        for (String local : new String[]{"http://127.0.0.1/a.png", "http://localhost:8080/a.png", "http://LOCALHOST./a.png",
                "http://10.0.0.1/a.png", "http://172.20.1.1/a.png", "http://192.168.1.1/a.png", "http://169.254.169.254/a.png",
                "http://100.64.0.1/a.png", "http://0.0.0.0/a.png", "http://[::1]/a.png", "http://[fd00::1]/a.png",
                "http://[fe80::1]/a.png", "http://[::ffff:192.168.0.1]/a.png", "http://127.1/a.png", "http://0x7f.1/a.png",
                "http://0177.0.0.1/a.png"})
            expect(publicServer, local, false);
        expect(publicServer, "http://172.32.0.1/a.png", true);
        // A LAN or emulator server may serve its own card image.
        expect("http://192.168.1.10:8000", "http://192.168.1.10:8000/card.png", true);
        expect("http://192.168.1.10:8000", "http://192.168.1.11/card.png", false);
        expect("http://10.0.2.2:8000", "http://10.0.2.2:8302/thumbnail.png", true);
        expect("http://[::1]:8000", "http://[::1]:9000/a.png", true);
        expect("http://localhost:8000", "http://localhost:8000/a.png", true);
        expect(null, "http://127.0.0.1/a.png", false);
        System.out.println("Local-network thumbnail policy checks passed");
    }
}
