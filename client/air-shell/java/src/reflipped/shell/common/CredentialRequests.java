package reflipped.shell.common;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;

/** Origin-scoped bearer proofs must never be forwarded through an HTTP redirect, including 307/308. */
public final class CredentialRequests {
    private CredentialRequests() { }

    public static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("POST");
        connection.setInstanceFollowRedirects(false);
        return connection;
    }
}
