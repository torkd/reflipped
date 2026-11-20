package reflipped.shell.common;

public final class ProgressionTest {
    public static void main(String[] args) {
        String[] modes = {"classic", "accelerated", "time-travel", "manual", "legacy"};
        String[] labels = {"Classic", "Accelerated · 2×", "Time travel", "Manual", "Legacy schedule"};
        for (int i=0;i<modes.length;i++) {
            Progression value = Progression.of(modes[i], 2);
            if (!labels[i].equals(value.label())) throw new AssertionError("Wrong actual mode mapping");
            if (i!=1 && value.acceleration != 1) throw new AssertionError("Inactive multiplier leaked");
        }
        if (!"Event mode: not listed".equals(Progression.of("online", 1).label())) throw new AssertionError("Transport inferred progression");
        if (!"Event mode: not listed".equals(Progression.of(null, 1).label())) throw new AssertionError("Missing mode guessed");
        for (double invalid : new double[]{0, -1, Double.NaN, Double.POSITIVE_INFINITY, 1e308, 2.5, 1, 11})
            if (!"Event mode: not listed".equals(Progression.of("accelerated", invalid).label())) throw new AssertionError("Invalid factor displayed");
        for (String mode : modes)
            if (Progression.of(mode, 2).explanation().equals(Progression.of("", 1).explanation()))
                throw new AssertionError("Mode without its own explanation");
        if (!"Accelerated · 2×".equals(Progression.of("accelerated", 2).label())) throw new AssertionError("Integer factor formatting");
        System.out.println("Actual progression labels and active multipliers map independently of transport");
    }
}
