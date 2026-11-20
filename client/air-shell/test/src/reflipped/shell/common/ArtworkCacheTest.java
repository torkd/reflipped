package reflipped.shell.common;

public final class ArtworkCacheTest {
    private static void check(boolean ok){if(!ok)throw new AssertionError();}
    public static void main(String[] args){
        ArtworkCache<Object> cache=new ArtworkCache<>(10,2,3,200);
        Object a=new Object(),b=new Object(),c=new Object();
        ArtworkCache.Request<Object> first=cache.begin("A",0,false),shared=cache.begin("A",1,false);
        check(first.start&&!shared.start&&first.ticket==shared.ticket);
        check(cache.complete("A",first.ticket,a,5,2));
        check(cache.begin("A",3,false).value==a&&!cache.begin("A",3,false).start);
        ArtworkCache.Request<Object> rb=cache.begin("B",4,false);cache.complete("B",rb.ticket,b,5,5);
        cache.begin("A",6,false);
        ArtworkCache.Request<Object> rc=cache.begin("C",7,false);cache.complete("C",rc.ticket,c,5,8);
        check(cache.bytes()==10&&cache.begin("A",9,false).value==a);
        ArtworkCache.Request<Object> evicted=cache.begin("B",10,false);check(evicted.start&&evicted.value==null);
        cache.complete("B",evicted.ticket,null,0,10);check(!cache.begin("B",11,false).start);
        ArtworkCache.Request<Object> retry=cache.begin("B",211,false);check(retry.start);
        check(!cache.complete("B",evicted.ticket,b,5,212));cache.complete("B",retry.ticket,null,0,212);
        ArtworkCache.Request<Object> refresh=cache.begin("A",213,true);check(refresh.start&&refresh.value==a);
        check(cache.begin("A",214,true).ticket==refresh.ticket&&!cache.begin("A",214,true).start);
        check(cache.begin("A",214,false).value==a&&cache.begin("A",214,false).ticket==refresh.ticket);
        cache.complete("A",refresh.ticket,null,0,215);check(cache.begin("A",216,false).value==a);
        check(cache.begin("B",216,true).start);
        ArtworkBinding binding=new ArtworkBinding();long old=binding.bind("A"),current=binding.bind("B");
        check(!binding.accepts("A",old)&&binding.accepts("B",current));binding.close();check(!binding.accepts("B",current));
        ArtworkCache<Object> byteBound=new ArtworkCache<>(10,10,2,100);
        ArtworkCache.Request<Object> heavy=byteBound.begin("heavy",0,false);byteBound.complete("heavy",heavy.ticket,a,6,1);
        ArtworkCache.Request<Object> light=byteBound.begin("light",2,false);byteBound.complete("light",light.ticket,b,5,3);
        check(byteBound.bytes()==5&&byteBound.begin("heavy",4,false).value==null);
        ArtworkCache<Object> limited=new ArtworkCache<>(10,2,1,100);
        ArtworkCache.Request<Object> flight=limited.begin("X",0,false);check(!limited.begin("Y",1,false).start&&!limited.complete("Y",null,b,1,1));
        limited.close();check(!limited.complete("X",flight.ticket,a,5,2)&&limited.bytes()==0);
        check(!limited.begin("X",3,false).start);
        ArtworkCache<Object> many=new ArtworkCache<>(1024,100,52,100,100);
        java.util.Map<String,ArtworkCache.Ticket> running=new java.util.LinkedHashMap<>();
        for(int i=0;i<100;i++){String key="image"+i;ArtworkCache.Request<Object> request=many.begin(key,0,false);if(request.start)running.put(key,request.ticket);}
        check(running.size()==52&&many.deferredCount()==48);
        int completed=0;
        while(!running.isEmpty()){
            String key=running.keySet().iterator().next();ArtworkCache.Ticket ticket=running.remove(key);check(many.complete(key,ticket,a,1,1));completed++;
            ArtworkCache.Deferred next;
            while((next=many.takeDeferred())!=null){ArtworkCache.Request<Object> request=many.begin(next.key,2,next.refresh);check(request.start);running.put(next.key,request.ticket);}
        }
        check(completed==100&&many.deferredCount()==0);
        ArtworkCache<Object> changed=new ArtworkCache<>(10,2,1,100,2);
        ArtworkCache.Request<Object> active=changed.begin("active",0,false);changed.begin("oldURL",1,false);check(changed.deferredCount()==1);
        changed.forgetDeferred("oldURL");changed.complete("active",active.ticket,a,1,2);check(changed.takeDeferred()==null);
        changed.begin("busy",3,false);check(changed.begin("active",4,true).value==a&&changed.deferredCount()==1);
        changed.close();check(changed.deferredCount()==0&&changed.takeDeferred()==null);
        System.out.println("Artwork single-flight, synchronous hits, byte LRU, stale completion, cooldown and close checks passed");
    }
}
