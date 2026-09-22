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
 * Giu ba thu ma lop mang can: bo giai ma dang do (vi TCP khong giu ranh gioi
 * message), hang doi gui co gioi han, va trang thai phien.
 *
 * Hang doi gui co gioi han la co che backpressure (ngoai le X04): client doc
 * cham thi server khong duoc phinh bo nho vo han vi no — vuot nguong thi dong
 * ket noi do, cac ket noi khac khong bi anh huong.
 */
public final class Connection {

    public enum State { NEW, AUTHENTICATED, CLOSING }

    private final long id;
    private final SocketChannel channel;
    private final SelectionKey key;
    private final FrameCodec.Decoder decoder = new FrameCodec.Decoder();
    private final Deque<ByteBuffer> outbound = new ArrayDeque<>();
    private final int sendQueueMax;
    private final String remote;

    private State state = State.NEW;
    private long userId;
    private String username;
    private UUID sessionToken;

    private final long connectedAt = System.currentTimeMillis();
    private long lastSeenAt = System.currentTimeMillis();
    private long rttMs;

    // Rate limit dang token bucket, moi giay nap lai (X03).
    private long windowStart = System.currentTimeMillis();
    private int messagesInWindow;
    private int rateViolations;

    public Connection(long id, SocketChannel channel, SelectionKey key, int sendQueueMax) throws IOException {
        this.id = id;
        this.channel = channel;
        this.key = key;
        this.sendQueueMax = sendQueueMax;
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

    public long connectedAt() {
        return connectedAt;
    }

    public long lastSeenAt() {
        return lastSeenAt;
    }

    public long rttMs() {
        return rttMs;
    }

    /** RTT do server TU DO qua chu trinh heartbeat — khong tin so client bao (X33). */
    public void recordRtt(long sampleMs) {
        this.rttMs = rttMs == 0 ? sampleMs : (rttMs * 3 + sampleMs) / 4;
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

    /**
     * @return false neu client gui qua nhanh (X03). Ben goi tra ERROR 4005;
     *         vi pham 3 lan thi dong ket noi.
     */
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

    public void send(ByteBuffer frame) {
        if (state == State.CLOSING) {
            return;
        }
        if (outbound.size() >= sendQueueMax) {
            throw new CgpException(ErrorCode.SERVER_OVERLOADED,
                    "hang doi gui day (" + sendQueueMax + "), client doc qua cham");
        }
        outbound.addLast(frame);
        flush();
    }

    /** Gui het muc co the; con du thi bat OP_WRITE de selector goi lai. */
    public void flush() {
        try {
            while (!outbound.isEmpty()) {
                ByteBuffer head = outbound.peekFirst();
                channel.write(head);
                if (head.hasRemaining()) {
                    key.interestOps(key.interestOps() | SelectionKey.OP_WRITE);
                    return;
                }
                outbound.pollFirst();
            }
            key.interestOps(key.interestOps() & ~SelectionKey.OP_WRITE);
        } catch (IOException failure) {
            // Client bien mat giua luc ghi (X05): khong nem len tren, de vong
            // lap selector don dep binh thuong.
            markClosing();
        }
    }

    public boolean hasPendingWrites() {
        return !outbound.isEmpty();
    }

    @Override
    public String toString() {
        return "#" + id + (username == null ? "(chua dang nhap)" : "(" + username + ")");
    }
}
