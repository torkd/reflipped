package reflipped.shell.common;

import com.sun.net.httpserver.HttpServer;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

/** A real loopback redirect must not receive a replay of a synthetic origin-scoped bearer proof. */
public final class CredentialRedirectReviewTest {
    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicInteger targetRequests = new AtomicInteger();
        server.createContext("/target", exchange -> {
            targetRequests.incrementAndGet();
            exchange.sendResponseHeaders(204, -1);
            exchange.close();
        });
        final String base = "http://127.0.0.1:" + server.getAddress().getPort();
        for (int status : new int[]{301, 302, 303, 307, 308}) {
            server.createContext("/redirect" + status, exchange -> {
                while (exchange.getRequestBody().read() != -1) { }
                exchange.getResponseHeaders().add("Location", base + "/target");
                exchange.sendResponseHeaders(status, -1);
                exchange.close();
            });
        }
        server.start();
        try {
            for (int status : new int[]{301, 302, 303, 307, 308}) {
                HttpURLConnection connection = CredentialRequests.open(base + "/redirect" + status);
                connection.setDoOutput(true);
                connection.setConnectTimeout(3000);
                connection.setReadTimeout(3000);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write("{\"whiteKey\":\"synthetic-origin-scoped-proof\"}".getBytes(StandardCharsets.UTF_8));
                }
                if (connection.getResponseCode() != status) throw new AssertionError("redirect followed: " + status);
                connection.disconnect();
            }
            if (targetRequests.get() != 0) throw new AssertionError("redirect target received credential request");
            System.out.println("SH-14 credential POST redirect review regressions passed");
        } finally { server.stop(0); }
    }
}
