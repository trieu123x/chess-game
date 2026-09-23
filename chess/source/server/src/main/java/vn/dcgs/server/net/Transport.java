package vn.dcgs.server.net;

import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Duong ghi byte xuong mot ket noi. Co hai ban hien thuc, va do chinh la noi
 * dung cua thi nghiem E2:
 *
 *   {@link NioServer.NioTransport}      - mot Selector dung chung, khong thread
 *                                         nao rieng cho ket noi nay.
 *   {@link BlockingServer.SocketTransport} - mot thread doc + mot thread ghi cho
 *                                         RIENG ket noi nay (baseline).
 *
 * Moi thu phia tren {@link Connection} (hang doi gui, backpressure, rate limit,
 * dinh tuyen, logic van dau) dung y nguyen o ca hai che do — neu khong thi phep
 * so sanh o E2 khong con cong bang.
 */
public interface Transport {

    /**
     * Ghi nhieu nhat co the. Ban NIO co the ghi thieu (tra ve < remaining);
     * ban blocking ghi het roi moi tra ve.
     */
    int write(ByteBuffer buffer) throws IOException;

    /** Bao cho ben ghi biet co byte moi trong hang doi. Goi tu bat ky thread nao. */
    void wantWrite(Connection connection);

    /** NIO: bat/tat OP_WRITE. Blocking: khong lam gi (thread ghi tu cho). */
    void writeInterest(boolean enabled);

    /** Dong ket noi phia duoi (socket/channel). */
    void close() throws IOException;

    /** Tra ve dia chi ben kia cua ket noi (dung cho log). */
    String remote();
}
