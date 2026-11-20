package reflipped.shell.common;

import java.util.Arrays;
import java.util.List;

/** A bare home-network address is tried over HTTP first; public names and typed schemes are left alone. */
public final class AddressCandidatesTest {
    private static void expect(String typed, String... tries) {
        List<String> result = AddressCandidates.of(typed);
        if (!result.equals(Arrays.asList(tries))) throw new AssertionError(typed + " -> " + result);
    }

    public static void main(String[] args) {
        expect("10.0.2.2:8100", "http://10.0.2.2:8100", "https://10.0.2.2:8100");
        expect("192.168.1.20:8000/", "http://192.168.1.20:8000", "https://192.168.1.20:8000");
        expect("localhost:8000", "http://localhost:8000", "https://localhost:8000");
        expect("gamebox:8000", "http://gamebox:8000", "https://gamebox:8000");
        expect("gamebox.local", "http://gamebox.local", "https://gamebox.local");
        expect("[::1]:8000", "http://[::1]:8000", "https://[::1]:8000");
        expect("reflipped.example.org", "https://reflipped.example.org");
        expect("8.8.8.8", "https://8.8.8.8");
        expect("http://reflipped.example.org", "http://reflipped.example.org");
        expect("https://192.168.1.20:8000", "https://192.168.1.20:8000");
        expect("http://example.org/path");
        expect("");
        System.out.println("Address candidate checks passed");
    }
}
