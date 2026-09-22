package vn.dcgs.server.game;

import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.Json;
import vn.dcgs.common.MoveCodec;
import vn.dcgs.common.MsgType;
import vn.dcgs.server.data.Database;
import vn.dcgs.server.net.Connection;
import vn.dcgs.server.net.RulesClient;

import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Mot ban co.
 *
 * **Mo hinh dong bo:** moi ban co mot hang doi rieng; cac viec cua cung mot
 * ban chay TUAN TU tren thread pool dung chung. Nho vay khong co hai thread
 * nao cham vao trang thai ban co cung luc, va khong can mot `synchronized`
 * nao trong toan bo logic ben duoi — thay vi rai khoa khap noi roi hy vong
 * khong bo sot cho nao.
 *
 * Server la nguon chan ly: client khong duoc quyet dinh nuoc di co hop le hay
 * khong, va cung khong duoc quyet dinh minh da tieu bao nhieu thoi gian.
 */
public final class GameActor {

    /** Trang thai ban co, khop voi CHECK trong bang `games`. */
    public enum Status { IN_PROGRESS, PAUSED, FINISHED }

    private final long gameId;
    private final Executor pool;
    private final RulesClient rules;
    private final Database database;
    private final GameService service;

    private final Player white;
    private final Player black;
    private final String timeControl;
    private final int incrementMs;
    private final boolean compensateLatency;
    private final long compensationCapMs;

    private final Deque<Runnable> mailbox = new ArrayDeque<>();
    private final AtomicBoolean draining = new AtomicBoolean();

    private String fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    private final List<String> sanMoves = new ArrayList<>();
    private final List<String> uciMoves = new ArrayList<>();
    private int ply;
    private long clockWhiteMs;
    private long clockBlackMs;
    private long turnStartedAt;
    private Status status = Status.IN_PROGRESS;
    private long drawOfferBy;
    private int drawOfferPly = -1_000;
    private long pausedSince;
    private long pausedUserId;

    public record Player(long userId, String username, int elo, Connection connection) {
    }

    public GameActor(long gameId, Player white, Player black, String timeControl,
                     int initialMs, int incrementMs, boolean compensateLatency, long compensationCapMs,
                     Executor pool, RulesClient rules, Database database, GameService service) {
        this.gameId = gameId;
        this.white = white;
        this.black = black;
        this.timeControl = timeControl;
        this.incrementMs = incrementMs;
        this.compensateLatency = compensateLatency;
        this.compensationCapMs = compensationCapMs;
        this.pool = pool;
        this.rules = rules;
        this.database = database;
        this.service = service;
        this.clockWhiteMs = initialMs;
        this.clockBlackMs = initialMs;
    }

    public long gameId() {
        return gameId;
    }

    public Status status() {
        return status;
    }

    /** Xep mot viec vao hang doi cua ban nay. An toan tu bat ky thread nao. */
    public void submit(Runnable task) {
        synchronized (mailbox) {
            if (mailbox.size() > 1_000) {
                // Hang doi day nghia la mot client dang spam (X53): bo message
                // cua chinh no, cac ban khac khong bi anh huong.
                return;
            }
            mailbox.addLast(task);
        }
        schedule();
    }

    private void schedule() {
        if (draining.compareAndSet(false, true)) {
            pool.execute(this::drain);
        }
    }

    private void drain() {
        try {
            for (;;) {
                Runnable task;
                synchronized (mailbox) {
                    task = mailbox.pollFirst();
                }
                if (task == null) {
                    return;
                }
                try {
                    task.run();
                } catch (RuntimeException failure) {
                    System.err.printf("Ban #%d: loi khi xu ly: %s%n", gameId, failure);
                }
            }
        } finally {
            draining.set(false);
            boolean more;
            synchronized (mailbox) {
                more = !mailbox.isEmpty();
            }
            if (more) {
                schedule();
            }
        }
    }

    // ---------------------------------------------------------------- bat dau

    public void begin() {
        submit(() -> {
            turnStartedAt = System.currentTimeMillis();
            send(white.connection(), MsgType.MATCH_FOUND, Json.of(Map.of(
                    "gameId", gameId, "color", "w", "opponent", black.username(),
                    "oppElo", black.elo(), "timeControl", timeControl)));
            send(black.connection(), MsgType.MATCH_FOUND, Json.of(Map.of(
                    "gameId", gameId, "color", "b", "opponent", white.username(),
                    "oppElo", white.elo(), "timeControl", timeControl)));
            broadcastSnapshot();
            System.out.printf("Ban #%d bat dau: %s (%d) vs %s (%d), %s%n",
                    gameId, white.username(), white.elo(), black.username(), black.elo(), timeControl);
        });
    }

    // ---------------------------------------------------------------- nuoc di

