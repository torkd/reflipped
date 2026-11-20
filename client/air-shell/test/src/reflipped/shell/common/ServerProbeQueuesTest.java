package reflipped.shell.common;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public final class ServerProbeQueuesTest {
    public static void main(String[] args) throws Exception {
        ServerProbeQueues queues=new ServerProbeQueues();
        CountDownLatch blocked=new CountDownLatch(3),release=new CountDownLatch(1),joined=new CountDownLatch(1);
        Runnable slow=() -> {blocked.countDown();try{release.await();}catch(InterruptedException expected){Thread.currentThread().interrupt();}};
        try {
            queues.submit(ServerProbeQueues.Priority.BACKGROUND,slow);
            queues.submit(ServerProbeQueues.Priority.BACKGROUND,slow);
            queues.submit(ServerProbeQueues.Priority.INTERACTIVE,slow);
            if(!blocked.await(2,TimeUnit.SECONDS))throw new AssertionError("Slow probes not running");
            for(int i=0;i<40;i++)queues.submit(ServerProbeQueues.Priority.BACKGROUND,slow);
            queues.submit(ServerProbeQueues.Priority.JOIN,joined::countDown);
            if(!joined.await(1,TimeUnit.SECONDS))throw new AssertionError("Join waited behind bulk or selection probes");
            if(release.getCount()!=1)throw new AssertionError("Test released background work early");
            System.out.println("Fresh Join runs while bulk and selection workers remain blocked");
        } finally {release.countDown();queues.close();}
    }
}
