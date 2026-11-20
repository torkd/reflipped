package reflipped.shell.content;

import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** SHA-256 helpers. */
public final class Hashes {
    private Hashes() {
    }

    public static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e); // every Android and Java has it
        }
    }

    public static byte[] sha256(byte[] data) {
        return sha256().digest(data);
    }

    public static byte[] sha256(ByteBuffer data) {
        MessageDigest digest = sha256();
        digest.update(data);
        return digest.digest();
    }

    public static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
        }
        return out.toString();
    }
}
