package reflipped.shell.common;
public class StubContext {
    public static final String TAG = "ReflippedShell";
    public volatile String lastCode;
    public int progressEvents;
    public void dispatchStatusEventAsync(String code, String level) {
        if (code.equals("progress")) { progressEvents++; return; }
        lastCode = code;
        System.out.println("EVENT " + code + " level=" + level);
    }
}
