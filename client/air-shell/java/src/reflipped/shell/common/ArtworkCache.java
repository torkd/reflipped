package reflipped.shell.common;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/** Byte-bounded decoded LRU and single-flight policy. Eviction releases references, never owns/recycles values. */
public final class ArtworkCache<T> {
    public static final class Ticket {
        private Ticket() {}
    }

    public static final class Request<T> {
        public final T value;
        public final Ticket ticket;
        public final boolean start;

        private Request(T value, Ticket ticket, boolean start) {
            this.value = value;
            this.ticket = ticket;
            this.start = start;
        }
    }

    public static final class Deferred {
        public final String key;
        public final boolean refresh;

        private Deferred(String key, boolean refresh) {
            this.key = key;
            this.refresh = refresh;
        }
    }

    private final LinkedHashMap<String, Boolean> deferred = new LinkedHashMap<>();

    private static final class Value<T> {
        final T value;
        final int bytes;

        Value(T value, int bytes) {
            this.value = value;
            this.bytes = bytes;
        }
    }

    private final LinkedHashMap<String, Value<T>> values = new LinkedHashMap<>(16, .75f, true);
    private final Map<String, Ticket> flights = new LinkedHashMap<>();
    private final LinkedHashMap<String, Long> failures = new LinkedHashMap<>();
    private final int maxBytes, maxEntries, maxFlights, maxDeferred;
    private final long cooldown;
    private int bytes;
    private boolean closed;

    public ArtworkCache(int maxBytes, int maxEntries, int maxFlights, long cooldown) {
        this(maxBytes, maxEntries, maxFlights, cooldown, maxFlights * 2);
    }

    public ArtworkCache(int maxBytes, int maxEntries, int maxFlights, long cooldown, int maxDeferred) {
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.maxFlights = maxFlights;
        this.cooldown = cooldown;
        this.maxDeferred = maxDeferred;
    }

    public synchronized Request<T> begin(String key, long now, boolean refresh) {
        Value<T> cached = values.get(key);
        T value = cached == null ? null : cached.value;
        if (closed) return new Request<>(null, null, false);
        Ticket pending = flights.get(key);
        if (pending != null) return new Request<>(value, pending, false);
        if (value != null && !refresh) return new Request<>(value, null, false);
        Long failed = failures.get(key);
        if (!refresh && failed != null && now - failed < cooldown) return new Request<>(value, null, false);
        if (flights.size() >= maxFlights) {
            Boolean old = deferred.get(key);
            if (old != null)
                deferred.put(key, old || refresh);
            else if (deferred.size() < maxDeferred)
                deferred.put(key, refresh);
            return new Request<>(value, null, false);
        }
        deferred.remove(key);
        Ticket ticket = new Ticket();
        flights.put(key, ticket);
        return new Request<>(value, ticket, true);
    }

    public synchronized boolean complete(String key, Ticket ticket, T value, int weight, long now) {
        if (closed || ticket == null || flights.get(key) != ticket) return false;
        flights.remove(key);
        if (value == null) {
            failures.remove(key);
            failures.put(key, now);
            while (failures.size() > maxEntries) failures.remove(failures.keySet().iterator().next());
            return true;
        }
        failures.remove(key);
        Value<T> old = values.remove(key);
        if (old != null) bytes -= old.bytes;
        if (weight >= 0 && weight <= maxBytes) {
            values.put(key, new Value<>(value, weight));
            bytes += weight;
        }
        Iterator<Value<T>> iterator = values.values().iterator();
        while (bytes > maxBytes || values.size() > maxEntries) {
            Value<T> evicted = iterator.next();
            bytes -= evicted.bytes;
            iterator.remove();
        }
        return true;
    }

    public synchronized Deferred takeDeferred() {
        if (closed || flights.size() >= maxFlights || deferred.isEmpty()) return null;
        Map.Entry<String, Boolean> next = deferred.entrySet().iterator().next();
        Deferred result = new Deferred(next.getKey(), next.getValue());
        deferred.remove(next.getKey());
        return result;
    }

    public synchronized void forgetDeferred(String key) {
        deferred.remove(key);
    }

    public synchronized int deferredCount() {
        return deferred.size();
    }

    public synchronized int bytes() {
        return bytes;
    }

    public synchronized void close() {
        closed = true;
        values.clear();
        flights.clear();
        failures.clear();
        deferred.clear();
        bytes = 0;
    }
}
