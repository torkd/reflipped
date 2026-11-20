package reflipped.shell.common;


public final class BrowserStartTest {
    public static void main(String[] args) {
        for(String initial:new String[]{null,"","  ","https://example.org/deployment","https://user:secret@example.org"}) {
            BrowserStart community=new BrowserStart(initial);
            if(!community.address.isEmpty()||!community.origin.isEmpty())throw new AssertionError("Fresh/invalid selection blocks Community");
            BrowserStart empty=new BrowserStart(initial);
            if(!empty.origin.isEmpty())throw new AssertionError("Fresh empty catalogue cannot open My servers/Add");
        }
        BrowserStart existing=new BrowserStart("http://EXAMPLE.org:80/");
        if(!"http://example.org".equals(existing.origin))throw new AssertionError("Known alias selection lost");
        BrowserStart removed=new BrowserStart("http://example.org");
        if(!"http://example.org".equals(removed.origin))throw new AssertionError("Empty My servers view not reachable");
        try {ServerIdentity.origin("");throw new AssertionError("Credential origin policy was relaxed");}catch(IllegalArgumentException expected){}
        System.out.println("Fresh/unknown browser starts keep an optional selection without weakening credential origins");
    }
}
