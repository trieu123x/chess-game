package vn.dcgs.server.net;

import com.fasterxml.jackson.databind.JsonNode;
import vn.dcgs.common.CgpException;
import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.Frame;
import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.Json;
import vn.dcgs.common.MoveCodec;
import vn.dcgs.common.MsgType;
import vn.dcgs.server.Config;
import vn.dcgs.server.data.Database;
import vn.dcgs.server.data.PasswordHash;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Lop mang cua Game Server: non-blocking I/O bang Selector.
 *
 * Mot Selector duy nhat lo accept, doc va ghi. O quy mo cua do an (vai tram
 * ket noi, message vai chuc byte) mot vong lap la du va de giai thich; viec
 * tach nhieu IoWorker se lam khi do E2 neu so lieu cho thay can.
 *
 * Nguyen tac: loi cua mot ket noi khong duoc cham toi ket noi khac. Moi
 * exception deu bi bat tai bien nay, doi thanh ERROR co ma, va chi ket noi
 * gay loi bi dong.
 *
 * Tuan 1 phuc vu: LOGIN, RESUME, LOGOUT, HEARTBEAT, CLOCK_PING.
 * Cac message ve van dau (QUEUE_JOIN, MOVE...) se duoc dinh tuyen toi
 * GameActor o tuan 2.
 */
public final class NioServer implements Runnable, AutoCloseable {

    private final Config config;
    private final Database database;

    private final int port;
    private final String bind;
    private final int maxConnections;
    private final int maxMsgPerSec;
    private final int sendQueueMax;
    private final long preLoginTimeoutMs;
    private final long heartbeatTimeoutMs;
    private final long sessionTtlMs;
    private final boolean traceFrames;

    private final Map<Long, Connection> connections = new ConcurrentHashMap<>();
    /** userId -> ket noi dang hoat dong, de phat hien dang nhap hai noi (X16). */
    private final Map<Long, Connection> byUser = new HashMap<>();
    private final AtomicLong nextConnectionId = new AtomicLong(1);

    private Selector selector;
    private ServerSocketChannel acceptor;
    private volatile boolean running;

    private long accepted;
    private long rejected;

    public NioServer(Config config, Database database) {
        this.config = config;
        this.database = database;
        this.port = config.getInt("server.port", 5555);
        this.bind = config.get("server.bind", "0.0.0.0");
        this.maxConnections = config.getInt("server.maxConnections", 1000);
        this.maxMsgPerSec = config.getInt("conn.maxMsgPerSec", 50);
        this.sendQueueMax = config.getInt("conn.sendQueueMax", 256);
        this.preLoginTimeoutMs = config.getInt("conn.preLoginTimeoutMs", 10_000);
        this.heartbeatTimeoutMs = config.getInt("heartbeat.timeoutMs", 15_000);
        this.sessionTtlMs = config.getInt("session.ttlMs", 3_600_000);
        this.traceFrames = config.getBoolean("log.frames", false);
    }

    public void start() throws IOException {
        selector = Selector.open();
        acceptor = ServerSocketChannel.open();
        acceptor.configureBlocking(false);
        acceptor.socket().setReuseAddress(true);
        acceptor.bind(new InetSocketAddress(bind, port), 512);   // backlog cho bao reconnect (X08)
        acceptor.register(selector, SelectionKey.OP_ACCEPT);
        running = true;
        System.out.printf("Lang nghe CGP tren %s:%d (nio, toi da %d ket noi)%n", bind, port, maxConnections);
    }

