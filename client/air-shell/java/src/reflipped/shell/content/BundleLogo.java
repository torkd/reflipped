package reflipped.shell.content;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Properties;
import java.util.zip.CRC32;
import java.util.zip.DataFormatException;
import java.util.zip.Deflater;
import java.util.zip.Inflater;

/**
 * Adds the REFLIPPED line to the title-screen logo inside the imported bundle.zip, on the phone, from the player's own
 * file (embedded builds do the same at build time with tools/make_logo.py). The logo is one 1015x683 PNG entry stored
 * with a lowercase "\x89png" magic; it is checked by name, magic and size before anything changes, and any other
 * bundle is left as it is. The new bundle.zip copies every other entry byte for byte (no recompression) and gets a
 * new bundle.zip.sha1, so the game unpacks the bundle again.
 *
 * Bookkeeping: {@link #RECORD} in the game folder says what was done (status stamped, not-logo or failed) and, once
 * stamped, the new bundle's size and SHA-1. {@link GameFiles} accepts that size as well as the game's own when it
 * checks the files at each start, so a stamped bundle stays READY. A stamped bundle is never stamped again: the record
 * says so, and a bundle of the game's own size is the unstamped one. The record goes with the game folder
 * (GameFiles.clear(), a new import), and a new import brings the game's own bundle back.
 *
 * Order of the writes, so that a kill at any point leaves a state the next start sorts out: the new bundle as
 * bundle.zip.new; the record; bundle.zip.new over bundle.zip; the new .sha1. A record whose bundle still has the
 * game's own size is stamped again, and one whose .sha1 doesn't match gets only the .sha1 rewritten.
 *
 * No Android classes: the PNG decoder is passed in (BitmapFactory on the phone, ImageIO in the desktop test).
 */
public final class BundleLogo {
    public static final String ENTRY = "production/bundle/ec/f7af5920a31dd5d4812d3c3b01b1b430cb4540";
    static final String RECORD = "logo.properties";
    static final String BUNDLE = "bundle.zip";
    static final String SHA1 = "bundle.zip.sha1";
    private static final byte[] MAGIC = {(byte) 0x89, 'p', 'n', 'g', '\r', '\n', 0x1a, '\n'};
    private static final long MAX_ENTRY = 8L * 1024 * 1024;  // the logo PNG is 161 KB

    /** Decodes a PNG into non-premultiplied ARGB pixels; null if it isn't width x height. */
    public interface PngDecoder {
        int[] decode(byte[] png, int width, int height) throws IOException;
    }

    public enum Outcome {
        /** The line was added (or a stamp interrupted before its .sha1 was finished). */
        STAMPED,
        /** Nothing to do: already stamped, or found earlier not to be the expected logo. */
        DONE,
        /** The bundle has no logo of the expected form: left as it is, and not looked at again. */
        NOT_LOGO,
        /** Reading or writing failed (left as it is); a later re-patch or import tries again. */
        FAILED
    }

    public static final class Result {
        public final Outcome outcome;
        public final String detail;

        Result(Outcome outcome, String detail) {
            this.outcome = outcome;
            this.detail = detail;
        }

        @Override
        public String toString() {
            return outcome + (detail == null ? "" : " (" + detail + ")");
        }
    }

    /** The bundle isn't the expected one: leave it alone. */
    static final class NotLogo extends IOException {
        NotLogo(String message) {
            super(message);
        }
    }

    private final GameFiles files;

    public BundleLogo(GameFiles files) {
        this.files = files;
    }

    private File bundle() {
        return new File(files.storage, BUNDLE);
    }

    private File sha1File() {
        return new File(files.storage, SHA1);
    }

    private File record() {
        return new File(files.dir(), RECORD);
    }

    /** The game's own size of bundle.zip, or -1 if this app doesn't import one. */
    private long originalSize() {
        for (ImportManifest.Entry e : files.manifest.entries) if (e.fileName().equals(BUNDLE)) return e.size;
        return -1;
    }

