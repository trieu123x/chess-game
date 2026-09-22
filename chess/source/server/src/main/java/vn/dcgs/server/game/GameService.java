package vn.dcgs.server.game;

import vn.dcgs.common.CgpException;
import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.MoveCodec;
import vn.dcgs.server.Config;
import vn.dcgs.server.data.Database;
import vn.dcgs.server.net.Connection;
import vn.dcgs.server.net.RulesClient;

import java.util.ArrayDeque;
import java.util.Deque;
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
 * Day la lop duy nhat ma lop mang goi toi: NioServer khong biet gi ve luat co,
 * con GameActor khong biet gi ve socket. Ranh gioi do la thu giu cho hai phan
 * co the do rieng (E2 do lop mang, E7 do rules service).
 */
public final class GameService implements AutoCloseable {

    private final Database database;
    private final RulesClient rules;
    private final ExecutorService gamePool;
    private final ScheduledExecutorService scheduler;

    private final Map<Long, GameActor> games = new ConcurrentHashMap<>();
    /** Hang doi ghep cap, tach theo the thuc: 3+2 khong ghep voi 10+0. */
    private final Map<String, Deque<Waiting>> queues = new ConcurrentHashMap<>();

    private final boolean compensateLatency;
    private final long compensationCapMs;
    private final long graceMs;

    private final AtomicLong gamesStarted = new AtomicLong();
    private final AtomicLong gamesFinished = new AtomicLong();

    private record Waiting(Connection connection, long userId, String username, int elo, long since) {
    }

    public GameService(Config config, Database database, RulesClient rules) {
        this.database = database;
        this.rules = rules;
        this.compensateLatency = config.getBoolean("clock.compensation", true);
        this.compensationCapMs = config.getInt("clock.compensationCapMs", 200);
        this.graceMs = config.getInt("reconnect.graceMs", 60_000);

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

    public void joinQueue(Connection connection, String timeControl, int elo) {
        if (connection.gameId() != 0) {
            throw new CgpException(ErrorCode.ALREADY_QUEUED, "ban dang trong mot van");
        }
        String normalized = normalize(timeControl);
        Deque<Waiting> queue = queues.computeIfAbsent(normalized, key -> new ArrayDeque<>());

        Waiting opponent;
        synchronized (queue) {
            // Khong ghep mot nguoi voi chinh ho (X21), va don luon nhung nguoi
            // da mat ket noi trong luc cho (X19).
            queue.removeIf(waiting -> waiting.connection().state() == Connection.State.CLOSING
                    || waiting.userId() == connection.userId());
            opponent = queue.pollFirst();
            if (opponent == null) {
                queue.addLast(new Waiting(connection, connection.userId(), connection.username(),
                        elo, System.currentTimeMillis()));
                return;
            }
        }
        startGame(opponent, new Waiting(connection, connection.userId(), connection.username(),
                elo, System.currentTimeMillis()), normalized);
    }

    public void leaveQueue(Connection connection) {
        for (Deque<Waiting> queue : queues.values()) {
            synchronized (queue) {
                queue.removeIf(waiting -> waiting.connection() == connection);
            }
        }
    }

    private void startGame(Waiting first, Waiting second, String timeControl) {
        // Nguoi cho lau hon cam Trang - de don gian va co the giai thich duoc.
        Waiting whiteSide = first;
        Waiting blackSide = second;

        long gameId = database.createGame(whiteSide.userId(), blackSide.userId(), timeControl);
        int[] control = parseTimeControl(timeControl);

        GameActor actor = new GameActor(gameId,
                new GameActor.Player(whiteSide.userId(), whiteSide.username(), whiteSide.elo(),
                        whiteSide.connection()),
                new GameActor.Player(blackSide.userId(), blackSide.username(), blackSide.elo(),
                        blackSide.connection()),
                timeControl, control[0], control[1],
                compensateLatency, compensationCapMs,
                gamePool, rules, database, this);

        games.put(gameId, actor);
        whiteSide.connection().setGameId(gameId);
        blackSide.connection().setGameId(gameId);
        gamesStarted.incrementAndGet();
        actor.begin();
    }

    // ------------------------------------------------------- dinh tuyen vao ban

    public void onMove(Connection connection, MoveCodec.Move move, long receivedAt) {
        actorOf(connection).onMove(connection, move, receivedAt);
    }

    public void onResign(Connection connection) {
        actorOf(connection).onResign(connection);
    }

    public void onDrawOffer(Connection connection) {
        actorOf(connection).onDrawOffer(connection);
    }

    public void onDrawReply(Connection connection, boolean accept) {
        actorOf(connection).onDrawReply(connection, accept);
    }

    public void sendSnapshot(Connection connection) {
        GameActor actor = games.get(connection.gameId());
        if (actor != null) {
            actor.sendSnapshotTo(connection);
        }
    }

    private GameActor actorOf(Connection connection) {
        GameActor actor = games.get(connection.gameId());
        if (actor == null) {
            throw new CgpException(ErrorCode.GAME_NOT_FOUND, "ban khong o trong van nao");
        }
        return actor;
    }

    /** Client bien mat: don khoi hang doi va bao cho doi thu biet. */
    public void onDisconnect(Connection connection) {
        leaveQueue(connection);
        GameActor actor = games.get(connection.gameId());
        if (actor != null) {
            actor.onDisconnect(connection, graceMs);
        }
    }

    public void onGameFinished(GameActor actor) {
        games.remove(actor.gameId());
        gamesFinished.incrementAndGet();
    }

    private void tick() {
        long now = System.currentTimeMillis();
        for (GameActor actor : games.values()) {
            actor.onTick(now, graceMs);
        }
    }

    // ---------------------------------------------------------------- tien ich

    /** "300+2" -> {300000, 2000}. */
    public static int[] parseTimeControl(String value) {
        String[] parts = normalize(value).split("\\+");
        return new int[] { Integer.parseInt(parts[0]) * 1000, Integer.parseInt(parts[1]) * 1000 };
    }

    private static String normalize(String value) {
        if (value == null || !value.matches("\\d{1,5}\\+\\d{1,3}")) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME, "the thuc khong hop le: " + value);
        }
        return value;
    }

    public String stats() {
        int waiting = queues.values().stream().mapToInt(Deque::size).sum();
        return String.format("van dang choi %d, da bat dau %d, da ket thuc %d, dang cho ghep %d",
                games.size(), gamesStarted.get(), gamesFinished.get(), waiting);
    }

    @Override
    public void close() {
        scheduler.shutdownNow();
        gamePool.shutdownNow();
    }
}
