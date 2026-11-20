package reflipped.shell.content;

import java.io.IOException;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/** The uncompressed form of a SWF ("FWS"), on which the op list works: zlib output differs between implementations. */
public final class Swf {
    private Swf() {
    }

    /**
     * Like {@link #uncompressed(byte[])}, reading the SWF from a stream, so the compressed file never has to be in
     * memory beside the result (14.6 MB less at the peak). Reads `in` to its end.
     */
    public static byte[] uncompressed(java.io.InputStream in) throws IOException {
        byte[] header = new byte[8];
        int got = 0;
        while (got < 8) {
            int n = in.read(header, got, 8 - got);
            if (n < 0) throw new IOException("not a SWF");
            got += n;
        }
        boolean plain = header[0] == 'F' && header[1] == 'W' && header[2] == 'S';
        if (!plain && (header[0] != 'C' || header[1] != 'W' || header[2] != 'S')) throw new IOException("not a zlib SWF");
        long length = (header[4] & 0xFFL) | (header[5] & 0xFFL) << 8 | (header[6] & 0xFFL) << 16 | (header[7] & 0xFFL) << 24;
        if (length < 8 || length > 256L * 1024 * 1024) throw new IOException("unlikely SWF length " + length);
        byte[] out = new byte[(int) length];
        System.arraycopy(header, 0, out, 0, 8);
        out[0] = 'F';
        Inflater inflater = new Inflater();
        java.io.InputStream body = plain ? in : new java.util.zip.InflaterInputStream(new java.io.FilterInputStream(in) {
            @Override
            public void close() {
            }
        }, inflater, 1 << 16);
        try {
            int at = 8;
            while (at < out.length) {
                int n = body.read(out, at, out.length - at);
                if (n < 0) break;
                at += n;
            }
            if (at != out.length || body.read() >= 0) throw new IOException("SWF body doesn't match its length");
            byte[] rest = new byte[1 << 16];
            while (in.read(rest) >= 0) {
                // the bytes after the zlib stream (none in a sound file): read so the caller's hash covers them
            }
        } catch (java.util.zip.ZipException e) {
            throw new IOException("SWF body is damaged");
        } finally {
            inflater.end();
        }
        return out;
    }

    /** `swf` itself if it is uncompressed, else its body inflated behind the same header with "FWS". */
    public static byte[] uncompressed(byte[] swf) throws IOException {
        if (swf.length < 8) throw new IOException("not a SWF");
        if (swf[0] == 'F' && swf[1] == 'W' && swf[2] == 'S') return swf;
        if (swf[0] != 'C' || swf[1] != 'W' || swf[2] != 'S') throw new IOException("not a zlib SWF");
        long length = (swf[4] & 0xFFL) | (swf[5] & 0xFFL) << 8 | (swf[6] & 0xFFL) << 16 | (swf[7] & 0xFFL) << 24;
        if (length < 8 || length > 256L * 1024 * 1024) throw new IOException("unlikely SWF length " + length);
        byte[] out = new byte[(int) length];
        System.arraycopy(swf, 0, out, 0, 8);
        out[0] = 'F';
        Inflater inflater = new Inflater();
        inflater.setInput(swf, 8, swf.length - 8);
        try {
            int at = 8;
            while (at < out.length) {
                int n = inflater.inflate(out, at, out.length - at);
                if (n == 0 && (inflater.finished() || inflater.needsInput() || inflater.needsDictionary())) break;
                at += n;
            }
            if (at != out.length || !inflater.finished()) throw new IOException("SWF body doesn't match its length");
        } catch (DataFormatException e) {
            throw new IOException("SWF body is damaged");
        } finally {
            inflater.end();
        }
        return out;
    }
}
