package vn.dcgs.server.net;

import vn.dcgs.server.Config;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Lop mang che do `server.io=blocking` - BASELINE DOI CHUNG cua thi nghiem E2.
 *
 * Mo hinh kinh dien "thread-per-connection": moi ket noi duoc cap
 *   - 1 thread doc, chan tren `InputStream.read()`
 *   - 1 thread ghi, chan tren hang doi gui cua chinh ket noi do
 * cong them 1 thread accept va 1 thread quet dinh ky cho ca server.
 *
 * Ban nay KHONG phai la mot ban cau tha dung de NIO thang de. No dung y nguyen
 * {@link ServerCore}: cung rate limit, cung backpressure, cung logic van dau.
 * Cai duy nhat khac la cach byte di vao va di ra. Vi vay con so ma E2 do duoc -
 * so thread, RAM, p95 theo so ban - la chenh lech cua mo hinh I/O, khong phai
 * chenh lech cua hai ban code.
 *
 * Cho biet truoc: o 400 ban (800 ket noi) mo hinh nay can khoang 1600 thread.
 * Do chinh la con so can dua vao bao cao.
 */
public final class BlockingServer implements CgpServer {

    private final ServerCore core;
    private final int port;
    private final String bind;
    private final int maxConnections;
    private final int sendQueueMax;

    private final AtomicInteger liveThreads = new AtomicInteger();
    private ServerSocket acceptor;
    private volatile boolean running;

    /** Doc cau hinh cong, dia chi bind, so ket noi toi da va kich thuoc hang doi gui. */
    public BlockingServer(Config config, ServerCore core) {
        this.core = core;
        this.port = config.getInt("server.port", 5555);
        this.bind = config.get("server.bind", "0.0.0.0");
        this.maxConnections = config.getInt("server.maxConnections", 1000);
        this.sendQueueMax = config.getInt("conn.sendQueueMax", 256);
    }

    /** Mo ServerSocket va bind vao dia chi/cong da cau hinh. */
    @Override
    public void start() throws IOException {
        acceptor = new ServerSocket();
        acceptor.setReuseAddress(true);
        acceptor.bind(new InetSocketAddress(bind, port), 512);
        running = true;
        System.out.printf("Lang nghe CGP tren %s:%d (blocking, format=%s, toi da %d ket noi)%n",
                bind, port, core.format().name(), maxConnections);
        System.out.println("  che do baseline cua E2: moi ket noi ton 2 thread");
    }