    /**
     * The size `fileName` has after the stamp, as recorded in the game folder `dir`, or -1 if there is none: the
     * storage check accepts it as well as the game's own size.
     */
    static long stampedSize(File dir, String fileName) {
        Properties record = GameFiles.readState(new File(dir, RECORD));
        if (record == null || !"stamped".equals(record.getProperty("status"))) return -1;
        try {
            return Long.parseLong(record.getProperty(fileName + ".size", "-1"));
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * Whether {@link #apply} has work to do; cheap (a small file and two sizes), so every start can ask. `retryFailed`
     * also tries again after a failed attempt (an import or re-patch does; a plain start doesn't).
     */
    public boolean pending(boolean retryFailed) {
        if (originalSize() < 0) return false;
        Properties record = GameFiles.readState(record());
        boolean original = bundle().length() == originalSize();
        if (record == null) return original;
        String status = record.getProperty("status");
        if ("stamped".equals(status)) return !finished(record) && (original || stampedButSha1(record));
        if ("failed".equals(status)) return retryFailed && original;
        return false;
    }

    private boolean stampedButSha1(Properties record) {
        return Long.toString(bundle().length()).equals(record.getProperty(BUNDLE + ".size"));
    }

    private boolean finished(Properties record) {
        if (!stampedButSha1(record)) return false;
        try {
            return new String(GameFiles.readFully(sha1File()), StandardCharsets.US_ASCII).trim()
                    .equals(record.getProperty(BUNDLE + ".sha1"));
        } catch (IOException e) {
            return false;
        }
    }

    /** Adds the line if {@link #pending} says so. Never throws: whatever happens, the game can start. */
    public Result apply(PngDecoder decoder, boolean retryFailed) {
        if (!pending(retryFailed)) return new Result(Outcome.DONE, null);
        File next = new File(files.storage, BUNDLE + ".new");
        File nextSha1 = new File(files.storage, SHA1 + ".new");
        try {
            Properties record = GameFiles.readState(record());
            if (record != null && "stamped".equals(record.getProperty("status")) && stampedButSha1(record)) {
                writeSha1(record.getProperty(BUNDLE + ".sha1"), nextSha1);
                return new Result(Outcome.STAMPED, "only bundle.zip.sha1 was left to write");
            }
            next.delete();
            Stamped stamped = stamp(bundle(), next, decoder);
            Properties done = new Properties();
            done.setProperty("format", "1");
            done.setProperty("status", "stamped");
            done.setProperty(BUNDLE + ".size", Long.toString(stamped.size));
            done.setProperty(BUNDLE + ".sha1", stamped.sha1);
            done.setProperty(SHA1 + ".size", Integer.toString(stamped.sha1.length()));
            writeRecord(done);
            File bundle = bundle();
            if (!next.renameTo(bundle)) throw new IOException("can't move the new bundle.zip into place");
            writeSha1(stamped.sha1, nextSha1);
            return new Result(Outcome.STAMPED, "bundle.zip " + originalSize() + " -> " + stamped.size + " bytes");
        } catch (NotLogo e) {
            next.delete();
            recordStatus("not-logo", e.getMessage());
            return new Result(Outcome.NOT_LOGO, e.getMessage());
        } catch (IOException | RuntimeException | OutOfMemoryError e) {
            next.delete();
            nextSha1.delete();
            recordStatus("failed", e.getClass().getSimpleName() + ": " + e.getMessage());
            return new Result(Outcome.FAILED, e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private void recordStatus(String status, String reason) {
        // a record of an earlier stamp stays: it still describes the bundle on disk if the rename happened
        Properties old = GameFiles.readState(record());
        if (old != null && "stamped".equals(old.getProperty("status")) && stampedButSha1(old)) return;
        Properties p = new Properties();
        p.setProperty("format", "1");
        p.setProperty("status", status);
        if (reason != null) p.setProperty("reason", reason);
        try {
            writeRecord(p);
        } catch (IOException ignored) {
            // without a record the next start tries again
        }
    }

    private void writeRecord(Properties p) throws IOException {
        File dir = files.dir();
        if (!dir.isDirectory()) throw new IOException("no game folder");
        p.setProperty("time", Long.toString(System.currentTimeMillis()));
        File tmp = new File(dir, RECORD + ".new");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            p.store(out, "Reflipped: the REFLIPPED line on the title logo (BundleLogo)");
            out.getFD().sync();
        }
        if (!tmp.renameTo(record())) throw new IOException("can't write " + RECORD);
    }

    private void writeSha1(String sha1, File tmp) throws IOException {
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(sha1.getBytes(StandardCharsets.US_ASCII));  // like the game's own: 40 hex digits, no newline
            out.getFD().sync();
        }
        if (!tmp.renameTo(sha1File())) throw new IOException("can't move the new bundle.zip.sha1 into place");
    }

    // ---------------------------------------------------------------- the zip rewrite

    static final class Stamped {
        final long size;
        final String sha1;

        Stamped(long size, String sha1) {
            this.size = size;
            this.sha1 = sha1;
        }
    }

    /**
     * Writes `bundle` with the stamped logo to `out` and returns its size and SHA-1. Only the logo entry's local header
     * and data are new; everything before and after it is copied as it is, and the central directory's offsets move.
     * Throws {@link NotLogo} if the bundle or its logo isn't of the expected form.
     */
    static Stamped stamp(File bundle, File out, PngDecoder decoder) throws IOException {
        try (RandomAccessFile zip = new RandomAccessFile(bundle, "r")) {
            long length = zip.length();
            int tail = (int) Math.min(length, 22 + 65535);
            if (tail < 22) throw new NotLogo("bundle.zip isn't a zip file");
            byte[] end = new byte[tail];
            zip.seek(length - tail);
            zip.readFully(end);
            int eocd = -1;
            for (int i = tail - 22; i >= 0; i--) {
                if (le32(end, i) == 0x06054b50L && i + 22 + le16(end, i + 20) == tail) {
                    eocd = i;
                    break;
                }
            }
            if (eocd < 0) throw new NotLogo("bundle.zip isn't a zip file");
            int count = le16(end, eocd + 10);
            long cdSize = le32(end, eocd + 12), cdOffset = le32(end, eocd + 16);
            if (le16(end, eocd + 4) != 0 || le16(end, eocd + 6) != 0 || le16(end, eocd + 8) != count
                    || count == 0xFFFF || cdSize == 0xFFFFFFFFL || cdOffset == 0xFFFFFFFFL) {
                throw new NotLogo("bundle.zip is a multi-part or zip64 file");
            }
            if (cdOffset + cdSize != length - tail + eocd || cdSize > MAX_ENTRY) {
                throw new NotLogo("bundle.zip has an unexpected layout");
            }
            byte[] cd = new byte[(int) cdSize];
            zip.seek(cdOffset);
            zip.readFully(cd);
            int[] at = new int[count];
            long[] offsets = new long[count];
            int logo = -1;
            int p = 0;
            byte[] entryName = ENTRY.getBytes(StandardCharsets.UTF_8);
            for (int i = 0; i < count; i++) {
                if (p + 46 > cd.length || le32(cd, p) != 0x02014b50L) throw new NotLogo("damaged central directory");
                int n = le16(cd, p + 28), x = le16(cd, p + 30), c = le16(cd, p + 32);
                if (p + 46 + n + x + c > cd.length) throw new NotLogo("damaged central directory");
                at[i] = p;
                offsets[i] = le32(cd, p + 42);
                if (offsets[i] == 0xFFFFFFFFL || offsets[i] >= cdOffset) throw new NotLogo("damaged central directory");
                if (Arrays.equals(Arrays.copyOfRange(cd, p + 46, p + 46 + n), entryName)) {
                    if (logo >= 0) throw new NotLogo("the logo entry is there twice");
                    logo = i;
                }
                p += 46 + n + x + c;
            }
            if (p != cd.length) throw new NotLogo("damaged central directory");
            if (logo < 0) throw new NotLogo("no " + ENTRY);
            int r = at[logo];
            int method = le16(cd, r + 10);
            long crc = le32(cd, r + 16), csize = le32(cd, r + 20), usize = le32(cd, r + 24);
            if (method != 0 && method != 8) throw new NotLogo("the logo entry has compression method " + method);
            if (csize > MAX_ENTRY || usize > MAX_ENTRY) throw new NotLogo("the logo entry is too large");

            long local = offsets[logo];
            byte[] header = new byte[30];
            zip.seek(local);
            zip.readFully(header);
            if (le32(header, 0) != 0x04034b50L) throw new NotLogo("damaged local header");
            int nameLength = le16(header, 26), extraLength = le16(header, 28);
            byte[] name = new byte[nameLength];
            zip.readFully(name);
            if (!Arrays.equals(name, entryName)) throw new NotLogo("damaged local header");
            long dataStart = local + 30 + nameLength + extraLength;
            long localEnd = cdOffset;  // where the next entry starts (a data descriptor, if any, goes with the entry)
            for (long o : offsets) if (o > local && o < localEnd) localEnd = o;
            if (dataStart + csize > localEnd) throw new NotLogo("overlapping entries");
            byte[] stored = new byte[(int) csize];
            zip.seek(dataStart);
            zip.readFully(stored);
            byte[] png = method == 0 ? stored : inflate(stored, (int) usize);
            stored = null;
            CRC32 check = new CRC32();
            check.update(png, 0, png.length);
            if (png.length != usize || check.getValue() != crc) throw new NotLogo("the logo entry is damaged");

            byte[] stampedPng = stampPng(png, decoder);
            png = null;
            byte[] data = method == 0 ? stampedPng : deflate(stampedPng);
            CRC32 newCrc = new CRC32();
            newCrc.update(stampedPng, 0, stampedPng.length);

            int flags = le16(header, 6) & ~8;  // sizes in the header, no data descriptor
            byte[] newHeader = new byte[30 + nameLength];
            System.arraycopy(header, 0, newHeader, 0, 30);
            put16(newHeader, 6, flags);
            put32(newHeader, 14, newCrc.getValue());
            put32(newHeader, 18, data.length);
            put32(newHeader, 22, stampedPng.length);
            put16(newHeader, 28, 0);
            System.arraycopy(name, 0, newHeader, 30, nameLength);
            long delta = newHeader.length + data.length - (localEnd - local);
            if (cdOffset + delta + cdSize >= 0xFFFFFFFFL) throw new NotLogo("the new bundle would be too large");

            for (int i = 0; i < count; i++) {
                if (offsets[i] > local) put32(cd, at[i] + 42, offsets[i] + delta);
            }
            put16(cd, r + 8, le16(cd, r + 8) & ~8);
            put32(cd, r + 16, newCrc.getValue());
            put32(cd, r + 20, data.length);
            put32(cd, r + 24, stampedPng.length);
            byte[] newEnd = Arrays.copyOfRange(end, eocd, tail);
            put32(newEnd, 16, cdOffset + delta);

            MessageDigest sha1;
            try {
                sha1 = MessageDigest.getInstance("SHA-1");
            } catch (NoSuchAlgorithmException e) {
                throw new IllegalStateException(e);
            }
            long written;
            try (FileOutputStream file = new FileOutputStream(out);
                 DigestOutputStream digest = new DigestOutputStream(new BufferedOutputStream(file, 1 << 16), sha1)) {
                copy(zip, 0, local, digest);
                digest.write(newHeader);
                digest.write(data);
                copy(zip, localEnd, cdOffset - localEnd, digest);
                digest.write(cd);
                digest.write(newEnd);
                digest.flush();
                file.getFD().sync();
                written = file.getChannel().size();
            } catch (IOException | RuntimeException e) {
                out.delete();
                throw e;
            }
            if (written != length + delta) {
                out.delete();
                throw new IOException("the new bundle has " + written + " bytes, not " + (length + delta));
            }
            return new Stamped(written, Hashes.hex(sha1.digest()));
        }
    }

    /** The logo entry's bytes ("\x89png" PNG) with the line added, in the same form; NotLogo if it isn't the logo. */
    static byte[] stampPng(byte[] png, PngDecoder decoder) throws IOException {
        if (png.length < 24 || !Arrays.equals(Arrays.copyOf(png, 8), MAGIC)) {
            throw new NotLogo("the logo entry doesn't start with \\x89png");
        }
        int width = (int) be32(png, 16), height = (int) be32(png, 20);  // IHDR
        if (!"IHDR".equals(new String(png, 12, 4, StandardCharsets.US_ASCII))
                || width != LogoStamp.WIDTH || height != LogoStamp.HEIGHT) {
            throw new NotLogo("the logo is " + width + "x" + height + ", not " + LogoStamp.WIDTH + "x" + LogoStamp.HEIGHT);
        }
        byte[] standard = png.clone();
        standard[1] = 'P';
        standard[2] = 'N';
        standard[3] = 'G';
        int[] pixels = decoder.decode(standard, width, height);
        standard = null;
        if (pixels == null) throw new NotLogo("the logo can't be decoded as " + width + "x" + height);
        int[] stamped = LogoStamp.stamp(pixels, width, height);
        pixels = null;
        if (stamped == null) throw new NotLogo("the logo has another size");
        byte[] out = PngWriter.encode(stamped, width, height);
        out[1] = 'p';
        out[2] = 'n';
        out[3] = 'g';
        return out;
    }

    private static void copy(RandomAccessFile in, long from, long length, OutputStream out) throws IOException {
        byte[] buffer = new byte[1 << 16];
        in.seek(from);
        while (length > 0) {
            int n = in.read(buffer, 0, (int) Math.min(buffer.length, length));
            if (n < 0) throw new IOException("bundle.zip ended early");
            out.write(buffer, 0, n);
            length -= n;
        }
    }

    private static byte[] inflate(byte[] data, int size) throws IOException {
        Inflater inflater = new Inflater(true);
        try {
            inflater.setInput(data);
            byte[] out = new byte[size];
            int n = 0;
            while (n < size && !inflater.finished()) {
                int got = inflater.inflate(out, n, size - n);
                if (got == 0 && (inflater.needsInput() || inflater.needsDictionary())) break;
                n += got;
            }
            if (n != size) throw new NotLogo("the logo entry is damaged");
            return out;
        } catch (DataFormatException e) {
            throw new NotLogo("the logo entry is damaged");
        } finally {
            inflater.end();
        }
    }

    private static byte[] deflate(byte[] data) {
        Deflater deflater = new Deflater(9, true);
        try {
            deflater.setInput(data);
            deflater.finish();
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(data.length);
            byte[] buffer = new byte[1 << 16];
            while (!deflater.finished()) {
                int n = deflater.deflate(buffer);
                out.write(buffer, 0, n);
            }
            return out.toByteArray();
        } finally {
            deflater.end();
        }
    }

    private static int le16(byte[] b, int at) {
        return (b[at] & 255) | (b[at + 1] & 255) << 8;
    }

    private static long le32(byte[] b, int at) {
        return (le16(b, at) | (long) le16(b, at + 2) << 16) & 0xFFFFFFFFL;
    }

    private static long be32(byte[] b, int at) {
        return ((long) (b[at] & 255) << 24) | (b[at + 1] & 255) << 16 | (b[at + 2] & 255) << 8 | (b[at + 3] & 255);
    }

    private static void put16(byte[] b, int at, int v) {
        b[at] = (byte) v;
        b[at + 1] = (byte) (v >> 8);
    }

    private static void put32(byte[] b, int at, long v) {
        put16(b, at, (int) v & 0xFFFF);
        put16(b, at + 2, (int) (v >>> 16) & 0xFFFF);
    }
}
