package vn.dcgs.server.net;

import vn.dcgs.server.Config;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * Lop mang che do `server.io=nio` (de xuat - dong gop N4).
 *
 * MOT Selector duy nhat lo accept, doc va ghi cho TAT CA ket noi. Logic van dau
 * chay tren thread pool rieng (GameService); thread do chi XEP HANG message roi
 * danh thuc selector, nen socket luon chi co mot thread ghi vao.
 *
 * So thread cua tien trinh vi vay khong phu thuoc vao so ket noi - do chinh la
 * con so doi chung voi {@link BlockingServer} o thi nghiem E2.
 */
public final class NioServer implements CgpServer {

    private final ServerCore core;
    private final int port;
    private final String bind;
    private final int maxConnections;
    private final int sendQueueMax;

    /** Ket noi co byte cho gui, do thread game xep vao (xem Connection). */
    private final ConcurrentLinkedQueue<Connection> needsFlush = new ConcurrentLinkedQueue<>();
    private final ByteBuffer readBuffer = ByteBuffer.allocate(16 * 1024);

    private Selector selector;
    private ServerSocketChannel acceptor;
    private volatile boolean running;

    public NioServer(Config config, ServerCore core) {
        this.core = core;
        this.port = config.getInt("server.port", 5555);
        this.bind = config.get("server.bind", "0.0.0.0");
        this.maxConnections = config.getInt("server.maxConnections", 1000);
        this.sendQueueMax = config.getInt("conn.sendQueueMax", 256);
    }

    @Override
    public void start() throws IOException {
        selector = Selector.open();
        acceptor = ServerSocketChannel.open();
        acceptor.configureBlocking(false);
        acceptor.socket().setReuseAddress(true);
        acceptor.bind(new InetSocketAddress(bind, port), 512);   // backlog cho bao reconnect (X08)
        acceptor.register(selector, SelectionKey.OP_ACCEPT);
        running = true;
        System.out.printf("Lang nghe CGP tren %s:%d (nio, format=%s, toi da %d ket noi)%n",
                bind, port, core.format().name(), maxConnections);
    }

    @Override
    public void run() {
        long lastPeriodic = System.currentTimeMillis();
        while (running) {
            try {
                selector.select(200);

                Iterator<SelectionKey> keys = selector.selectedKeys().iterator();
                while (keys.hasNext()) {
                    SelectionKey key = keys.next();
                    keys.remove();
                    if (!key.isValid()) {
                        continue;
                    }
                    if (key.isAcceptable()) {
                        accept();
                    } else if (key.isReadable()) {
                        read(key);
                    } else if (key.isWritable()) {
                        ((Connection) key.attachment()).flush();
                    }
                }

                // Message do thread game xep vao duoc ghi o day - tren thread selector.
                Connection pending;
                while ((pending = needsFlush.poll()) != null) {
                    if (pending.state() != Connection.State.CLOSING) {
                        pending.flush();
                    }
                }

                long now = System.currentTimeMillis();
                if (now - lastPeriodic >= 1_000) {
                    lastPeriodic = now;
                    core.periodic(now);
                    closeExpiredLingering(now);
                }
            } catch (IOException failure) {
                if (running) {
                    System.err.println("Loi vong lap selector: " + failure.getMessage());
                }
            }
        }
    }

    // ---------------------------------------------------------------- accept

    private void accept() throws IOException {
        SocketChannel channel = acceptor.accept();
        if (channel == null) {
            return;
        }
        if (core.openConnections() >= maxConnections) {
            // Bao ve cac van dang chay thay vi nhan them roi cung cham (X08).
            core.countRejected();
            try {
                channel.configureBlocking(true);
                channel.write(core.overloadedFrame());
            } catch (IOException ignored) {
                // Client co the da bo di, khong sao.
            } finally {
                channel.close();
            }
            return;
        }

        channel.configureBlocking(false);
        channel.socket().setTcpNoDelay(true);      // nuoc di nho, khong cho Nagle gom goi
        channel.socket().setKeepAlive(true);       // phu them cho heartbeat o tang duoi (X01)
        SelectionKey key = channel.register(selector, SelectionKey.OP_READ);

        Connection connection = new Connection(core.nextConnectionId(),
                new NioTransport(channel, key), sendQueueMax);
        key.attach(connection);
        core.register(connection);
    }

    // ------------------------------------------------------------------ doc

