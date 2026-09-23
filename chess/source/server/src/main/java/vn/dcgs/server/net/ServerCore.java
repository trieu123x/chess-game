package vn.dcgs.server.net;

import com.fasterxml.jackson.databind.JsonNode;
import vn.dcgs.common.CgpException;
import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.Frame;
import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.Json;
import vn.dcgs.common.MoveCodec;
import vn.dcgs.common.MsgType;
import vn.dcgs.common.WireFormat;
import vn.dcgs.server.Config;
import vn.dcgs.server.data.Database;
import vn.dcgs.server.game.GameService;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Phan lop mang KHONG phu thuoc vao kieu I/O: bang ket noi, xac thuc, phien,
 * heartbeat, rate limit, dinh tuyen message.
 *
 * {@link NioServer} va {@link BlockingServer} chi khac nhau o cach lay byte ra
 * khoi socket va cach day byte vao socket; tu {@link #onBytes} tro len, hai che
 * do chay y het nhau. Do la dieu kien de thi nghiem E2 so sanh duoc mo hinh I/O
 * chu khong phai so sanh hai ban server khac nhau.
 */
public final class ServerCore implements AutoCloseable {

    private final Database database;
    private final GameService games;
    private final WireFormat format;

    private final int maxMsgPerSec;
    private final long preLoginTimeoutMs;
    private final long heartbeatIntervalMs;
    private final long heartbeatTimeoutMs;
    private final long sessionTtlMs;
    private final boolean traceFrames;

    private final Map<Long, Connection> connections = new ConcurrentHashMap<>();
    /** userId -> ket noi dang hoat dong, de phat hien dang nhap hai noi (X16). */
    private final Map<Long, Connection> byUser = new ConcurrentHashMap<>();
    private final AtomicLong nextConnectionId = new AtomicLong(1);

    private final AtomicLong accepted = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();
    private long lastHeartbeatAt;

    public ServerCore(Config config, Database database, GameService games) {
        this.database = database;
        this.games = games;
        this.format = WireFormat.of(config.get("server.format", "binary"));
        this.maxMsgPerSec = config.getInt("conn.maxMsgPerSec", 50);
        this.preLoginTimeoutMs = config.getInt("conn.preLoginTimeoutMs", 10_000);
        this.heartbeatIntervalMs = config.getInt("heartbeat.intervalMs", 5_000);
        this.heartbeatTimeoutMs = config.getInt("heartbeat.timeoutMs", 15_000);
        this.sessionTtlMs = config.getInt("session.ttlMs", 3_600_000);
        this.traceFrames = config.getBoolean("log.frames", false);
    }

    public WireFormat format() {
        return format;
    }

    public long nextConnectionId() {
        return nextConnectionId.getAndIncrement();
    }

    public int openConnections() {
        return connections.size();
    }

    public void countRejected() {
        rejected.incrementAndGet();
    }

    public void register(Connection connection) {
        connections.put(connection.id(), connection);
        accepted.incrementAndGet();
        if (traceFrames) {
            System.out.printf("+ %s tu %s (%d dang mo)%n",
                    connection, connection.remote(), connections.size());
        }
    }

    /** Frame tu choi ket noi khi da cham tran (X08) - gui trong mot goi duy nhat. */
    public ByteBuffer overloadedFrame() {
        return FrameCodec.encode(MsgType.ERROR, 0, Json.of(Map.of(
                "code", ErrorCode.SERVER_OVERLOADED,
                "message", ErrorCode.message(ErrorCode.SERVER_OVERLOADED))));
    }

    // ------------------------------------------------------------------ doc

    /**
     * Nap byte vua doc duoc tu mot ket noi.
     *
     * @return false neu ket noi da bi dong trong luc xu ly - ben goi dung doc tiep
     */
    public boolean onBytes(Connection connection, byte[] data, int length) {
        connection.touch();
        connection.countIn(length);

        List<Frame> frames;
        try {
            frames = connection.decoder().feed(data, 0, length);
        } catch (CgpException failure) {
            // Frame hong: tra ma loi roi dong. Khong doan them gi tu dong byte nay.
            close(connection, failure);
            return false;
        }

        long receivedAt = System.currentTimeMillis();
        for (Frame frame : frames) {
            if (!connection.allowMessage(maxMsgPerSec)) {
                sendError(connection, ErrorCode.RATE_LIMITED, "gui qua " + maxMsgPerSec + " message/giay");
                if (connection.overRateLimitRepeatedly()) {
                    close(connection, null);
                    return false;
                }
                continue;
            }
            try {
                dispatch(connection, frame, receivedAt);
            } catch (CgpException failure) {
                sendError(connection, failure.code(), failure.reason());
                if (failure.closesConnection()) {
                    close(connection, null);
                    return false;
                }
            } catch (RuntimeException unexpected) {
                // Bug cua server khong duoc giet ca server.
                System.err.printf("Loi khong luong truoc khi xu ly %s tu %s: %s%n",
                        MsgType.name(frame.type()), connection, unexpected);
                sendError(connection, ErrorCode.INTERNAL_ERROR, "loi noi bo");
            }
            if (connection.state() == Connection.State.CLOSING) {
                close(connection, null);
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------------- dinh tuyen

    private void dispatch(Connection connection, Frame frame, long receivedAt) {
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
            case MsgType.HEARTBEAT -> connection.send(FrameCodec.encode(MsgType.HEARTBEAT_ACK, frame.seq()));
            case MsgType.HEARTBEAT_ACK -> connection.recordHeartbeatAck();
            case MsgType.CLOCK_PING -> handleClockPing(connection, frame);
            case MsgType.LOBBY_REQ -> handleLobby(connection, frame);

            case MsgType.QUEUE_JOIN -> {
                JsonNode payload = Json.parse(frame.payload());
                int elo = database.findUserById(connection.userId())
                        .map(Database.UserRow::elo).orElse(1200);
                games.joinQueue(connection, Json.required(payload, "timeControl"), elo);
            }
            case MsgType.QUEUE_LEAVE -> games.leaveQueue(connection);
            case MsgType.MOVE -> games.onMove(connection, format.decodeMove(frame.payload()), receivedAt);
            case MsgType.RESIGN -> games.onResign(connection);
            case MsgType.DRAW_OFFER -> games.onDrawOffer(connection);
            case MsgType.DRAW_REPLY -> games.onDrawReply(connection,
                    frame.payload().length > 0 && frame.payload()[0] != 0);
            case MsgType.HISTORY_REQ -> games.sendSnapshot(connection);

            case MsgType.SPECTATE_JOIN -> games.spectateJoin(connection,
                    Json.parse(frame.payload()).path("gameId").asLong());
            case MsgType.SPECTATE_LEAVE -> games.spectateLeave(connection,
                    Json.parse(frame.payload()).path("gameId").asLong());

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
        if (found.isEmpty() || !vn.dcgs.server.data.PasswordHash.matches(
                username, password, found.get().passwordHash())) {
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

        probeRoundTrip(connection);

        // Dang nhap lai khi van cu con dang dang do: noi thang vao van (X12).
        games.reattach(connection, 0);

        if (traceFrames) {
            System.out.printf("LOGIN %s (id=%d, elo=%d)%n", user.username(), user.id(), user.elo());
        }
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

    /**
     * Noi lai mot phien cu.
     *
     * Hai viec: xac thuc lai bang token, roi GAN LAI ket noi moi vao van dang
     * danh do va phat lai cac nuoc di client con thieu (dong gop N5). Con so
     * `lastPly` cua client chi la GOI Y - server luon gui snapshot day du truoc,
     * nen client khai sai (X14) cung khong lam hong gi.
     */
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

        probeRoundTrip(connection);

        int lastPly = Math.max(0, Json.optionalInt(payload, "lastPly", 0));
        boolean resumed = games.reattach(connection, lastPly);
        if (!resumed) {
            // Khong con van nao: ket thuc sau khi mat ket noi, hoac chua tung co.
            // Tra ket qua van cuoi cung thay vi im lang (X13).
            games.sendLastFinishedGame(connection, user.id());
        }
        System.out.printf("RESUME %s tu %s (lastPly=%d, %s)%n",
                user.username(), connection.remote(), lastPly,
                resumed ? "noi lai vao van dang danh" : "khong con van nao");
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
     * Client dung ba moc nay de hien thi dong ho cho khop; con RTT dung de tru
     * gio thi server tu do bang chu trinh heartbeat cua chinh no (X33).
     */
    private void handleClockPing(Connection connection, Frame frame) {
        if (frame.payload().length != 8) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME, "CLOCK_PING phai 8 byte");
        }
        long t2 = System.currentTimeMillis();
        long t1 = ByteBuffer.wrap(frame.payload()).getLong();
        long t3 = System.currentTimeMillis();
        connection.send(FrameCodec.encode(MsgType.CLOCK_PONG, frame.seq(),
                MoveCodec.encodeClockPong(t1, t2, t3)));
    }

    /**
     * Danh sach van dang dien ra + bang xep hang, trong mot vong goi.
     *
     * Khan gia can danh sach van de chon xem; bang xep hang la ket qua nhin thay
     * duoc cua Elo. Gop vao mot message de khong phai them hai loai message chi
     * dung mot lan moi khi mo trang.
     */
    private void handleLobby(Connection connection, Frame frame) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("games", games.liveGames());
        body.put("leaderboard", database.leaderboard(10));
        connection.send(FrameCodec.encode(MsgType.LOBBY_RESULT, frame.seq(), Json.of(body)));
    }

    // --------------------------------------------------------------- dinh ky

    /**
     * Viec dinh ky cua lop mang: gui heartbeat de TU DO RTT (X33) va dong nhung
     * ket noi da im lang qua lau (X01, X02). Goi moi giay tu vong lap cua server.
     */
    public void periodic(long now) {
        if (now - lastHeartbeatAt >= heartbeatIntervalMs) {
            lastHeartbeatAt = now;
            sendHeartbeats();
        }
        scanTimeouts(now);
    }

    /**
     * Do RTT ngay khi vua dang nhap, khong cho toi nhip heartbeat dau tien.
     *
     * Bu gio chi lam duoc khi da co mau RTT. Nhip heartbeat la 5 s, nen neu chi
     * dua vao no thi nhung nuoc di dau van cua mot nguoi choi o xa bi tru oan
     * nguyen ca vong khu hoi — do dung la luc van moi bat dau va chua ai kip
     * nghi gi. Do duoc o E4: khong co mau dau nay, drift p50 o delay 150 ms la
     * 163 ms/nuoc thay vi ~118 ms/nuoc nhu tran bu cho phep.
     */
    private void probeRoundTrip(Connection connection) {
        try {
            connection.markHeartbeatSent();
            connection.send(FrameCodec.encode(MsgType.HEARTBEAT, 0));
        } catch (CgpException overflow) {
            connection.markClosing();
        }
    }

    private void sendHeartbeats() {
        for (Connection connection : connections.values()) {
            if (!connection.authenticated()) {
                continue;
            }
            try {
                connection.markHeartbeatSent();
                connection.send(FrameCodec.encode(MsgType.HEARTBEAT, 0));
            } catch (CgpException overflow) {
                close(connection, null);
            }
        }
    }

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

    public void sendError(Connection connection, int code, String message) {
        try {
            connection.send(FrameCodec.encode(MsgType.ERROR, 0,
                    Json.of(Map.of("code", code, "message", message))));
        } catch (CgpException overflow) {
            connection.markClosing();
        }
    }

    public void close(Connection connection, CgpException reason) {
        if (reason != null) {
            try {
                connection.send(FrameCodec.encode(MsgType.ERROR, 0,
                        Json.of(Map.of("code", reason.code(), "message", reason.reason()))));
            } catch (RuntimeException ignored) {
                // Khong xep hang duoc thi thoi, van phai dong.
            }
        }
        if (connections.remove(connection.id()) == null) {
            return;                      // da dong roi
        }
        // Day not nhung gi da xep hang TRUOC khi dong socket.
        //
        // Neu bo buoc nay thi client bi dong vi vi pham rate limit (4005) hoac
        // vi gui frame hong (2001) se chi thay ket noi im lang dut — dung cai ma
        // bang A6 noi la khong duoc lam. Loi nay tung xay ra that va chi lo ra
        // khi chay bot gian lan cua E6: server "tu choi" nhung client khong he
        // nhan duoc ma loi nao.
        try {
            connection.flush();
        } catch (RuntimeException ignored) {
            // Client da bo di: khong con gi de gui.
        }
        connection.markClosing();
        if (connection.userId() != 0) {
            byUser.remove(connection.userId(), connection);
        }
        games.onDisconnect(connection);
        try {
            connection.transport().close();
        } catch (IOException ignored) {
            // Da dong roi.
        }
    }

    public String stats() {
        return String.format("da nhan %d ket noi, tu choi %d, dang mo %d",
                accepted.get(), rejected.get(), connections.size());
    }

    @Override
    public void close() {
        for (Connection connection : new ArrayList<>(connections.values())) {
            close(connection, null);
        }
    }
}
