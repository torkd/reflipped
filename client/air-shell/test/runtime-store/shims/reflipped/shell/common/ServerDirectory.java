package reflipped.shell.common;
/** Public value shape only; catalogue I/O/UI are deliberately outside this in-memory codec test. */
public final class ServerDirectory {
    public static final class Entry {
        public final String name, address, description, type, thumbnail, mode;
        public final Progression progression;
        public Entry(String name, String address, String description, String type, String thumbnail, String mode, Progression progression) {
            this.name = name; this.address = address; this.description = description;
            this.type = type; this.thumbnail = thumbnail; this.mode = mode; this.progression = progression;
        }
    }
}
