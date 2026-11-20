package reflipped.shell.common;

/** Cancellation returns to account choices; it cannot persist or imply Guest. */
public final class PortalFlowTest {
    public static void main(String[] args) throws Exception {
        final int[] choices = {0}, attempts = {0};
        PortalFlow.Result retry = PortalFlow.choose(new PortalFlow.Choices() {
            public boolean account() { choices[0]++; return true; }
            public PortalFlow.Result signIn() {
                return ++attempts[0] == 1 ? PortalFlow.cancelled() : PortalFlow.success("signed-in-token");
            }
        });
        check(choices[0] == 2 && attempts[0] == 2, "cancel must reopen native chooser");
        check(retry.kind == PortalFlow.Kind.SUCCESS && retry.value.equals("signed-in-token"), "retry remains an account sign-in");

        final int[] afterCancel = {0}, cancelledAttempts = {0};
        PortalFlow.Result explicitGuest = PortalFlow.choose(new PortalFlow.Choices() {
            public boolean account() { return ++afterCancel[0] == 1; }
            public PortalFlow.Result signIn() { cancelledAttempts[0]++; return PortalFlow.cancelled(); }
        });
        check(afterCancel[0] == 2 && cancelledAttempts[0] == 1, "Guest is selected only on the subsequent explicit choice");
        check(explicitGuest.kind == PortalFlow.Kind.GUEST && explicitGuest.value == null, "explicit native Guest result");

        PortalFlow.Result webGuest = PortalFlow.choose(new PortalFlow.Choices() {
            public boolean account() { return true; }
            public PortalFlow.Result signIn() { return PortalFlow.callback(null, "1"); }
        });
        check(webGuest.kind == PortalFlow.Kind.GUEST, "explicit web Guest is distinct from cancellation");
        check(PortalFlow.callback(null, null) == null, "missing callback cannot select Guest");
        check(PortalFlow.callback("", "0") == null, "invalid callback cannot select Guest");
        check(PortalFlow.callback("code", null).kind == PortalFlow.Kind.SUCCESS, "code callback succeeds");
        check(PortalFlow.cancelled().kind == PortalFlow.Kind.CANCELLED && PortalFlow.cancelled().value == null, "Back/Close carries no account or Guest choice");
        System.out.println("Portal cancel, retry and explicit Guest flow checks passed");
    }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
}
