package reflipped.shell.common;

public final class JoinGuardTest {
    public static void main(String[] args) {
        JoinGuard guard=new JoinGuard();
        JoinGuard.Ticket first=guard.begin("http://EXAMPLE.org:80/",3);
        if(!guard.accepts(first,"http://example.org",3))throw new AssertionError("Alias changed identity");
        if(guard.accepts(first,"http://other.example",3)||guard.accepts(first,"http://example.org",4))throw new AssertionError("Different server/check could Join");
        guard.navigate();
        if(guard.accepts(first,"http://example.org",3))throw new AssertionError("Tab/edit/back did not cancel pending Join");
        JoinGuard.Ticket second=guard.begin("http://example.org",4);
        if(!guard.accepts(second,"http://example.org",4))throw new AssertionError("Fresh explicit Join blocked");
        guard.navigate();guard.navigate();
        if(guard.accepts(second,"http://example.org",4))throw new AssertionError("Returning to old selection resurrected Join");
        System.out.println("Fresh Join rejects stale checks and navigation, including returning to the same origin");
    }
}
