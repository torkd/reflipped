package reflipped.shell.common;

/** A fresh Join check may complete only for its original selection and navigation state. */
public final class JoinGuard {
    public static final class Ticket {
        private final String origin;
        private final long navigation;
        private final int generation;

        private Ticket(String origin, long navigation, int generation) {
            this.origin = origin;
            this.navigation = navigation;
            this.generation = generation;
        }
    }

    private long navigation;

    public void navigate() {
        navigation++;
    }

    public Ticket begin(String address, int generation) {
        return new Ticket(ServerIdentity.origin(address), navigation, generation);
    }

    public boolean accepts(Ticket ticket, String address, int generation) {
        return ticket != null && !ticket.origin.isEmpty() && ticket.navigation == navigation
                && ticket.origin.equals(ServerIdentity.origin(address)) && ticket.generation == generation;
    }
}
