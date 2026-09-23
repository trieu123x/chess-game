package vn.dcgs.server.net;

import vn.dcgs.common.CgpException;
import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.FrameCodec;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Mot ket noi client.
 *
 * **Van de dong bo:** byte den tu thread doc, nhung message gui di lai sinh ra
 * tu thread game (GameActor broadcast nuoc di cho ca hai nguoi choi va cho
 * khan gia). Neu hai ben cung cham vao hang doi gui thi se hong.
 *
 * Cach giai: hang doi gui duoc bao ve bang khoa cua chinh Connection; thread
 * game chi ENQUEUE roi danh thuc ben ghi; viec GHI xuong socket luon chay tren
 * dung mot thread (thread selector o che do nio, thread ghi rieng o che do
 * blocking). Nho vay socket khong bao gio bi hai thread ghi cung luc, va thread
 * game khong bao gio bi chan vi mot client doc cham.
 */
public final class Connection {

    public enum State { NEW, AUTHENTICATED, CLOSING }

    private final long id;
    private final Transport transport;
    private final FrameCodec.Decoder decoder = new FrameCodec.Decoder();
    private final Deque<ByteBuffer> outbound = new ArrayDeque<>();
    private final int sendQueueMax;
    private final String remote;

    private volatile State state = State.NEW;
    private volatile long userId;
    private volatile String username;
    private volatile UUID sessionToken;
    /** Van dang danh, de dinh tuyen MOVE/RESIGN ve dung GameActor. */
    private volatile long gameId;
    /** Cac van dang xem voi tu cach khan gia (X59: dong tab thi phai go het). */
    private final Set<Long> spectating = ConcurrentHashMap.newKeySet();

    private final long connectedAt = System.currentTimeMillis();
    private volatile long lastSeenAt = System.currentTimeMillis();
    private volatile long rttMs;
    private volatile long heartbeatSentAt;

    private long windowStart = System.currentTimeMillis();
    private int messagesInWindow;
    private int rateViolations;

    private volatile long bytesIn;
    private volatile long bytesOut;
    private volatile long messagesOut;
    private volatile long droppedForSlowness;

    public Connection(long id, Transport transport, int sendQueueMax) {
        this.id = id;
        this.transport = transport;
        this.sendQueueMax = sendQueueMax;
        this.remote = transport.remote();
    }

    public long id() {
        return id;
    }

    public Transport transport() {
        return transport;
    }

    public FrameCodec.Decoder decoder() {
        return decoder;
    }

    public String remote() {
        return remote;
    }

    public State state() {
        return state;
    }

    public boolean authenticated() {
        return state == State.AUTHENTICATED;
    }

    public long userId() {
        return userId;
    }

    public String username() {
        return username;
    }

    public UUID sessionToken() {
        return sessionToken;
    }

    public long gameId() {
        return gameId;
    }

    public void setGameId(long gameId) {
        this.gameId = gameId;
    }

    public Set<Long> spectating() {
        return spectating;
    }

    public long connectedAt() {
        return connectedAt;
    }

    public long lastSeenAt() {
        return lastSeenAt;
    }

    public long rttMs() {
        return rttMs;
    }

    public long bytesIn() {
        return bytesIn;
    }

    public long bytesOut() {
        return bytesOut;
    }

    public long messagesOut() {
        return messagesOut;
    }

    public long droppedForSlowness() {
        return droppedForSlowness;
    }

    public void countIn(int bytes) {
        bytesIn += bytes;
    }

    /**
     * Danh dau moc gui HEARTBEAT de tu do RTT.
     *
     * Con so nay moi duoc dung de tru gio; so lieu client bao len khong duoc
     * tin (X33) vi khai RTT lon la duoc cong them thoi gian.
     */
    public void markHeartbeatSent() {
        heartbeatSentAt = System.currentTimeMillis();
    }

    public void recordHeartbeatAck() {
        if (heartbeatSentAt == 0) {
            return;
        }
        long sample = System.currentTimeMillis() - heartbeatSentAt;
        heartbeatSentAt = 0;
        rttMs = rttMs == 0 ? sample : (rttMs * 3 + sample) / 4;
    }

    public void touch() {
        lastSeenAt = System.currentTimeMillis();
    }