    /**
     * Xu ly mot nuoc di.
     *
     * @param receivedAt moc thoi gian server NHAN duoc nuoc di. Dung moc nay
     *        chu khong phai luc kiem tra xong, vi kiem tra luat co the mat
     *        vai ms va ket qua van dau khong duoc phu thuoc vao do (X25).
     */
    public void onMove(Connection from, MoveCodec.Move move, long receivedAt) {
        submit(() -> {
            if (status == Status.FINISHED) {
                sendError(from, ErrorCode.GAME_ALREADY_OVER, "van da ket thuc");
                return;
            }
            Player mover = playerOf(from);
            if (mover == null) {
                sendError(from, ErrorCode.NOT_A_PLAYER, "ban khong phai nguoi choi cua van nay");
                return;
            }
            boolean whiteToMove = ply % 2 == 0;
            if ((mover == white) != whiteToMove) {
                sendError(from, ErrorCode.NOT_YOUR_TURN, "chua den luot ban");
                return;
            }
            if (move.ply() != ply) {
                // Nuoc di den muon hoac gui trung (X24/X: idempotent theo ply).
                send(from, MsgType.MOVE_REJECTED, Json.of(Map.of(
                        "code", ErrorCode.STALE_PLY, "reason", "nuoc di khong con dung luot",
                        "expectedPly", ply)));
                return;
            }

            RulesClient.Verdict verdict;
            try {
                verdict = rules.validate(fen, move.from(), move.to(),
                        move.promotion() == 0 ? "" : String.valueOf(MoveCodec.promotionLetter(move.promotion())));
            } catch (RuntimeException unavailable) {
                // Rules service chet: van KHONG mat, chuyen PAUSED va bao loi (X44).
                pause(ErrorCode.RULES_UNAVAILABLE, "khong kiem tra duoc luat, van tam dung");
                return;
            }

            if (!verdict.legal()) {
                send(from, MsgType.MOVE_REJECTED, Json.of(Map.of(
                        "code", verdict.errorCode(), "reason", verdict.reason(), "expectedPly", ply)));
                database.logRejected(gameId, mover.userId(), verdict.errorCode(),
                        move.from() + move.to() + " tren " + fen);
                return;
            }

            // Tru gio theo moc server nhan duoc, co bu mot nua RTT (dong gop N2).
            long elapsed = receivedAt - turnStartedAt;
            if (compensateLatency) {
                elapsed -= Math.min(from.rttMs() / 2, compensationCapMs);
            }
            elapsed = Math.max(0, elapsed);

            long remaining = (mover == white ? clockWhiteMs : clockBlackMs) - elapsed;
            if (remaining <= 0) {
                finish(mover == white ? "0-1" : "1-0", "timeout");
                return;
            }
            remaining += incrementMs;
            if (mover == white) {
                clockWhiteMs = remaining;
            } else {
                clockBlackMs = remaining;
            }

            fen = verdict.fenAfter();
            ply++;
            sanMoves.add(verdict.san());
            uciMoves.add(verdict.uci());
            turnStartedAt = System.currentTimeMillis();
            drawOfferBy = 0;

            int processMs = (int) Math.min(65_535, System.currentTimeMillis() - receivedAt);
            byte[] applied = MoveCodec.encodeMoveApplied(new MoveCodec.MoveApplied(
                    ply, move.from(), move.to(), move.promotion(), verdict.flags(),
                    clockWhiteMs, clockBlackMs, processMs));
            broadcast(MsgType.MOVE_APPLIED, applied);

            database.appendMove(gameId, ply, verdict.uci(), verdict.san(), fen,
                    (int) clockWhiteMs, (int) clockBlackMs, receivedAt);

            if (verdict.endsGame()) {
                finish(resultFor(verdict.status(), mover), verdict.status());
            }
        });
    }

    private String resultFor(String status, Player mover) {
        if ("checkmate".equals(status)) {
            return mover == white ? "1-0" : "0-1";
        }
        return "1/2-1/2";
    }

    // ------------------------------------------------------------ thao tac khac

    public void onResign(Connection from) {
        submit(() -> {
            Player mover = playerOf(from);
            if (mover == null || status == Status.FINISHED) {
                return;
            }
            finish(mover == white ? "0-1" : "1-0", "resign");
        });
    }

    public void onDrawOffer(Connection from) {
        submit(() -> {
            Player mover = playerOf(from);
            if (mover == null || status == Status.FINISHED) {
                return;
            }
            if (ply - drawOfferPly < 10) {
                // Chong spam moi hoa (X30).
                sendError(from, ErrorCode.RATE_LIMITED, "moi hoa qua thuong xuyen");
                return;
            }
            drawOfferBy = mover.userId();
            drawOfferPly = ply;
            send(opponentOf(mover).connection(), MsgType.DRAW_OFFERED, new byte[0]);
        });
    }

    public void onDrawReply(Connection from, boolean accept) {
        submit(() -> {
            Player replier = playerOf(from);
            if (replier == null || status == Status.FINISHED || drawOfferBy == 0
                    || drawOfferBy == replier.userId()) {
                return;
            }
            drawOfferBy = 0;
            if (accept) {
                finish("1/2-1/2", "agreement");
            }
        });
    }

