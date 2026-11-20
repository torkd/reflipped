package reflipped.shell.service;

import android.content.Context;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;

/**
 * The game's port of the server on the phone, held by the game's own process (SH-13). The game talks to
 * {@value LocalServer#ADDRESS}; Node listens on a Unix socket in the app's private storage (ServerState.nodeSocket), and this passes each connection
 * through, one thread per direction, until either side closes. While Node is down (the idle stop, a crash, Android ended it) a connection waits until the server answers
 * again ({@link LocalServer#ensureRunning}, which starts it), instead of being refused: the game sends its first
 * request the moment it comes back to the screen, and a refused one shows "Cannot connect to the internet" (F2032).
 * The port stays open as long as the game's process lives; nothing else in it may use port 8000.
 */
final class LocalPort {
    private static final int GAME_PORT = 8000;
    /** More than the game ever opens at once; beyond it a connection is closed at once (another app flooding the port). */
    private static final int MAX_CONNECTIONS = 32;
    private static final java.util.concurrent.atomic.AtomicInteger connections = new java.util.concurrent.atomic.AtomicInteger();
    private static ServerSocket listener;

    private LocalPort() {}

    /** Opens the game's port, once per process. Throws when another app holds it. */
    static synchronized void open(Context context) throws LocalServer.Failed {
        if (listener != null) return;
        final Context app = context.getApplicationContext();
        ServerSocket socket = null;
        try {
            socket = new ServerSocket();
            socket.setReuseAddress(true);
            socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), GAME_PORT), 16);
        } catch (IOException taken) {
            close(socket);
            Log.w(ServerService.TAG, "can't open port " + GAME_PORT + ": " + taken);
            throw new LocalServer.Failed("Port " + GAME_PORT + " on this phone is used by another app, so the Reflipped"
                    + " server can't take it. Close that app (for example a server running in Termux) and tap Retry.",
                    "");
        }
        listener = socket;
        final ServerSocket accepting = socket;
        Thread thread = new Thread(() -> {
            while (true) {
                Socket client;
                try {
                    client = accepting.accept();
                } catch (IOException e) {
                    Log.w(ServerService.TAG, "the game's port closed: " + e);
                    synchronized (LocalPort.class) {
                        if (listener == accepting) listener = null;
                    }
                    return;
                }
                if (connections.incrementAndGet() > MAX_CONNECTIONS) {
                    connections.decrementAndGet();
                    close(client);
                    continue;
                }
                Thread connection = new Thread(() -> {
                    try {
                        pass(app, client);
                    } finally {
                        connections.decrementAndGet();
                    }
                }, "reflipped-port");
                connection.setDaemon(true);
                connection.start();
            }
        }, "reflipped-port-accept");
        thread.setDaemon(true);
        thread.start();
        Log.i(ServerService.TAG, "holding port " + GAME_PORT + " for the server on this phone");
    }

    /** One connection: waits for Node (starting it if needed), then copies both ways until either side closes. */
    private static void pass(Context app, Socket client) {
        LocalSocket node = null;
        try {
            client.setTcpNoDelay(true);
            node = connect(app);
            if (node == null) {
                Log.i(ServerService.TAG, "a request came while the server is down: waiting for it");
                LocalServer.ensureRunning(app, false);
                node = connect(app);
                if (node == null) throw new IOException("the server answered but took no connection");
            }
            final LocalSocket server = node;
            Thread up = new Thread(() -> copy(client::getInputStream, server::getOutputStream, client, server),
                    "reflipped-port-up");
            up.setDaemon(true);
            up.start();
            copy(server::getInputStream, client::getOutputStream, client, server);
            up.join(); // copy() closed both sockets, so this ends at once
        } catch (LocalServer.Failed failed) {
            // the game sees a closed connection ("Cannot connect"); the player is told why and offered Retry
            Log.w(ServerService.TAG, "dropping a request, the server on this phone didn't start: " + failed.getMessage());
            close(client);
            LocalServer.explain(app, failed);
        } catch (Exception e) {
            Log.w(ServerService.TAG, "a connection through port " + GAME_PORT + " failed: " + e);
        } finally {
            close(client);
            close(node);
        }
    }

    /**
     * A connection to Node's Unix socket in this app's private storage (no other app can listen there), or null when
     * nothing listens there yet.
     */
    private static LocalSocket connect(Context app) {
        LocalSocket socket = new LocalSocket();
        try {
            socket.connect(new LocalSocketAddress(ServerState.nodeSocket(app).getAbsolutePath(),
                    LocalSocketAddress.Namespace.FILESYSTEM));
            return socket;
        } catch (IOException notYet) {
            close(socket);
            return null;
        }
    }

    /**
     * Copies from one socket to the other until either side ends, then closes both. HTTP needs no half-close, and a
     * side that never closes its half (an idle keep-alive connection Node dropped) would leave the other copy blocked
     * for the rest of the game's process.
     */
    private interface Stream<T> { T get() throws IOException; }

    private static void copy(Stream<InputStream> from, Stream<OutputStream> to, java.io.Closeable a, java.io.Closeable b) {
        byte[] buffer = new byte[16384];
        try {
            InputStream in = from.get();
            OutputStream out = to.get();
            for (int n; (n = in.read(buffer)) >= 0; ) {
                out.write(buffer, 0, n);
                out.flush();
            }
        } catch (IOException closed) {
            // the other copy closed the sockets, or a side went away
        } finally {
            close(a);
            close(b);
        }
    }

    private static void close(java.io.Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (IOException ignored) {
            // already closed
        }
    }
}
