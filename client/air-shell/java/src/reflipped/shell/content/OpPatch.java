package reflipped.shell.content;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/**
 * Applies an op list made by tools/swf_ops.py (format "RFLPOPS1", described there) to the uncompressed game SWF.
 * The list holds offsets into the input and the bytes our patches add, nothing of the game itself. Both the input and
 * the result are checked against the SHA-256 hashes in its header.
 */
public final class OpPatch {
    private static final byte[] MAGIC = "RFLPOPS1".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    private static final int HEADER = 8 + 4 + 4 + 32 + 32;

    /** The input isn't the SWF the op list was made for, or the result isn't the expected one. */
    public static final class Mismatch extends IOException {
        public final boolean input;

        Mismatch(boolean input, String message) {
            super(message);
            this.input = input;
        }
    }

    public final long inputSize;
    public final long outputSize;
    public final byte[] inputSha256;
    public final byte[] outputSha256;
    private final byte[] ops;

    public OpPatch(byte[] file) throws IOException {
        if (file.length < HEADER || !Arrays.equals(Arrays.copyOf(file, 8), MAGIC)) throw new IOException("not an op list");
        ByteBuffer header = ByteBuffer.wrap(file, 8, 8).order(ByteOrder.LITTLE_ENDIAN);
        inputSize = header.getInt() & 0xFFFFFFFFL;
        outputSize = header.getInt() & 0xFFFFFFFFL;
        inputSha256 = Arrays.copyOfRange(file, 16, 48);
        outputSha256 = Arrays.copyOfRange(file, 48, 80);
        ops = inflate(file, HEADER);
    }

    /**
     * Writes the patched SWF to `out`. Throws {@link Mismatch} when `input` isn't the SWF this list was made for (its
     * size or hash differs) or when the result's hash doesn't match; `out` then holds an unusable file.
     */
    public void apply(byte[] input, OutputStream out) throws IOException {
        if (input.length != inputSize || !Arrays.equals(Hashes.sha256(input), inputSha256)) {
            throw new Mismatch(true, "the game SWF isn't the one this op list was made for");
        }
        MessageDigest digest = Hashes.sha256();
        int[] at = {0};
        long written = 0;
        while (at[0] < ops.length) {
            int kind = ops[at[0]++] & 0xFF;
            if (kind == 0) {
                long offset = varint(at);
                long length = varint(at);
                if (offset + length > input.length) throw new IOException("op list copies past the end of the SWF");
                out.write(input, (int) offset, (int) length);
                digest.update(input, (int) offset, (int) length);
                written += length;
            } else if (kind == 1) {
                long length = varint(at);
                if (at[0] + length > ops.length) throw new IOException("op list ends inside an insert");
                out.write(ops, at[0], (int) length);
                digest.update(ops, at[0], (int) length);
                at[0] += (int) length;
                written += length;
            } else {
                throw new IOException("unknown op " + kind);
            }
        }
        if (written != outputSize || !Arrays.equals(digest.digest(), outputSha256)) {
            throw new Mismatch(false, "the patched SWF doesn't match the op list's result");
        }
    }

    private long varint(int[] at) throws IOException {
        long value = 0;
        for (int shift = 0; shift < 35; shift += 7) {
            if (at[0] >= ops.length) throw new IOException("op list ends inside a number");
            int b = ops[at[0]++] & 0xFF;
            value |= (long) (b & 0x7F) << shift;
            if (b < 0x80) return value;
        }
        throw new IOException("op list number too long");
    }

    private static byte[] inflate(byte[] data, int offset) throws IOException {
        Inflater inflater = new Inflater();
        inflater.setInput(data, offset, data.length - offset);
        ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(64, (data.length - offset) * 2));
        byte[] buffer = new byte[16384];
        try {
            while (!inflater.finished()) {
                int n = inflater.inflate(buffer);
                if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) throw new IOException("op list is cut short");
                out.write(buffer, 0, n);
            }
        } catch (DataFormatException e) {
            throw new IOException("op list is damaged");
        } finally {
            inflater.end();
        }
        return out.toByteArray();
    }
}