    @Override
    public void run() {
        long lastScan = System.currentTimeMillis();
        while (running) {
            try {
                selector.select(500);
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

                long now = System.currentTimeMillis();
                if (now - lastScan >= 1_000) {
                    lastScan = now;
                    scanTimeouts(now);
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
        if (connections.size() >= maxConnections) {
            // Bao ve cac van dang chay thay vi nhan them roi cung cham (X08).
            rejected++;
            try {
                channel.configureBlocking(true);
                channel.write(FrameCodec.encode(MsgType.ERROR, 0, Json.of(Map.of(
                        "code", ErrorCode.SERVER_OVERLOADED,
                        "message", ErrorCode.message(ErrorCode.SERVER_OVERLOADED)))));
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

        long id = nextConnectionId.getAndIncrement();
        Connection connection = new Connection(id, channel, key, sendQueueMax);
        key.attach(connection);
        connections.put(id, connection);
        accepted++;
        if (traceFrames) {
            System.out.printf("+ %s tu %s (%d dang mo)%n", connection, connection.remote(), connections.size());
        }
    }

    // ------------------------------------------------------------------ doc

    private final ByteBuffer readBuffer = ByteBuffer.allocate(16 * 1024);

    private void read(SelectionKey key) {
        Connection connection = (Connection) key.attachment();
        readBuffer.clear();

        int count;
        try {
            count = connection.channel().read(readBuffer);
        } catch (IOException failure) {
            close(connection, null);
            return;
        }
        if (count < 0) {
            close(connection, null);
            return;
        }
        connection.touch();

        List<Frame> frames;
        try {
            frames = connection.decoder().feed(readBuffer.array(), 0, count);
        } catch (CgpException failure) {
            // Frame hong: tra ma loi roi dong. Khong doan them gi tu dong byte nay.
            close(connection, failure);
            return;
        }

        for (Frame frame : frames) {
            if (!connection.allowMessage(maxMsgPerSec)) {
                sendError(connection, ErrorCode.RATE_LIMITED, "gui qua " + maxMsgPerSec + " message/giay");
                if (connection.overRateLimitRepeatedly()) {
                    close(connection, null);
                    return;
                }
                continue;
            }
            try {
                dispatch(connection, frame);
            } catch (CgpException failure) {
                sendError(connection, failure.code(), failure.reason());
                if (failure.closesConnection()) {
                    close(connection, null);
                    return;
                }
            } catch (RuntimeException unexpected) {
                // Bug cua server khong duoc giet ca server.
                System.err.printf("Loi khong luong truoc khi xu ly %s tu %s: %s%n",
                        MsgType.name(frame.type()), connection, unexpected);
                sendError(connection, ErrorCode.INTERNAL_ERROR, "loi noi bo");
            }
            if (connection.state() == Connection.State.CLOSING) {
                close(connection, null);
                return;
            }
        }
    }

    // ------------------------------------------------------------- dinh tuyen

    private void dispatch(Connection connection, Frame frame) {
        if (traceFrames) {
            System.out.printf("  %s <- %s%n", connection, frame);
        }
        if (MsgType.requiresSession(frame.type()) && !connection.authenticated()) {
            throw new CgpException(ErrorCode.NOT_AUTHENTICATED, MsgType.name(frame.type()));
        }

        switch (frame.type()) {
            case MsgType.LOGIN -> handleLogin(connection, frame);
            case MsgType.RESUME -> handleResume(connection, frame);
            case MsgType.LOGOUT -> handleLogout(connection, frame);
            case MsgType.HEARTBEAT -> {
                connection.send(FrameCodec.encode(MsgType.HEARTBEAT_ACK, frame.seq()));
            }
            case MsgType.CLOCK_PING -> handleClockPing(connection, frame);
            case MsgType.QUEUE_JOIN, MsgType.QUEUE_LEAVE, MsgType.MOVE, MsgType.RESIGN,
                 MsgType.DRAW_OFFER, MsgType.DRAW_REPLY, MsgType.SPECTATE_JOIN,
                 MsgType.SPECTATE_LEAVE, MsgType.HISTORY_REQ ->
                    sendError(connection, ErrorCode.INTERNAL_ERROR,
                            MsgType.name(frame.type()) + " chua duoc trien khai (PLAN.md tuan 2)");
            default -> throw new CgpException(ErrorCode.UNKNOWN_TYPE,
                    String.format("0x%02X", frame.type()));
        }
    }

    private void handleLogin(Connection connection, Frame frame) {
        JsonNode payload = Json.parse(frame.payload());
        String username = Json.required(payload, "username");
        String password = Json.required(payload, "password");

        if (!username.matches("[A-Za-z0-9_]{3,32}") || password.isEmpty() || password.length() > 100) {
            throw new CgpException(ErrorCode.INVALID_CREDENTIALS_FORMAT, "username/password khong hop le");
        }

        Optional<Database.UserRow> found = database.findUser(username);
        if (found.isEmpty() || !PasswordHash.matches(username, password, found.get().passwordHash())) {
            // Cung mot thong bao cho ca hai truong hop: khong tiet lo tai khoan nao ton tai.
            database.logRejected(null, found.map(Database.UserRow::id).orElse(null),
                    ErrorCode.BAD_CREDENTIALS, "login that bai: " + username);
            throw new CgpException(ErrorCode.BAD_CREDENTIALS, ErrorCode.message(ErrorCode.BAD_CREDENTIALS));
        }

        Database.UserRow user = found.get();
        kickPreviousSession(user.id());

        UUID token = database.createSession(user.id(), sessionTtlMs);
        connection.authenticate(user.id(), user.username(), token);
        byUser.put(user.id(), connection);

        connection.send(FrameCodec.encode(MsgType.LOGIN_OK, frame.seq(), Json.of(Map.of(
                "sessionToken", token.toString(),
                "userId", user.id(),
                "username", user.username(),
                "elo", user.elo()))));
        System.out.printf("LOGIN %s (id=%d, elo=%d) tu %s%n",
                user.username(), user.id(), user.elo(), connection.remote());
    }

    /** Dang nhap noi khac: dong phien cu co kiem soat thay vi de hai phien song song (X16). */
    private void kickPreviousSession(long userId) {
        Connection previous = byUser.get(userId);
        if (previous == null) {
            return;
        }
        sendError(previous, ErrorCode.LOGGED_IN_ELSEWHERE, "tai khoan dang nhap o noi khac");
        previous.markClosing();
        close(previous, null);
    }

    private void handleResume(Connection connection, Frame frame) {
        JsonNode payload = Json.parse(frame.payload());
        UUID token;
        try {
            token = UUID.fromString(Json.required(payload, "sessionToken"));
        } catch (IllegalArgumentException malformed) {
            throw new CgpException(ErrorCode.SESSION_EXPIRED, "token sai dinh dang");
        }

        Database.SessionRow session = database.findSession(token)
                .orElseThrow(() -> new CgpException(ErrorCode.SESSION_EXPIRED, "khong tim thay phien"));
        if (session.expired()) {
            database.deleteSession(token);
            throw new CgpException(ErrorCode.SESSION_EXPIRED, "phien da het han");
        }

        Database.UserRow user = database.findUserById(session.userId())
                .orElseThrow(() -> new CgpException(ErrorCode.SESSION_EXPIRED, "tai khoan cua phien khong con"));

        kickPreviousSession(user.id());
        database.extendSession(token, sessionTtlMs);
        connection.authenticate(user.id(), user.username(), token);
        byUser.put(user.id(), connection);

        connection.send(FrameCodec.encode(MsgType.LOGIN_OK, frame.seq(), Json.of(Map.of(
                "sessionToken", token.toString(),
                "userId", user.id(),
                "username", user.username(),
                "elo", user.elo()))));
        System.out.printf("RESUME %s tu %s%n", user.username(), connection.remote());
        // Van dang danh se duoc gui kem GAME_SNAPSHOT o tuan 2.
    }

    private void handleLogout(Connection connection, Frame frame) {
        if (connection.sessionToken() != null) {
            database.deleteSession(connection.sessionToken());
        }
        connection.send(FrameCodec.encode(MsgType.HEARTBEAT_ACK, frame.seq()));
        connection.markClosing();
    }

    /**
     * Doi hinh NTP: t1 client gui, t2 server nhan, t3 server tra loi.
     * Client dung ba moc nay de tinh offset; con RTT dung de tru gio thi
     * server tu do lay, khong nhan tu client (X33).
     */
    private void handleClockPing(Connection connection, Frame frame) {
        long t2 = System.currentTimeMillis();
        long t1 = ByteBuffer.wrap(frame.payload()).getLong();
        long t3 = System.currentTimeMillis();
        connection.send(FrameCodec.encode(MsgType.CLOCK_PONG, frame.seq(),
                MoveCodec.encodeClockPong(t1, t2, t3)));
    }

    // --------------------------------------------------------------- quet gio

    private void scanTimeouts(long now) {
        List<Connection> doomed = new ArrayList<>();
        for (Connection connection : connections.values()) {
            if (!connection.authenticated() && now - connection.connectedAt() > preLoginTimeoutMs) {
                // Ket noi im lang truoc khi dang nhap (X02).
                doomed.add(connection);
            } else if (connection.authenticated() && now - connection.lastSeenAt() > heartbeatTimeoutMs) {
                // Mat heartbeat: co the la half-open, TCP khong bao gi ca (X01).
                doomed.add(connection);
            }
        }
        for (Connection connection : doomed) {
            if (traceFrames || connection.authenticated()) {
                System.out.printf("- dong %s: qua han im lang%n", connection);
            }
            close(connection, null);
        }
    }

    // ---------------------------------------------------------------- dong

    private void sendError(Connection connection, int code, String message) {
        try {
            connection.send(FrameCodec.encode(MsgType.ERROR, 0,
                    Json.of(Map.of("code", code, "message", message))));
        } catch (CgpException overflow) {
            connection.markClosing();
        }
    }

    private void close(Connection connection, CgpException reason) {
        if (reason != null) {
            try {
                connection.send(FrameCodec.encode(MsgType.ERROR, 0,
                        Json.of(Map.of("code", reason.code(), "message", reason.reason()))));
            } catch (CgpException ignored) {
                // Khong gui duoc thi thoi, van phai dong.
            }
        }
        connections.remove(connection.id());
        if (connection.userId() != 0) {
            byUser.remove(connection.userId(), connection);
        }
        try {
            connection.channel().close();
        } catch (IOException ignored) {
            // Da dong roi.
        }
    }

    public String stats() {
        return String.format("da nhan %d ket noi, tu choi %d, dang mo %d",
                accepted, rejected, connections.size());
    }

    @Override
    public void close() {
        running = false;
        for (Connection connection : new ArrayList<>(connections.values())) {
            close(connection, null);
        }
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
}
