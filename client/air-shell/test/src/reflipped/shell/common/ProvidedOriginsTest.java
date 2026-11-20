package reflipped.shell.common;

import java.util.Arrays;
public final class ProvidedOriginsTest {
    public static void main(String[] args){
        ProvidedOrigins provided=new ProvidedOrigins(Arrays.asList("http://EXAMPLE.org:80/","http://example.org"));
        if(!provided.contains("http://example.org/")||provided.contains("https://example.org")||provided.contains("http://unlisted.example"))throw new AssertionError();
        // Remote reply claims never enter the trusted-origin set.
        String claimedProvided="http://unlisted.example";
        if(provided.contains(claimedProvided))throw new AssertionError("Remote metadata spoofed a pin");
        if(provided.contains("")||provided.contains(null))throw new AssertionError();
        System.out.println("Provided membership uses trusted canonical origins only, never remote claims");
    }
}