    public void authenticate(long userId, String username, UUID sessionToken) {
        this.state = State.AUTHENTICATED;
        this.userId = userId;
        this.username = username;
        this.sessionToken = sessionToken;
    }

    public void markClosing() {
        state = State.CLOSING;
        signalWriter();
    }

    public boolean allowMessage(int maxPerSecond) {
        long now = System.currentTimeMillis();
        if (now - windowStart >= 1_000) {
            windowStart = now;
            messagesInWindow = 0;
        }
        if (++messagesInWindow <= maxPerSecond) {
            return true;
        }
        rateViolations++;
        return false;
    }

    public boolean overRateLimitRepeatedly() {
        return rateViolations >= 3;
    }

    // ---------------------------------------------------------------- gui

    /**
     * Xep mot frame vao hang doi gui. Goi duoc tu BAT KY thread nao.
     *
     * Hang doi day nghia la client doc khong kip (X04): dong ket noi do thay
     * vi de server phinh bo nho vi mot client cham.
     */
    public void send(ByteBuffer frame) {
        boolean overflow = false;
        synchronized (outbound) {
            if (state == State.CLOSING) {
                return;
            }
            if (outbound.size() >= sendQueueMax) {
                overflow = true;
            } else {
                bytesOut += frame.remaining();
                messagesOut++;
                outbound.addLast(frame);
                outbound.notifyAll();
            }
        }
        if (overflow) {
            markClosing();
            throw new CgpException(ErrorCode.SERVER_OVERLOADED,
                    "hang doi gui day (" + sendQueueMax + "), client doc qua cham");
        }
        transport.wantWrite(this);
    }

    /**
     * Gui nhung duoc phep BO neu hang doi day, thay vi dong ket noi.
     *
     * Dung cho khan gia: nguoi choi luon duoc uu tien, con khan gia doc cham
     * thi bi bo qua chu khong duoc lam cham ca ban co (X58).
     *
     * @return false neu frame bi bo
     */
    public boolean offer(ByteBuffer frame) {
        synchronized (outbound) {
            if (state == State.CLOSING) {
                return false;
            }
            if (outbound.size() >= sendQueueMax) {
                droppedForSlowness++;
                return false;
            }
            bytesOut += frame.remaining();
            messagesOut++;
            outbound.addLast(frame);
            outbound.notifyAll();
        }
        transport.wantWrite(this);
        return true;
    }

    /**
     * Ghi xuong socket.
     *
     * Thuong le chi thread so huu viec ghi goi ham nay (thread selector o che do
     * nio, thread ghi rieng o che do blocking). Ngoai le duy nhat la luc dong
     * ket noi: ben dong phai co gang day not frame ERROR cuoi cung ra ngoai.
     * Vi vay khoa `writeLock` — de hai duong do khong bao gio ghi xen ke nhau
     * va lam vo khung CGP cua client.
     */
    void flush() {
        synchronized (writeLock) {
            flushLocked();
        }
    }

    private final Object writeLock = new Object();

    private void flushLocked() {
        try {
            for (;;) {
                ByteBuffer head;
                synchronized (outbound) {
                    head = outbound.peekFirst();
                }
                if (head == null) {
                    break;
                }
                transport.write(head);
                if (head.hasRemaining()) {
                    transport.writeInterest(true);
                    return;
                }
                synchronized (outbound) {
                    outbound.pollFirst();
                }
            }
            transport.writeInterest(false);
        } catch (IOException failure) {
            // Client bien mat giua luc ghi (X05): de vong lap ben ngoai don dep.
            markClosing();
        }
    }

    public boolean hasPendingWrites() {
        synchronized (outbound) {
            return !outbound.isEmpty();
        }
    }

    /** Cho co byte de ghi. Dung o che do blocking, tren thread ghi cua ket noi. */
    public void awaitPendingWrites(long timeoutMs) throws InterruptedException {
        synchronized (outbound) {
            if (outbound.isEmpty() && state != State.CLOSING) {
                outbound.wait(timeoutMs);
            }
        }
    }

    public void signalWriter() {
        synchronized (outbound) {
            outbound.notifyAll();
        }
    }

    @Override
    public String toString() {
        return "#" + id + (username == null ? "(chua dang nhap)" : "(" + username + ")");
    }
}
