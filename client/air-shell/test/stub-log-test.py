#!/usr/bin/env python3
"""Exercise real StubContext/Args on a desktop JDK; no SDK, phone or downloads."""
from pathlib import Path
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parents[1] / 'java/src'
SHIMS = {
    'android/util/Log.java': '''package android.util;
public final class Log {
    public static final StringBuilder lines = new StringBuilder();
    public static int i(String tag, String message) { lines.append(message).append('\\n'); return 0; }
    public static int e(String tag, String message) { return i(tag, message); }
    public static int e(String tag, String message, Throwable t) {
        return i(tag, message + t.toString());
    }
}''',
    'com/adobe/fre/FREContext.java': '''package com.adobe.fre;
public abstract class FREContext {
    public String eventCode, eventLevel;
    public abstract java.util.Map<String, FREFunction> getFunctions();
    public abstract void dispose();
    public void dispatchStatusEventAsync(String code, String level) { eventCode=code; eventLevel=level; }
}''',
    'com/adobe/fre/FREFunction.java': '''package com.adobe.fre;
public interface FREFunction { FREObject call(FREContext ctx, FREObject[] args); }''',
    'com/adobe/fre/FREObject.java': '''package com.adobe.fre;
public class FREObject {
    private final Object value;
    private FREObject(Object v) { value=v; }
    public static FREObject newObject(String v) { return new FREObject(v); }
    public static FREObject newObject(boolean v) { return new FREObject(v); }
    public static FREObject newObject(int v) { return new FREObject(v); }
    public static FREObject newObject(double v) { return new FREObject(v); }
    public String getAsString() { return value.toString(); }
    public boolean getAsBool() { return (Boolean)value; }
    public int getAsInt() { return ((Number)value).intValue(); }
    public double getAsDouble() { return ((Number)value).doubleValue(); }
}''',
    'StubLogHarness.java': '''import reflipped.shell.common.StubContext;
import com.adobe.fre.FREObject;
import android.util.Log;
public class StubLogHarness {
    static void check(boolean b, String m) { if (!b) throw new AssertionError(m); }
    public static void main(String[] args) {
        String secret="sentinel-private-token";
        // Covers nested/escaped JSON as well as an unstructured argument and error message.
        String payload="{\\"accessToken\\":\\""+secret+"\\",\\"player\\":\\"{\\\\\\"zat\\\\\\":\\\\\\""+secret+"\\\\\\"}\\"}";
        StubContext ctx=new StubContext("kakao");
        ctx.complete("KGSESSION_START", payload);
        check(payload.equals(ctx.lastResult), "lastResult must stay intact");
        check("KGSESSION_START".equals(ctx.eventCode) && "".equals(ctx.eventLevel), "event delivery changed");
        ctx.on("GETLASTRESULT", (c, a) -> c.lastResult);
        FREObject result=ctx.getFunctions().get("GETLASTRESULT").call(ctx, new FREObject[]{FREObject.newObject(secret)});
        check(payload.equals(result.getAsString()), "game must receive original credentials");
        ctx.on("FAIL", (c,a) -> { throw new IllegalStateException(secret, new Exception(payload)); });
        check(ctx.getFunctions().get("FAIL").call(ctx, null)==null, "failure return changed");
        ctx.constant(true, "BOOL").constant(42, "NUMBER").noop("NOOP");
        check(ctx.getFunctions().get("BOOL").call(ctx,null).getAsBool(), "boolean changed");
        check(ctx.getFunctions().get("NUMBER").call(ctx,null).getAsInt()==42, "number changed");
        check(ctx.getFunctions().get("NOOP").call(ctx,null)==null, "null changed");
        FREObject opaque=FREObject.newObject(secret);
        ctx.constant(opaque, "OBJECT");
        check(ctx.getFunctions().get("OBJECT").call(ctx,null)==opaque, "FRE object identity changed");
        String log=Log.lines.toString();
        check(!log.contains(secret) && !log.contains("accessToken") && !log.contains("zat"), "payload leaked: "+log);
        check(log.contains("event KGSESSION_START") && log.contains("GETLASTRESULT(args=1) -> <string>"), "missing diagnostics");
        check(log.contains("FAIL(args=0) threw IllegalStateException"), "missing exception type");
        check(log.contains("<boolean>") && log.contains("<number>") && log.contains("<object>"), "missing return types");
        System.out.println("Stub logging regression checks passed");
    }
}'''
}

with tempfile.TemporaryDirectory(prefix='reflipped-stub-log-') as tmp:
    root = Path(tmp)
    for name, content in SHIMS.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    sources = [str(root / name) for name in SHIMS]
    sources += [str(SOURCE / 'reflipped/shell/common' / name) for name in ['StubContext.java', 'Args.java']]
    subprocess.run(['javac', '--release', '8', '-d', str(root / 'classes'), *sources], check=True)
    subprocess.run(['java', '-cp', str(root / 'classes'), 'StubLogHarness'], check=True)