    /** Chay thread quet dinh ky (heartbeat, timeout) roi vong lap accept ket noi moi cho toi khi server dong. */
    @Override
    public void run() {
        // Viec dinh ky (heartbeat, timeout) o che do nio nam trong vong lap
        // selector; o day phai co thread rieng vi thread accept dang bi chan.
        Thread scanner = new Thread(() -> {
            while (running) {
                try {
                    Thread.sleep(1_000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
                core.periodic(System.currentTimeMillis());
            }
        }, "blocking-scanner");
        scanner.setDaemon(true);
        scanner.start();

        while (running) {
            Socket socket;
            try {
                socket = acceptor.accept();
            } catch (IOException failure) {
                if (running) {
                    System.err.println("Loi khi accept: " + failure.getMessage());
                }
                continue;
            }
            try {
                onAccepted(socket);
            } catch (IOException failure) {
                closeQuietly(socket);
            }
        }
    }

    /** Xu ly ket noi vua accept: qua tai thi gui ERROR 4003 roi dong; nguoc lai tao Connection va 2 thread doc/ghi rieng. */
    private void onAccepted(Socket socket) throws IOException {
        if (core.openConnections() >= maxConnections) {
            core.countRejected();
            try {
                ByteBuffer frame = core.overloadedFrame();
                byte[] bytes = new byte[frame.remaining()];
                frame.get(bytes);
                socket.getOutputStream().write(bytes);
            } catch (IOException ignored) {
                // Client co the da bo di.
            } finally {
                closeQuietly(socket);
            }
            return;
        }

        socket.setTcpNoDelay(true);
        socket.setKeepAlive(true);

        SocketTransport transport = new SocketTransport(socket);
        Connection connection = new Connection(core.nextConnectionId(), transport, sendQueueMax);
        core.register(connection);

        Thread writer = new Thread(() -> writeLoop(connection), "conn-write-" + connection.id());
        writer.setDaemon(true);
        transport.writer = writer;
        writer.start();

        Thread reader = new Thread(() -> readLoop(connection, transport), "conn-read-" + connection.id());
        reader.setDaemon(true);
        reader.start();
    }

    /** Mot thread cho moi ket noi, chan tai day cho toi khi co byte. */
    private void readLoop(Connection connection, SocketTransport transport) {
        liveThreads.incrementAndGet();
        byte[] buffer = new byte[16 * 1024];
        try {
            InputStream in = transport.socket.getInputStream();
            for (;;) {
                int count = in.read(buffer);
                if (count < 0) {
                    break;
                }
                if (!core.onBytes(connection, buffer, count)) {
                    return;                       // core da dong ket noi nay
                }
            }
        } catch (IOException closed) {
            // Client bien mat: duong ra binh thuong cua vong lap nay.
        } finally {
            liveThreads.decrementAndGet();
            core.close(connection, null);
            connection.signalWriter();            // de thread ghi thoat theo
        }
    }

    /** Thread ghi rieng: thread game chi xep hang roi di, khong bao gio bi chan. */
    private void writeLoop(Connection connection) {
        liveThreads.incrementAndGet();
        try {
            while (connection.state() != Connection.State.CLOSING) {
                try {
                    connection.awaitPendingWrites(1_000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
                if (connection.hasPendingWrites()) {
                    connection.flush();
                }
            }
            if (connection.hasPendingWrites()) {
                connection.flush();               // co gang gui not ERROR cuoi cung
            }
        } finally {
            liveThreads.decrementAndGet();
        }
    }

    /** Dong socket, bo qua moi loi. */
    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // Dang bo socket nay di.
        }
    }

    /** Thong ke cua core kem so thread I/O dang chay. */
    @Override
    public String stats() {
        return core.stats() + String.format(" [blocking, %d thread I/O dang song]", liveThreads.get());
    }

    /** Dung vong lap accept, dong moi ket noi va dong ServerSocket. */
    @Override
    public void close() {
        running = false;
        core.close();
        try {
            if (acceptor != null) {
                acceptor.close();
            }
        } catch (IOException ignored) {
            // Dang tat may.
        }
    }

    // ------------------------------------------------------------- transport

    /** Ghi chan: `write` chi tra ve khi da ghi het, nen khong can OP_WRITE. */
    private static final class SocketTransport implements Transport {

        private final Socket socket;
        private final OutputStream out;
        private final String remote;
        private volatile Thread writer;

        /** Boc socket va lay luong ghi, ghi lai dia chi ben kia. */
        SocketTransport(Socket socket) throws IOException {
            this.socket = socket;
            this.out = socket.getOutputStream();
            this.remote = String.valueOf(socket.getRemoteSocketAddress());
        }

        /** Ghi het noi dung buffer xuong socket (chan cho toi khi xong). */
        @Override
        public int write(ByteBuffer buffer) throws IOException {
            int count = buffer.remaining();
            byte[] bytes = new byte[count];
            buffer.get(bytes);
            out.write(bytes);
            out.flush();
            return count;
        }

        /** Danh thuc thread ghi cua ket noi vi co du lieu moi trong hang doi. */
        @Override
        public void wantWrite(Connection connection) {
            connection.signalWriter();
        }

        /** Khong dung o che do blocking. */
        @Override
        public void writeInterest(boolean enabled) {
            // Khong co khai niem nay o che do chan: thread ghi tu cho hang doi.
        }

        /** Dong tu te — xem ghi chu o {@code NioServer.NioTransport#close}. */
        @Override
        public void close() throws IOException {
            try {
                if (socket.isConnected() && !socket.isClosed()) {
                    socket.shutdownOutput();
                    socket.setSoTimeout(50);
                    byte[] sink = new byte[4096];
                    int drained = 0;
                    while (drained < 64 * 1024) {
                        int count = socket.getInputStream().read(sink);
                        if (count <= 0) {
                            break;
                        }
                        drained += count;
                    }
                }
            } catch (IOException alreadyGone) {
                // Client da bien mat hoac het gio doc: dong luon.
            }
            try {
                socket.close();
            } catch (SocketException ignored) {
                // Da dong roi.
            }
            Thread current = writer;
            if (current != null) {
                current.interrupt();
            }
        }

        /** Tra ve dia chi ben kia cua socket. */
        @Override
        public String remote() {
            return remote;
        }
    }
}
