package vn.dcgs.server.net;

import vn.dcgs.common.CgpException;
import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.FrameCodec;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.SocketChannel;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.UUID;

/**
 * Mot ket noi client.
 *
 * **Van de dong bo:** byte den tu thread selector, nhung message gui di lai
 * sinh ra tu thread game (GameActor broadcast nuoc di cho ca hai nguoi choi).
 * Neu hai ben cung cham vao hang doi gui va vao `interestOps` thi se hong.
 *
 * Cach giai: hang doi gui duoc bao ve bang khoa cua chinh Connection; thread
 * game chi ENQUEUE roi danh thuc selector; viec GHI xuong socket luon chay
 * tren thread selector. Nho vay `SocketChannel` khong bao gio bi hai thread
 * ghi cung luc, va thread game khong bao gio bi chan vi mot client doc cham.
 */
public final class Connection {

    public enum State { NEW, AUTHENTICATED, CLOSING }

    /** Selector duoc danh thuc de di gui phan vua xep hang. */
    public interface WriteWaker {
        void wake(Connection connection);
    }

    private final long id;
    private final SocketChannel channel;
    private final SelectionKey key;
    private final WriteWaker waker;
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

    private final long connectedAt = System.currentTimeMillis();
    private volatile long lastSeenAt = System.currentTimeMillis();
    private volatile long rttMs;
    private volatile long heartbeatSentAt;

    private long windowStart = System.currentTimeMillis();
    private int messagesInWindow;
    private int rateViolations;

    private long bytesIn;
    private long bytesOut;

    public Connection(long id, SocketChannel channel, SelectionKey key,
                      int sendQueueMax, WriteWaker waker) throws IOException {
        this.id = id;
        this.channel = channel;
        this.key = key;
        this.sendQueueMax = sendQueueMax;
        this.waker = waker;
        this.remote = String.valueOf(channel.getRemoteAddress());
    }

    public long id() {
        return id;
    }

    public SocketChannel channel() {
        return channel;
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
                outbound.addLast(frame);
            }
        }
        if (overflow) {
            markClosing();
            throw new CgpException(ErrorCode.SERVER_OVERLOADED,
                    "hang doi gui day (" + sendQueueMax + "), client doc qua cham");
        }
        waker.wake(this);
    }

    /** Ghi xuong socket. CHI duoc goi tren thread selector. */
    void flush() {
        try {
            for (;;) {
                ByteBuffer head;
                synchronized (outbound) {
                    head = outbound.peekFirst();
                }
                if (head == null) {
                    break;
                }
                channel.write(head);
                if (head.hasRemaining()) {
                    if (key.isValid()) {
                        key.interestOps(key.interestOps() | SelectionKey.OP_WRITE);
                    }
                    return;
                }
                synchronized (outbound) {
                    outbound.pollFirst();
                }
            }
            if (key.isValid()) {
                key.interestOps(key.interestOps() & ~SelectionKey.OP_WRITE);
            }
        } catch (IOException failure) {
            // Client bien mat giua luc ghi (X05): de vong lap selector don dep.
            markClosing();
        }
    }

    public boolean hasPendingWrites() {
        synchronized (outbound) {
            return !outbound.isEmpty();
        }
    }

    @Override
    public String toString() {
        return "#" + id + (username == null ? "(chua dang nhap)" : "(" + username + ")");
    }
}
