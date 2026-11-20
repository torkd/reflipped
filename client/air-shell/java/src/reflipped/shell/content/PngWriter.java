package reflipped.shell.content;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;

/**
 * A small PNG encoder: 8-bit RGBA, non-interlaced, one filter per row chosen by the usual minimum-sum heuristic.
 * Pure Java, so the pixels are written exactly as given (Android's Bitmap.compress would round them through
 * premultiplied alpha) and a desktop test can run it.
 */
public final class PngWriter {
    private PngWriter() {
    }

    /** `argb`: non-premultiplied 0xAARRGGBB pixels, row by row. */
    public static byte[] encode(int[] argb, int width, int height) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(argb.length);
        out.write(new byte[] {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'});
        byte[] header = new byte[13];
        putInt(header, 0, width);
        putInt(header, 4, height);
        header[8] = 8;  // bits per channel
        header[9] = 6;  // RGBA
        chunk(out, "IHDR", header);

        int stride = width * 4;
        byte[] previous = new byte[stride];
        byte[] row = new byte[stride];
        byte[][] candidates = new byte[5][stride];
        ByteArrayOutputStream idat = new ByteArrayOutputStream(argb.length);
        Deflater deflater = new Deflater(9);
        try (DeflaterOutputStream z = new DeflaterOutputStream(idat, deflater, 1 << 16)) {
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    int p = argb[y * width + x];
                    row[x * 4] = (byte) (p >> 16);
                    row[x * 4 + 1] = (byte) (p >> 8);
                    row[x * 4 + 2] = (byte) p;
                    row[x * 4 + 3] = (byte) (p >>> 24);
                }
                int best = 0;
                long bestSum = Long.MAX_VALUE;
                for (int type = 0; type < 5; type++) {
                    long sum = filter(type, row, previous, candidates[type]);
                    if (sum < bestSum) {
                        bestSum = sum;
                        best = type;
                    }
                }
                z.write(best);
                z.write(candidates[best]);
                byte[] swap = previous;
                previous = row;
                row = swap;
            }
        } finally {
            deflater.end();
        }
        chunk(out, "IDAT", idat.toByteArray());
        chunk(out, "IEND", new byte[0]);
        return out.toByteArray();
    }

    /** Filters `row` with filter `type` into `out`; returns the sum of the filtered bytes as signed values. */
    private static long filter(int type, byte[] row, byte[] prev, byte[] out) {
        long sum = 0;
        for (int i = 0; i < row.length; i++) {
            int x = row[i] & 255;
            int a = i >= 4 ? row[i - 4] & 255 : 0;
            int b = prev[i] & 255;
            int c = i >= 4 ? prev[i - 4] & 255 : 0;
            int predicted;
            switch (type) {
                case 1: predicted = a; break;
                case 2: predicted = b; break;
                case 3: predicted = (a + b) >> 1; break;
                case 4: predicted = paeth(a, b, c); break;
                default: predicted = 0;
            }
            byte v = (byte) (x - predicted);
            out[i] = v;
            sum += Math.abs((int) v);
        }
        return sum;
    }

    private static int paeth(int a, int b, int c) {
        int p = a + b - c;
        int pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        if (pa <= pb && pa <= pc) return a;
        return pb <= pc ? b : c;
    }

    private static void chunk(ByteArrayOutputStream out, String type, byte[] data) {
        byte[] head = new byte[8];
        putInt(head, 0, data.length);
        for (int i = 0; i < 4; i++) head[4 + i] = (byte) type.charAt(i);
        CRC32 crc = new CRC32();
        crc.update(head, 4, 4);
        crc.update(data, 0, data.length);
        byte[] tail = new byte[4];
        putInt(tail, 0, (int) crc.getValue());
        out.write(head, 0, 8);
        out.write(data, 0, data.length);
        out.write(tail, 0, 4);
    }

    private static void putInt(byte[] b, int at, int v) {
        b[at] = (byte) (v >>> 24);
        b[at + 1] = (byte) (v >>> 16);
        b[at + 2] = (byte) (v >>> 8);
        b[at + 3] = (byte) v;
    }
}
