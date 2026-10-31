package reflipped.shell.other;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/** `com.sesisoft.SingularSdk`: analytics. Every call succeeds and sends nothing anywhere. */
public class SingularSdkStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.sesisoft.SingularSdk";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.on("GETLASTRESULT", (c, a) -> c.lastResult);
        for (String name : new String[]{"SINGULAR_INIT", "SINGULAR_INITWITHSINGULARLINK", "SINGULAR_START",
                "SINGULAR_STARTSESSION", "SINGULAR_EVENT", "SINGULAR_EVENTJSON", "SINGULAR_EVENTWITHARGS",
                "SINGULAR_REVENUE", "SINGULAR_CUSTOMREVENUE", "SINGULAR_SETCUSTOMUSERID", "SINGULAR_UNSETCUSTOMUSERID"}) {
            ctx.on(name, (c, a) -> {
                c.complete(name, "{\"isSuccess\":\"true\"}");
                return null;
            });
        }
    }
}
