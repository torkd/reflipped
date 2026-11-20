package reflipped.shell.pinball;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/**
 * A copy of a server's {@code .cdn} folder in one file (SH-29, docs/game-data-pack.md): an uncompressed tar or a zip,
 * as server owners keep it, installed like a game data pack. The file is read at random (a seekable file descriptor:
 * files on the phone, an SD card or a USB stick), so only the archives of the official list are read, in its download
 * order, and the rest (other languages, iOS, mods, a few GB or tens of GB) is skipped. The archives are found by their
 * CDN path ({@code en/archive-common-full/asset-….zip}) under any folder ({@code .cdn/}, {@code cdn/}, none).
 *
 * <p>Each archive is checked against the list's size and SHA-256 before anything of it is extracted, by the
 * downloader's own extractor, as {@link GamePack} does. A compressed tar ({@code .tar.gz} and the like) has no random
 * access and is refused with a reason. A pack made by {@code npm run gamepack} is recognised ({@link #isPack}) and
 * left to {@link GamePack}. Plain Java: the desktop test runs it.
 */
public final class CdnCopy {
    private static final Pattern CDN_PATH = Pattern.compile("(?:^|/)((?:en|ko|th)/archive-[^/]+/[^/]+)$");
    private static final int MAX_CENTRAL_DIRECTORY = 64 << 20;

    private static final String NOT_A_COPY = "This file isn't a game data pack or a copy of the game data folder"
            + " (a .tar or .zip of the .cdn folder).";
    private static final String COMPRESSED = "This file is compressed (a .tar.gz or similar), which the app can't read"
            + " without unpacking all of it first. On a computer, make a plain .tar of the folder instead (tar -cf"
            + " cdn.tar .cdn) or a .zip, and copy that.";

    private static final class Located {
        final long offset;
        final long compressedSize;
        final long size;
        final boolean deflated;
        Located(long offset, long compressedSize, long size, boolean deflated) {
            this.offset = offset; this.compressedSize = compressedSize; this.size = size; this.deflated = deflated;
        }
    }

    private final FileChannel file;
    private final boolean pack;
    private final Map<String, Located> entries = new HashMap<>();
    /** a zip: {@link Located#offset} is the entry's local header, which says where its data starts */
    private final boolean zip;

    private CdnCopy(FileChannel file, boolean pack, boolean zip) {
        this.file = file;
        this.pack = pack;
        this.zip = zip;
    }

    /** Reads {@code file}'s index (tar headers or the zip's central directory); the channel stays open. */
    public static CdnCopy open(FileChannel file) throws IOException {
        long size;
        try {
            size = file.size();
            file.position(0);
        } catch (IOException notSeekable) {
            throw new GamePack.Refused("This file can't be read where it is stored. Copy it to the phone (for"
                    + " example into Downloads), then pick it again.");
        }
        byte[] head = new byte[512];
        int got = readAt(file, 0, head, 0, head.length);
        if (got < 4) throw new GamePack.Refused(NOT_A_COPY);
        if (compressed(head)) throw new GamePack.Refused(COMPRESSED);
        if (head[0] == 'P' && head[1] == 'K') {
            CdnCopy copy = new CdnCopy(file, false, true);
            copy.indexZip(size);
            return copy;
        }
        if (got == 512 && (GamePack.text(head, 257, 5).equals("ustar") || looksLikeTar(head))) {
            if (GamePack.MANIFEST.equals(GamePack.headerName(head))) return new CdnCopy(file, true, false);
            CdnCopy copy = new CdnCopy(file, false, false);
            copy.indexTar(size);
            return copy;
        }
        throw new GamePack.Refused(NOT_A_COPY);
    }

    /** A game data pack ({@code npm run gamepack}): install it with {@link GamePack} from the start of the file. */
    public boolean isPack() {
        return pack;
    }

    /** How many of the list's archives the copy lacks, or holds at another size. */
    public int missing(GamePack.Manifest list) {
        int missing = 0;
        for (GamePack.Archive archive : list.archives) {
            Located at = entries.get(archive.path);
            if (at == null || at.size != archive.size) missing++;
        }
        return missing;
    }

    /** The first archive of the list the copy lacks, for the refusal, or null. */
    public String firstMissing(GamePack.Manifest list) {
        for (GamePack.Archive archive : list.archives) {
            Located at = entries.get(archive.path);
            if (at == null || at.size != archive.size) return archive.path;
        }
        return null;
    }