    private void read(SelectionKey key) {
        Connection connection = (Connection) key.attachment();
        SocketChannel channel = (SocketChannel) key.channel();
        readBuffer.clear();

        int count;
        try {
            count = channel.read(readBuffer);
        } catch (IOException failure) {
            core.close(connection, null);
            return;
        }
        if (lingering.containsKey(key)) {
            // Ket noi da bi tu choi va dang nan lai: nuot byte den sau roi vut
            // bo, de client kip doc frame loi cuoi cung thay vi an mot RST.
            if (count < 0) {
                hardClose(key);
            }
            return;
        }
        if (count < 0) {
            core.close(connection, null);
            return;
        }
        core.onBytes(connection, readBuffer.array(), count);
    }

    // ------------------------------------------------------------- nan lai

    /** Bao lau thi thoi khong cho client spam nua. */
    private static final long LINGER_MS = 500;

    private final Map<SelectionKey, Long> lingering = new ConcurrentHashMap<>();

    private void linger(SelectionKey key) {
        lingering.put(key, System.currentTimeMillis() + LINGER_MS);
    }

    private void hardClose(SelectionKey key) {
        lingering.remove(key);
        try {
            key.channel().close();
        } catch (IOException ignored) {
            // Da dong roi.
        }
    }

    private void closeExpiredLingering(long now) {
        if (lingering.isEmpty()) {
            return;
        }
        for (Map.Entry<SelectionKey, Long> entry : lingering.entrySet()) {
            if (now >= entry.getValue()) {
                hardClose(entry.getKey());
            }
        }
    }

    private void wake(Connection connection) {
        needsFlush.add(connection);
        selector.wakeup();
    }

    @Override
    public String stats() {
        return core.stats() + " [nio, 1 selector]";
    }

    @Override
    public void close() {
        running = false;
        core.close();
        try {
            if (acceptor != null) {
                acceptor.close();
            }
            if (selector != null) {
                selector.close();
            }
        } catch (IOException ignored) {
            // Dang tat may.
        }
    }

    // ------------------------------------------------------------- transport

    /** Ghi khong chan: ghi duoc bao nhieu hay bay nhieu, phan con lai cho OP_WRITE. */
    private final class NioTransport implements Transport {

        private final SocketChannel channel;
        private final SelectionKey key;
        private final String remote;

        NioTransport(SocketChannel channel, SelectionKey key) throws IOException {
            this.channel = channel;
            this.key = key;
            this.remote = String.valueOf(channel.getRemoteAddress());
        }

        @Override
        public int write(ByteBuffer buffer) throws IOException {
            return channel.write(buffer);
        }

        @Override
        public void wantWrite(Connection connection) {
            wake(connection);
        }

        @Override
        public void writeInterest(boolean enabled) {
            if (!key.isValid()) {
                return;
            }
            int ops = key.interestOps();
            key.interestOps(enabled ? ops | SelectionKey.OP_WRITE : ops & ~SelectionKey.OP_WRITE);
        }

        /**
         * Dong "tu te" thay vi dong phang.
         *
         * Van de that da gap khi chay bot gian lan cua E6: server tu choi mot
         * client dang spam, xep frame `ERROR 4005` vao hang doi, ghi ra socket
         * roi dong ngay. Client KHONG he nhan duoc ma loi nao — no chi thay ket
         * noi dut. Ly do nam o TCP: neu con byte cua client dang bay toi ma
         * socket bi dong, he dieu hanh tra loi bang RST, va RST khien phia kia
         * VUT BO toan bo du lieu con trong buffer nhan — ke ca frame loi ta vua
         * ghi. Nghich ly la client cang spam manh thi cang chac chan khong nhan
         * duoc ly do minh bi dong.
         *
         * Cach dong dung: gui FIN truoc (`shutdownOutput`) de ben kia doc het
         * phan da ghi, roi de ket noi NAN LAI mot lat — van doc va vut bo byte
         * den sau — truoc khi dong han. Viec nan lai do vong lap selector lam,
         * xem {@link NioServer#linger} va {@link NioServer#hardClose}.
         */
        @Override
        public void close() throws IOException {
            try {
                if (channel.isConnected()) {
                    channel.shutdownOutput();
                    linger(key);
                    return;
                }
            } catch (IOException alreadyGone) {
                // Client da bien mat: khong con gi phai dong tu te nua.
            }
            channel.close();
        }

        @Override
        public String remote() {
            return remote;
        }
    }

}
