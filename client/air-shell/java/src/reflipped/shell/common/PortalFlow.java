package reflipped.shell.common;

/** Cancellation is navigation, never an implicit request to play as a guest. */
public final class PortalFlow {
    public enum Kind { SUCCESS, GUEST, CANCELLED }
    public static final class Result {
        public final Kind kind;
        public final String value;
        private Result(Kind kind, String value) { this.kind = kind; this.value = value; }
    }
    public interface Choices {
        boolean account() throws Exception;
        Result signIn() throws Exception;
    }
    private PortalFlow() { }

    public static Result success(String value) {
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Missing sign-in result");
        return new Result(Kind.SUCCESS, value);
    }
    public static Result guest() { return new Result(Kind.GUEST, null); }
    public static Result cancelled() { return new Result(Kind.CANCELLED, null); }

    /** An invalid callback is neither successful sign-in, Guest nor cancellation. */
    public static Result callback(String code, String guestFlag) {
        if (code != null && !code.isEmpty()) return success(code);
        return "1".equals(guestFlag) ? guest() : null;
    }

    /** The caller persists a guest choice only after this returns an explicit GUEST result. */
    public static Result choose(Choices choices) throws Exception {
        while (true) {
            if (!choices.account()) return guest();
            Result result = choices.signIn();
            if (result.kind != Kind.CANCELLED) return result;
        }
    }
}