    /**
     * Installs the list's archives into {@code assetDir}, in order, each checked first. False when {@code cancel}
     * stopped it (the files are then incomplete).
     */
    public boolean install(GamePack.Manifest list, File assetDir, GamePack.Progress progress, ArchiveExtractor.Cancel cancel)
            throws IOException {
        String gap = firstMissing(list);
        if (gap != null) throw new GamePack.Refused("This copy of the game data is incomplete: " + missing(list)
                + " of its " + list.archives.size() + " files are missing or cut short (" + gap + " first). Copy the"
                + " folder again.");
        assetDir.mkdirs();
        ArchiveExtractor extractor = new ArchiveExtractor(assetDir);
        long done = 0;
        for (GamePack.Archive archive : list.archives) {
            if (cancel != null && cancel.cancelled()) return false;
            byte[] data = read(entries.get(archive.path), archive.path);
            if (!GamePack.sha256(data).equals(archive.sha256))
                throw new GamePack.Refused("This copy of the game data is damaged (" + archive.path + " doesn't match"
                        + " the official file).");
            if (!extractor.extract(new ByteArrayInputStream(data), cancel)) return false;
            done += archive.size;
            if (progress != null) progress.installed(done, list.totalSize);
        }
        return true;
    }

    // ------------------------------------------------------------------ entries

    private void add(String name, Located at) {
        Matcher match = CDN_PATH.matcher(name);
        if (match.find() && !entries.containsKey(match.group(1))) entries.put(match.group(1), at);
    }

    private byte[] read(Located at, String path) throws IOException {
        if (at.size > GamePack.MAX_ARCHIVE || at.compressedSize > GamePack.MAX_ARCHIVE)
            throw new GamePack.Refused("This copy of the game data is damaged (" + path + " is too large).");
        long offset = at.offset;
        if (zip) offset = zipDataOffset(at.offset, path);
        byte[] stored = new byte[(int) at.compressedSize];
        if (readAt(file, offset, stored, 0, stored.length) != stored.length)
            throw new GamePack.Refused("This copy of the game data is incomplete (the file ends early).");
        if (!at.deflated) return stored;
        Inflater inflater = new Inflater(true);
        try {
            inflater.setInput(stored);
            byte[] data = new byte[(int) at.size];
            int n = 0;
            while (n < data.length && !inflater.finished()) {
                int got = inflater.inflate(data, n, data.length - n);
                if (got == 0 && (inflater.needsInput() || inflater.needsDictionary())) break;
                n += got;
            }
            if (n != data.length) throw new GamePack.Refused("This copy of the game data is damaged (" + path + ").");
            return data;
        } catch (DataFormatException damaged) {
            throw new GamePack.Refused("This copy of the game data is damaged (" + path + ").");
        } finally {
            inflater.end();
        }
    }

    // ------------------------------------------------------------------ tar

