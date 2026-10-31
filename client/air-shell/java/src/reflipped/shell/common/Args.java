package reflipped.shell.common;

import com.adobe.fre.FREObject;

/** Conversions between FREObject and Java values. */
public final class Args {
    private Args() {
    }

    public static String str(FREObject[] args, int i) {
        if (args.length <= i || args[i] == null) return null;
        try {
            return args[i].getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    public static int integer(FREObject[] args, int i, int fallback) {
        if (args.length <= i || args[i] == null) return fallback;
        try {
            return args[i].getAsInt();
        } catch (Exception e) {
            try {
                return (int) args[i].getAsDouble();
            } catch (Exception e2) {
                return fallback;
            }
        }
    }

    /** Best-effort readable form of an argument for the call log. */
    public static String describe(FREObject o) {
        if (o == null) return "null";
        try {
            return "\"" + o.getAsString() + "\"";
        } catch (Exception ignored) {
        }
        try {
            return Boolean.toString(o.getAsBool());
        } catch (Exception ignored) {
        }
        try {
            return Integer.toString(o.getAsInt());
        } catch (Exception ignored) {
        }
        try {
            return Double.toString(o.getAsDouble());
        } catch (Exception ignored) {
        }
        return "<object>";
    }

    public static FREObject toFre(Object value) throws Exception {
        if (value == null) return null;
        if (value instanceof FREObject) return (FREObject) value;
        if (value instanceof String) return FREObject.newObject((String) value);
        if (value instanceof Boolean) return FREObject.newObject((Boolean) value);
        if (value instanceof Integer) return FREObject.newObject((Integer) value);
        if (value instanceof Number) return FREObject.newObject(((Number) value).doubleValue());
        return FREObject.newObject(value.toString());
    }
}