    /** Doi thu mat ket noi: van chuyen PAUSED, dong ho VAN chay (nhu lichess). */
    public void onDisconnect(Connection gone, long graceMs) {
        submit(() -> {
            Player player = playerOf(gone);
            if (player == null || status == Status.FINISHED) {
                return;
            }
            status = Status.PAUSED;
            pausedSince = System.currentTimeMillis();
            pausedUserId = player.userId();
            database.setGameStatus(gameId, "PAUSED");
            send(opponentOf(player).connection(), MsgType.PEER_STATUS, Json.of(Map.of(
                    "state", "disconnected", "graceMs", graceMs)));
            System.out.printf("Ban #%d: %s mat ket noi, an han %d ms%n",
                    gameId, player.username(), graceMs);
        });
    }

    /** Dong ho va thoi gian an han deu do server quet, khong phu thuoc client. */
    public void onTick(long now, long graceMs) {
        submit(() -> {
            if (status == Status.FINISHED) {
                return;
            }
            if (status == Status.PAUSED && now - pausedSince > graceMs) {
                finish(pausedUserId == white.userId() ? "0-1" : "1-0", "disconnect");
                return;
            }
            boolean whiteToMove = ply % 2 == 0;
            long remaining = (whiteToMove ? clockWhiteMs : clockBlackMs) - (now - turnStartedAt);
            if (remaining <= 0) {
                if (whiteToMove) {
                    clockWhiteMs = 0;
                } else {
                    clockBlackMs = 0;
                }
                finish(whiteToMove ? "0-1" : "1-0", "timeout");
            }
        });
    }

    private void pause(int code, String message) {
        status = Status.PAUSED;
        pausedSince = System.currentTimeMillis();
        database.setGameStatus(gameId, "PAUSED");
        byte[] payload = Json.of(Map.of("code", code, "message", message));
        broadcast(MsgType.ERROR, payload);
    }

    // ---------------------------------------------------------------- ket thuc

    private void finish(String result, String reason) {
        if (status == Status.FINISHED) {
            return;
        }
        status = Status.FINISHED;

        int[] deltas = Elo.deltas(white.elo(), black.elo(), result);
        String pgn = PgnWriter.write(white.username(), black.username(), result, reason,
                timeControl, sanMoves);

        database.finishGame(gameId, result, reason, pgn);
        database.updateElo(white.userId(), white.elo() + deltas[0],
                black.userId(), black.elo() + deltas[1]);

        sendGameOver(white, result, reason, deltas[0], pgn);
        sendGameOver(black, result, reason, deltas[1], pgn);

        white.connection().setGameId(0);
        black.connection().setGameId(0);
        service.onGameFinished(this);

        System.out.printf("Ban #%d ket thuc: %s (%s) sau %d nuoc | Elo %+d/%+d%n",
                gameId, result, reason, ply, deltas[0], deltas[1]);
    }

    private void sendGameOver(Player player, String result, String reason, int eloDelta, String pgn) {
        send(player.connection(), MsgType.GAME_OVER, Json.of(Map.of(
                "result", result, "reason", reason, "eloDelta", eloDelta, "pgn", pgn)));
    }

    // ---------------------------------------------------------------- tro giup

    public void sendSnapshotTo(Connection connection) {
        submit(() -> send(connection, MsgType.GAME_SNAPSHOT, snapshot()));
    }

    private void broadcastSnapshot() {
        byte[] payload = snapshot();
        send(white.connection(), MsgType.GAME_SNAPSHOT, payload);
        send(black.connection(), MsgType.GAME_SNAPSHOT, payload);
    }

    private byte[] snapshot() {
        Map<String, Object> fields = new HashMap<>();
        fields.put("gameId", gameId);
        fields.put("fen", fen);
        fields.put("ply", ply);
        fields.put("moves", sanMoves);
        fields.put("clockW", clockWhiteMs);
        fields.put("clockB", clockBlackMs);
        fields.put("turn", ply % 2 == 0 ? "w" : "b");
        fields.put("status", status.name());
        return Json.of(fields);
    }

    private Player playerOf(Connection connection) {
        if (white.connection() == connection) {
            return white;
        }
        return black.connection() == connection ? black : null;
    }

    private Player opponentOf(Player player) {
        return player == white ? black : white;
    }

    private void broadcast(int type, byte[] payload) {
        send(white.connection(), type, payload);
        send(black.connection(), type, payload);
    }

    private void send(Connection connection, int type, byte[] payload) {
        try {
            ByteBuffer frame = FrameCodec.encode(type, 0, payload);
            connection.send(frame);
        } catch (RuntimeException overflow) {
            // Client doc qua cham hoac da dong: khong duoc lam hong ban co.
            connection.markClosing();
        }
    }

    private void sendError(Connection connection, int code, String message) {
        send(connection, MsgType.ERROR, Json.of(Map.of("code", code, "message", message)));
    }

    public List<String> sanMoves() {
        return List.copyOf(sanMoves);
    }
}
