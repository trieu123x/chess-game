package vn.dcgs.server.game;

import vn.dcgs.common.CgpException;
import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.Json;
import vn.dcgs.common.MoveCodec;
import vn.dcgs.common.MsgType;
import vn.dcgs.common.WireFormat;
import vn.dcgs.server.Config;
import vn.dcgs.server.data.Database;
import vn.dcgs.server.data.DbWriter;
import vn.dcgs.server.net.Connection;
import vn.dcgs.server.net.RulesEngine;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Ghep cap va dieu phoi cac ban co.
 *
 * Day la lop duy nhat ma lop mang goi toi: ServerCore khong biet gi ve luat co,
 * con GameActor khong biet gi ve socket. Ranh gioi do la thu giu cho hai phan
 * co the do rieng (E2 do lop mang, E7 do rules service).
 */
public final class GameService implements AutoCloseable {

    /** Cac tham so mot ban co can, gom lai de constructor cua GameActor khong dai 12 doi so. */
    public record Settings(boolean compensateLatency, long compensationCapMs,
                           int actorQueueMax, int drawCooldownPlies, WireFormat format) {
    }

    private final Database database;
    private final DbWriter dbWriter;
    private final RulesEngine rules;
    private final ExecutorService gamePool;
    private final ScheduledExecutorService scheduler;
    private final Settings settings;

    private final Map<Long, GameActor> games = new ConcurrentHashMap<>();
    /** userId -> ban dang danh. Nguon de noi lai dung van sau khi rot mang (N5). */
    private final Map<Long, GameActor> byPlayer = new ConcurrentHashMap<>();
    /** Hang doi ghep cap, tach theo the thuc: 3+2 khong ghep voi 10+0. */
    private final Map<String, Deque<Waiting>> queues = new ConcurrentHashMap<>();

    private final long graceMs;
    private final long queueNoticeMs;

    private final AtomicLong gamesStarted = new AtomicLong();
    private final AtomicLong gamesFinished = new AtomicLong();

    private static final class Waiting {
        private final Connection connection;
        private final long userId;
        private final String username;
        private final int elo;
        private final long since;
        private boolean noticed;

        /** Tao ban ghi nguoi dang cho ghep cap. */
        Waiting(Connection connection, long userId, String username, int elo, long since) {
            this.connection = connection;
            this.userId = userId;
            this.username = username;
            this.elo = elo;
            this.since = since;
        }
    }