    /** A header without the ustar magic (old tar): its checksum field holds the header's sum. */
    private static boolean looksLikeTar(byte[] header) {
        try {
            long stored = GamePack.octal(header, 148, 8);
            long sum = 0;
            for (int i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? ' ' : header[i] & 0xff;
            return stored == sum;
        } catch (GamePack.Refused notOctal) {
            return false;
        }
    }

    /** The size field: octal, or base-256 (high bit set) for a file over 8 GB, as GNU tar writes it. */
    private static long tarSize(byte[] header) throws GamePack.Refused {
        if ((header[124] & 0x80) == 0) return GamePack.octal(header, 124, 12);
        long value = header[124] & 0x7f;
        for (int i = 125; i < 136; i++) value = (value << 8) | (header[i] & 0xff);
        return value;
    }

    private void indexTar(long size) throws IOException {
        byte[] header = new byte[512];
        long position = 0;
        String longName = null;
        while (position + 512 <= size) {
            if (readAt(file, position, header, 0, 512) != 512) break;
            if (GamePack.allZero(header)) break;
            long length = tarSize(header);
            char type = (char) header[156];
            long data = position + 512;
            position = data + GamePack.padded(length);
            if (type == 'L' || type == 'x') {
                if (length > 1 << 20) throw new GamePack.Refused("This copy of the game data is damaged.");
                byte[] text = new byte[(int) length];
                readAt(file, data, text, 0, text.length);
                String value = new String(text, StandardCharsets.UTF_8);
                if (type == 'L') longName = value.replace("\0", "");
                else {
                    String path = GamePack.paxPath(value);
                    if (path != null) longName = path;
                }
                continue;
            }
            String name = longName != null ? longName : GamePack.headerName(header);
            longName = null;
            if (type == '0' || type == '\0') add(name, new Located(data, length, length, false));
        }
        if (position > size) throw new GamePack.Refused("This copy of the game data is incomplete (the file ends early).");
    }

    // ------------------------------------------------------------------ zip

    private void indexZip(long size) throws IOException {
        // the end of central directory record: in the last 64 KB + 22 bytes
        int tail = (int) Math.min(size, 65535 + 22);
        byte[] end = new byte[tail];
        readAt(file, size - tail, end, 0, tail);
        int eocd = -1;
        for (int i = tail - 22; i >= 0; i--) {
            if (le32(end, i) == 0x06054b50L) { eocd = i; break; }
        }
        if (eocd < 0) throw new GamePack.Refused("This .zip is incomplete (copy it again) or isn't a zip file.");
        long count = le16(end, eocd + 10);
        long directorySize = le32(end, eocd + 12);
        long directoryOffset = le32(end, eocd + 16);
        if (count == 0xffff || directorySize == 0xffffffffL || directoryOffset == 0xffffffffL) {
            // zip64: the locator just before the record points at the zip64 end record
            long locator = size - tail + eocd - 20;
            byte[] loc = new byte[20];
            if (locator < 0 || readAt(file, locator, loc, 0, 20) != 20 || le32(loc, 0) != 0x07064b50L)
                throw new GamePack.Refused("This .zip is damaged.");
            byte[] record = new byte[56];
            if (readAt(file, le64(loc, 8), record, 0, 56) != 56 || le32(record, 0) != 0x06064b50L)
                throw new GamePack.Refused("This .zip is damaged.");
            count = le64(record, 32);
            directorySize = le64(record, 40);
            directoryOffset = le64(record, 48);
        }
        if (directorySize > MAX_CENTRAL_DIRECTORY || directoryOffset + directorySize > size)
            throw new GamePack.Refused("This .zip is damaged or incomplete.");
        byte[] directory = new byte[(int) directorySize];
        readAt(file, directoryOffset, directory, 0, directory.length);
        int at = 0;
        for (long i = 0; i < count; i++) {
            if (at + 46 > directory.length || le32(directory, at) != 0x02014b50L)
                throw new GamePack.Refused("This .zip is damaged.");
            int flags = le16(directory, at + 8);
            int method = le16(directory, at + 10);
            long compressed = le32(directory, at + 20);
            long length = le32(directory, at + 24);
            int nameLength = le16(directory, at + 28);
            int extraLength = le16(directory, at + 30);
            int commentLength = le16(directory, at + 32);
            long local = le32(directory, at + 42);
            String name = new String(directory, at + 46, nameLength, StandardCharsets.UTF_8);
            // zip64 extra field: the 64-bit values of the fields set to 0xffffffff, in this order
            int extra = at + 46 + nameLength, extraEnd = extra + extraLength;
            while (extra + 4 <= extraEnd) {
                int id = le16(directory, extra), dataLength = le16(directory, extra + 2);
                if (id == 0x0001) {
                    int field = extra + 4;
                    if (length == 0xffffffffL) { length = le64(directory, field); field += 8; }
                    if (compressed == 0xffffffffL) { compressed = le64(directory, field); field += 8; }
                    if (local == 0xffffffffL) local = le64(directory, field);
                }
                extra += 4 + dataLength;
            }
            at = extraEnd + commentLength;
            if (name.endsWith("/") || !CDN_PATH.matcher(name).find()) continue;
            if ((flags & 1) != 0) throw new GamePack.Refused("This .zip is encrypted. Make it again without a password.");
            if (method != 0 && method != 8)
                throw new GamePack.Refused("This .zip uses a compression the app can't read. Make it again with the usual"
                        + " (deflate) compression, or none.");
            add(name, new Located(local, compressed, length, method == 8));
        }
    }

    /** Where an entry's data starts: after its local header, whose name and extra field lengths are its own. */
    private long zipDataOffset(long local, String path) throws IOException {
        byte[] header = new byte[30];
        if (readAt(file, local, header, 0, 30) != 30 || le32(header, 0) != 0x04034b50L)
            throw new GamePack.Refused("This .zip is damaged (" + path + ").");
        return local + 30 + le16(header, 26) + le16(header, 28);
    }

    // ------------------------------------------------------------------ bytes

    private static boolean compressed(byte[] head) {
        int b0 = head[0] & 0xff, b1 = head[1] & 0xff, b2 = head[2] & 0xff, b3 = head[3] & 0xff;
        return (b0 == 0x1f && b1 == 0x8b)                                // gzip
                || (b0 == 'B' && b1 == 'Z' && b2 == 'h')                 // bzip2
                || (b0 == 0xfd && b1 == '7' && b2 == 'z' && b3 == 'X')   // xz
                || (b0 == 0x28 && b1 == 0xb5 && b2 == 0x2f && b3 == 0xfd) // zstd
                || (b0 == '7' && b1 == 'z' && b2 == 0xbc && b3 == 0xaf)  // 7z
                || (b0 == 'R' && b1 == 'a' && b2 == 'r' && b3 == '!');   // rar
    }

    /** Reads up to {@code length} bytes at {@code position}; fewer only at the end of the file. */
    private static int readAt(FileChannel file, long position, byte[] buffer, int offset, int length) throws IOException {
        ByteBuffer target = ByteBuffer.wrap(buffer, offset, length);
        int total = 0;
        while (target.hasRemaining()) {
            int n = file.read(target, position + total);
            if (n < 0) break;
            total += n;
        }
        return total;
    }

    private static int le16(byte[] b, int i) {
        return (b[i] & 0xff) | (b[i + 1] & 0xff) << 8;
    }

    private static long le32(byte[] b, int i) {
        return ByteBuffer.wrap(b, i, 4).order(ByteOrder.LITTLE_ENDIAN).getInt() & 0xffffffffL;
    }

    private static long le64(byte[] b, int i) {
        return ByteBuffer.wrap(b, i, 8).order(ByteOrder.LITTLE_ENDIAN).getLong();
    }
}
