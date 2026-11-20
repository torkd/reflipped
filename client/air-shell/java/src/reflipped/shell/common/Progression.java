package reflipped.shell.common;

/** Actual scheduling policy is independent of transport mode and the owner's free-text type. */
public final class Progression {
    public final String mode;
    public final double acceleration;
    private Progression(String mode, double acceleration) { this.mode = mode; this.acceleration = acceleration; }
    public static Progression of(String mode, double acceleration) {
        if ("classic".equals(mode) || "time-travel".equals(mode) || "manual".equals(mode) || "legacy".equals(mode))
            return new Progression(mode, 1);
        if ("accelerated".equals(mode) && !Double.isNaN(acceleration) && !Double.isInfinite(acceleration) && acceleration >= 2 && acceleration <= 10 && acceleration == Math.rint(acceleration))
            return new Progression(mode, acceleration);
        return new Progression("", 1);
    }
    public String label() {
        if ("classic".equals(mode)) return "Classic";
        if ("accelerated".equals(mode)) return "Accelerated · " + java.math.BigDecimal.valueOf(acceleration).stripTrailingZeros().toPlainString() + "×";
        if ("time-travel".equals(mode)) return "Time travel";
        if ("manual".equals(mode)) return "Manual";
        if ("legacy".equals(mode)) return "Legacy schedule";
        return NOT_LISTED;
    }

    /** Before a server answers, its mode isn't known yet. */
    public static final String UNKNOWN = "Event mode unknown", UNKNOWN_EXPLANATION = "Shown once this server answers.";
    /** The server answered without a mode this app knows: neutral wording, it isn't a refusal. */
    public static final String NOT_LISTED = "Event mode: not listed";

    /** One plain line under the mode, so a player knows what it means for events. */
    public String explanation() {
        if ("classic".equals(mode)) return "Past events come back at their original pace.";
        if ("accelerated".equals(mode)) return "Past events come back, faster than their original pace.";
        if ("time-travel".equals(mode)) return "You can pick a past event period to play.";
        if ("manual".equals(mode)) return "The server owner picks which events run.";
        if ("legacy".equals(mode)) return "Events follow the server's own fixed calendar.";
        return "This server doesn't say how it schedules events.";
    }

    /** Every explanation a card can show, so it can keep room for the longest. */
    public static String[] explanations() {
        String[] modes = {"classic", "accelerated", "time-travel", "manual", "legacy", ""};
        String[] lines = new String[modes.length + 1];
        for (int i = 0; i < modes.length; i++) lines[i] = of(modes[i], 2).explanation();
        lines[modes.length] = UNKNOWN_EXPLANATION;
        return lines;
    }
}