    /** Doc cau hinh, tao thread pool cho cac ban co va scheduler quet dong ho moi 100 ms. */
    public GameService(Config config, Database database, DbWriter dbWriter, RulesEngine rules) {
        this.database = database;
        this.dbWriter = dbWriter;
        this.rules = rules;
        this.graceMs = config.getInt("reconnect.graceMs", 60_000);
        this.queueNoticeMs = config.getInt("queue.noticeMs", 60_000);
        this.settings = new Settings(
                config.getBoolean("clock.compensation", true),
                config.getInt("clock.compensationCapMs", 200),
                config.getInt("game.actorQueueMax", 1000),
                config.getInt("draw.offerCooldownPlies", 10),
                WireFormat.of(config.get("server.format", "binary")));

        int poolSize = config.getInt("server.gamePoolSize", 8);
        this.gamePool = Executors.newFixedThreadPool(poolSize, runnable -> {
            Thread thread = new Thread(runnable, "game-worker");
            thread.setDaemon(true);
            return thread;
        });
        this.scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "clock-scheduler");
            thread.setDaemon(true);
            return thread;
        });

        // Dong ho va an han deu do server quet dinh ky: het gio khong phu thuoc
        // vao viec client co gui gi hay khong.
        scheduler.scheduleAtFixedRate(this::tick, 100, 100, TimeUnit.MILLISECONDS);
    }

    // ------------------------------------------------------------- ghep cap

    /** Dua nguoi choi vao hang doi ghep cap theo the thuc; neu da co nguoi cho thi ghep ngay va bat dau van. */
    public void joinQueue(Connection connection, String timeControl, int elo) {
        if (connection.gameId() != 0) {
            throw new CgpException(ErrorCode.ALREADY_QUEUED, "ban dang trong mot van");
        }
        String normalized = normalize(timeControl);
        Deque<Waiting> queue = queues.computeIfAbsent(normalized, key -> new ArrayDeque<>());

        Waiting opponent;
        synchronized (queue) {
            // Cung mot tai khoan gui QUEUE_JOIN lan nua: idempotent, khong nhan
            // doi cho trong hang doi (X22).
            for (Waiting waiting : queue) {
                if (waiting.userId == connection.userId()) {
                    return;
                }
            }
            // Don nhung nguoi da mat ket noi trong luc cho (X19): neu khong se
            // ghep ra "van ma" khong ai danh.
            queue.removeIf(waiting -> waiting.connection.state() == Connection.State.CLOSING);
            opponent = queue.pollFirst();
            if (opponent == null) {
                queue.addLast(new Waiting(connection, connection.userId(), connection.username(),
                        elo, System.currentTimeMillis()));
                return;
            }
        }
        if (opponent.userId == connection.userId()) {
            // Mot nguoi mo hai client roi tu ghep voi chinh minh (X21).
            throw new CgpException(ErrorCode.ALREADY_QUEUED, "khong the tu ghep voi chinh minh");
        }
        if (opponent.connection.state() == Connection.State.CLOSING) {
            // Doi thu rot dung luc ghep (X20): tra nguoi con lai ve dau hang doi.
            joinQueue(connection, timeControl, elo);
            return;
        }
        startGame(opponent, new Waiting(connection, connection.userId(), connection.username(),
                elo, System.currentTimeMillis()), normalized);
    }

    /** Rut ket noi khoi moi hang doi ghep cap. */
    public void leaveQueue(Connection connection) {
        for (Deque<Waiting> queue : queues.values()) {
            synchronized (queue) {
                queue.removeIf(waiting -> waiting.connection == connection);
            }
        }
    }

    /** Tao van moi: ghi vao database, tao GameActor (nguoi cho lau hon cam Trang), gan van cho hai ket noi va bat dau van. */
    private void startGame(Waiting first, Waiting second, String timeControl) {
        // Nguoi cho lau hon cam Trang - de don gian va co the giai thich duoc.
        Waiting whiteSide = first;
        Waiting blackSide = second;

        long gameId = database.createGame(whiteSide.userId, blackSide.userId, timeControl);
        int[] control = parseTimeControl(timeControl);

        GameActor actor = new GameActor(gameId,
                new GameActor.Player(whiteSide.userId, whiteSide.username, whiteSide.elo,
                        whiteSide.connection),
                new GameActor.Player(blackSide.userId, blackSide.username, blackSide.elo,
                        blackSide.connection),
                timeControl, control[0], control[1], settings,
                gamePool, rules, database, dbWriter, this);

        games.put(gameId, actor);
        byPlayer.put(whiteSide.userId, actor);
        byPlayer.put(blackSide.userId, actor);
        whiteSide.connection.setGameId(gameId);
        blackSide.connection.setGameId(gameId);
        gamesStarted.incrementAndGet();
        actor.begin();
    }

    // ------------------------------------------------------- dinh tuyen vao ban

    /** Chuyen nuoc di cua nguoi choi toi GameActor cua van ho dang choi. */
    public void onMove(Connection connection, MoveCodec.Move move, long receivedAt) {
        actorOf(connection).onMove(connection, move, receivedAt);
    }

    /** Chuyen yeu cau dau hang toi GameActor cua van. */
    public void onResign(Connection connection) {
        actorOf(connection).onResign(connection);
    }

    /** Chuyen loi de nghi hoa toi GameActor cua van. */
    public void onDrawOffer(Connection connection) {
        actorOf(connection).onDrawOffer(connection);
    }

    /** Chuyen cau tra loi de nghi hoa (dong y/tu choi) toi GameActor cua van. */
    public void onDrawReply(Connection connection, boolean accept) {
        actorOf(connection).onDrawReply(connection, accept);
    }

    /** Gui lai snapshot van dang choi cho ket noi (HISTORY_REQ). */
    public void sendSnapshot(Connection connection) {
        GameActor actor = games.get(connection.gameId());
        if (actor != null) {
            actor.sendSnapshotTo(connection);
        }
    }

    /** Tim GameActor cua van ket noi dang choi; khong co thi nem loi 3003. */
    private GameActor actorOf(Connection connection) {
        GameActor actor = games.get(connection.gameId());
        if (actor == null) {
            throw new CgpException(ErrorCode.GAME_NOT_FOUND, "ban khong o trong van nao");
        }
        return actor;
    }

    // ---------------------------------------------------------------- noi lai

    /**
     * Gan ket noi moi vao van dang danh do cua chinh nguoi nay.
     *
     * Goi ca sau LOGIN lan sau RESUME: nguoi dung khong nen phai biet hai duong
     * do khac nhau, va ca hai deu phai dan ve dung mot ket qua (X12).
     *
     * @return false neu khong con van nao dang danh
     */
    public boolean reattach(Connection connection, int lastPly) {
        GameActor actor = byPlayer.get(connection.userId());
        if (actor == null || actor.status() == GameActor.Status.FINISHED) {
            return false;
        }
        return actor.reattach(connection, lastPly);
    }

    /**
     * RESUME khi van da ket thuc trong luc mat ket noi (X13).
     *
     * Tra ket qua that su cua van thay vi mot loi kho hieu - nguoi choi can
     * biet minh thang hay thua, khong can biet rang session cua ho da het viec.
     */
    public void sendLastFinishedGame(Connection connection, long userId) {
        database.findLastFinishedGame(userId).ifPresent(game -> {
            connection.send(FrameCodec.encode(MsgType.GAME_OVER, 0, Json.of(Map.of(
                    "result", game.result() == null ? "" : game.result(),
                    "reason", game.reason() == null ? "" : game.reason(),
                    "eloDelta", 0,
                    "pgn", game.pgn() == null ? "" : game.pgn()))));
        });
    }

    // --------------------------------------------------------------- khan gia

    /**
     * Xem mot van.
     *
     * Van dang chay thi vao thang GameActor. Van da ket thuc thi doc lai tu
     * database va tra ve snapshot + PGN chu khong bao loi (X57): nguoi xem
     * bam vao mot link cu khong phai la mot loi cua ho.
     */
    public void spectateJoin(Connection connection, long gameId) {
        GameActor actor = games.get(gameId);
        if (actor != null) {
            if (actor.hasPlayer(connection.userId())) {
                throw new CgpException(ErrorCode.NOT_A_PLAYER, "ban dang choi van nay");
            }
            actor.addSpectator(connection);
            return;
        }

        Database.GameRow game = database.findGame(gameId)
                .orElseThrow(() -> new CgpException(ErrorCode.GAME_NOT_FOUND, "khong co van #" + gameId));
        List<Database.MoveRow> moves = database.movesOf(gameId);

        List<String> san = new ArrayList<>(moves.size());
        for (Database.MoveRow move : moves) {
            san.add(move.san());
        }
        Database.MoveRow last = moves.isEmpty() ? null : moves.get(moves.size() - 1);

        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("gameId", game.id());
        snapshot.put("fen", last == null
                ? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" : last.fenAfter());
        snapshot.put("ply", moves.size());
        snapshot.put("moves", san);
        snapshot.put("clockW", last == null ? 0 : last.clockWhiteMs());
        snapshot.put("clockB", last == null ? 0 : last.clockBlackMs());
        snapshot.put("turn", moves.size() % 2 == 0 ? "w" : "b");
        snapshot.put("status", game.status());
        snapshot.put("white", game.white());
        snapshot.put("black", game.black());
        snapshot.put("timeControl", game.timeControl());
        snapshot.put("spectators", 0);
        connection.send(FrameCodec.encode(MsgType.GAME_SNAPSHOT, 0, Json.of(snapshot)));
        connection.send(FrameCodec.encode(MsgType.HISTORY_RESULT, 0, Json.of(Map.of(
                "pgn", game.pgn() == null ? "" : game.pgn(),
                "moves", san))));
    }

    /** Ngung xem mot van: go khoi danh sach khan gia cua van. */
    public void spectateLeave(Connection connection, long gameId) {
        GameActor actor = games.get(gameId);
        if (actor != null) {
            actor.removeSpectator(connection);
        } else {
            connection.spectating().remove(gameId);
        }
    }

    /** Danh sach van dang dien ra, cho man hinh chon van cua khan gia. */
    public List<Map<String, Object>> liveGames() {
        List<Map<String, Object>> live = new ArrayList<>();
        for (GameActor actor : games.values()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("gameId", actor.gameId());
            row.put("white", actor.white().username());
            row.put("black", actor.black().username());
            row.put("whiteElo", actor.white().elo());
            row.put("blackElo", actor.black().elo());
            row.put("ply", actor.ply());
            row.put("timeControl", actor.timeControl());
            row.put("status", actor.status().name());
            row.put("spectators", actor.spectatorCount());
            live.add(row);
        }
        live.sort((left, right) -> Long.compare(
                (Long) right.get("gameId"), (Long) left.get("gameId")));
        return live.size() > 50 ? live.subList(0, 50) : live;
    }

    // ---------------------------------------------------------------- su kien

    /** Client bien mat: don khoi hang doi, go khoi khan gia va bao cho doi thu biet. */
    public void onDisconnect(Connection connection) {
        leaveQueue(connection);
        for (Long gameId : connection.spectating()) {
            GameActor watched = games.get(gameId);
            if (watched != null) {
                watched.removeSpectator(connection);
            }
        }
        connection.spectating().clear();

        GameActor actor = games.get(connection.gameId());
        if (actor != null) {
            actor.onDisconnect(connection, graceMs);
        }
    }

    /** Don dep khi van ket thuc: go van khoi bang van dang chay va bang nguoi choi, tang dem. */
    public void onGameFinished(GameActor actor) {
        games.remove(actor.gameId());
        byPlayer.remove(actor.white().userId(), actor);
        byPlayer.remove(actor.black().userId(), actor);
        gamesFinished.incrementAndGet();
    }

    /** Chay moi 100 ms: cap nhat dong ho/an han cua tung van, danh thuc van dang dung vi rules service, bao nguoi cho ghep lau. */
    private void tick() {
        long now = System.currentTimeMillis();
        boolean rulesBack = rules.available();
        for (GameActor actor : games.values()) {
            actor.onTick(now, graceMs);
            // Chi danh thuc nhung ban dung vi rules service chet. Khong loc o day
            // thi moi 100 ms ta lai nhet mot task rong vao hang doi cua tat ca cac
            // ban dang cho nguoi choi noi lai.
            if (rulesBack && actor.pausedByRules()) {
                actor.resumeAfterRulesRecovered();
            }
        }
        noticeLongWaits(now);
    }

    /** Cho ghep qua lau ma im lang thi nguoi dung tuong hong (X23). */
    private void noticeLongWaits(long now) {
        for (Deque<Waiting> queue : queues.values()) {
            synchronized (queue) {
                for (Waiting waiting : queue) {
                    if (waiting.noticed || now - waiting.since < queueNoticeMs) {
                        continue;
                    }
                    waiting.noticed = true;
                    try {
                        waiting.connection.send(FrameCodec.encode(MsgType.PEER_STATUS, 0,
                                Json.of(Map.of("state", "searching",
                                        "waitedMs", now - waiting.since,
                                        "graceMs", 0))));
                    } catch (RuntimeException ignored) {
                        // Ket noi dang hong: vong quet ket noi se don.
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- tien ich

    /** "300+2" -> {300000, 2000}. */
    public static int[] parseTimeControl(String value) {
        String[] parts = normalize(value).split("\\+");
        return new int[] { Integer.parseInt(parts[0]) * 1000, Integer.parseInt(parts[1]) * 1000 };
    }

    /** Kiem tra the thuc dung dang "so+so"; sai thi nem loi 2001. */
    private static String normalize(String value) {
        if (value == null || !value.matches("\\d{1,5}\\+\\d{1,3}")) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME, "the thuc khong hop le: " + value);
        }
        return value;
    }

    /** So van dang dien ra. */
    public int liveGameCount() {
        return games.size();
    }

    /** Tra ve thong ke so van dang choi, da bat dau, da ket thuc, nguoi dang cho ghep va khan gia. */
    public String stats() {
        int waiting = queues.values().stream().mapToInt(Deque::size).sum();
        int spectators = games.values().stream().mapToInt(GameActor::spectatorCount).sum();
        return String.format("van dang choi %d, da bat dau %d, da ket thuc %d, dang cho ghep %d, khan gia %d",
                games.size(), gamesStarted.get(), gamesFinished.get(), waiting, spectators);
    }

    /** Dung scheduler va thread pool cua cac ban co. */
    @Override
    public void close() {
        scheduler.shutdownNow();
        gamePool.shutdownNow();
    }
}
