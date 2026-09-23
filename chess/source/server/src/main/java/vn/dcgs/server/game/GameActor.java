package vn.dcgs.server.game;

import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.Json;
import vn.dcgs.common.MoveCodec;
import vn.dcgs.common.MsgType;
import vn.dcgs.common.WireFormat;
import vn.dcgs.server.data.Database;
import vn.dcgs.server.data.DbWriter;
import vn.dcgs.server.net.Connection;
import vn.dcgs.server.net.RulesEngine;

import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
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
 * Hai he qua cua mo hinh do, ca hai deu la quy tac cung:
 *  1. Khong duoc chan lau tren thread nay. Moi thao tac database di qua
 *     {@link DbWriter} (ngoai le X51).
 *  2. Moi thay doi trang thai ban co chi duoc xay ra ben trong mot task da
 *     `submit`, khong bao gio tu thread mang.
 *
 * Server la nguon chan ly: client khong duoc quyet dinh nuoc di co hop le hay
 * khong, va cung khong duoc quyet dinh minh da tieu bao nhieu thoi gian.
 */
public final class GameActor {

    /** Trang thai ban co, khop voi CHECK trong bang `games`. */
    public enum Status { IN_PROGRESS, PAUSED, FINISHED }

    /**
     * Mot ben choi.
     *
     * `connection` doi duoc vi noi lai sau khi rot mang (dong gop N5) chinh la
     * viec gan mot socket MOI vao cung mot nguoi choi cua cung mot ban co.
     */
    public static final class Player {

        private final long userId;
        private final String username;
        private final int elo;
        private volatile Connection connection;

        /** Tao nguoi choi voi id, ten, Elo va ket noi hien tai. */
        public Player(long userId, String username, int elo, Connection connection) {
            this.userId = userId;
            this.username = username;
            this.elo = elo;
            this.connection = connection;
        }

        /** Id nguoi dung. */
        public long userId() {
            return userId;
        }

        /** Ten dang nhap. */
        public String username() {
            return username;
        }

        /** Elo luc bat dau van. */
        public int elo() {
            return elo;
        }

        /** Ket noi hien tai cua nguoi choi (thay doi khi noi lai). */
        public Connection connection() {
            return connection;
        }
    }

    private final long gameId;
    private final Executor pool;
    private final RulesEngine rules;
    private final Database database;
    private final DbWriter dbWriter;
    private final GameService service;
    private final WireFormat format;

    private final Player white;
    private final Player black;
    private final String timeControl;
    private final int incrementMs;
    private final boolean compensateLatency;
    private final long compensationCapMs;
    private final int actorQueueMax;
    private final int drawCooldownPlies;

    private final Deque<Runnable> mailbox = new ArrayDeque<>();
    private final AtomicBoolean draining = new AtomicBoolean();

    private String fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    private final List<String> sanMoves = new ArrayList<>();
    private final List<String> uciMoves = new ArrayList<>();
    /**
     * Payload MOVE_APPLIED da gui cho tung nuoc, index = ply - 1.
     *
     * Day la nguon PHAT LAI khi mot nguoi noi lai giua ván (dong gop N5): phat
     * lai dung nhung byte da gui lan dau, khong dung lai tu FEN, nen client
     * nhan duoc chuoi su kien y het nhu chua tung mat ket noi.
     */
    private final List<byte[]> appliedPayloads = new ArrayList<>();
    private int ply;
    private long clockWhiteMs;
    private long clockBlackMs;
    private long turnStartedAt;
    private Status status = Status.IN_PROGRESS;
    private long drawOfferBy;
    private int drawOfferPly = -1_000;
    private long pausedSince;
    private long pausedUserId;
    private String pauseReason = "";
    private long droppedFromQueue;

    /** Khan gia. Khong duoc lam cham nguoi choi trong bat ky hoan canh nao (X58). */
    private final Set<Connection> spectators = ConcurrentHashMap.newKeySet();

    /** Tao ban co moi: luu thong tin hai nguoi choi, the thuc, cau hinh va dat dong ho hai ben bang thoi gian goc. */
    public GameActor(long gameId, Player white, Player black, String timeControl,
                     int initialMs, int incrementMs, GameService.Settings settings,
                     Executor pool, RulesEngine rules, Database database, DbWriter dbWriter,
                     GameService service) {
        this.gameId = gameId;
        this.white = white;
        this.black = black;
        this.timeControl = timeControl;
        this.incrementMs = incrementMs;
        this.compensateLatency = settings.compensateLatency();
        this.compensationCapMs = settings.compensationCapMs();
        this.actorQueueMax = settings.actorQueueMax();
        this.drawCooldownPlies = settings.drawCooldownPlies();
        this.format = settings.format();
        this.pool = pool;
        this.rules = rules;
        this.database = database;
        this.dbWriter = dbWriter;
        this.service = service;
        this.clockWhiteMs = initialMs;
        this.clockBlackMs = initialMs;
    }

    /** Id cua van. */
    public long gameId() {
        return gameId;
    }

    /** Trang thai hien tai cua van. */
    public Status status() {
        return status;
    }

    /** Nguoi cam quan Trang. */
    public Player white() {
        return white;
    }

    /** Nguoi cam quan Den. */
    public Player black() {
        return black;
    }

    /** So nua nuoc da di. */
    public int ply() {
        return ply;
    }

    /** The thuc cua van, vi du "300+2". */
    public String timeControl() {
        return timeControl;
    }

    /** So khan gia dang xem. */
    public int spectatorCount() {
        return spectators.size();
    }

    /** Nguoi dung co phai mot trong hai nguoi choi cua van khong. */
    public boolean hasPlayer(long userId) {
        return white.userId() == userId || black.userId() == userId;
    }

    /** Xep mot viec vao hang doi cua ban nay. An toan tu bat ky thread nao. */
    public void submit(Runnable task) {
        synchronized (mailbox) {
            if (mailbox.size() > actorQueueMax) {
                // Hang doi day nghia la mot client dang spam (X53): bo message
                // cua chinh no, cac ban khac khong bi anh huong.
                droppedFromQueue++;
                return;
            }
            mailbox.addLast(task);
        }
        schedule();
    }

    /** Neu chua co thread nao dang xu ly hang doi cua ban nay thi dua viec drain vao thread pool. */
    private void schedule() {
        if (draining.compareAndSet(false, true)) {
            pool.execute(this::drain);
        }
    }

    /** Chay lan luot cac viec trong hang doi cho toi khi het; xong thi kiem tra lai de khong bo sot viec vua toi. */
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

    /** Bat dau van: bat dong ho, gui MATCH_FOUND cho hai nguoi choi va gui snapshot ban co. */
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
                // Nuoc di chay dua voi het gio: van da xong thi khong doi gi nua (X24).
                sendError(from, ErrorCode.GAME_ALREADY_OVER, "van da ket thuc");
                logSuspicious(from, ErrorCode.GAME_ALREADY_OVER, move);
                return;
            }
            Player mover = playerOf(from);
            if (mover == null) {
                // Gui nuoc di cho van cua nguoi khac (X32) - du lieu tho cua E6.
                sendError(from, ErrorCode.NOT_A_PLAYER, "ban khong phai nguoi choi cua van nay");
                logSuspicious(from, ErrorCode.NOT_A_PLAYER, move);
                return;
            }
            if (status == Status.PAUSED) {
                sendError(from, ErrorCode.RULES_UNAVAILABLE, "van dang tam dung: " + pauseReason);
                return;
            }
            boolean whiteToMove = ply % 2 == 0;
            if ((mover == white) != whiteToMove) {
                sendError(from, ErrorCode.NOT_YOUR_TURN, "chua den luot ban");
                logSuspicious(from, ErrorCode.NOT_YOUR_TURN, move);
                return;
            }
            if (move.ply() != ply) {
                // Nuoc di den muon hoac gui trung: ap dung nuoc di la idempotent
                // theo `ply` nen khong bao gio ap hai lan (X38).
                send(from, MsgType.MOVE_REJECTED, Json.of(Map.of(
                        "code", ErrorCode.STALE_PLY, "reason", "nuoc di khong con dung luot",
                        "expectedPly", ply)));
                logSuspicious(from, ErrorCode.STALE_PLY, move);
                return;
            }

            RulesEngine.Verdict verdict;
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
                dbWriter.submitBestEffort("rejected_move", () -> database.logRejected(
                        gameId, mover.userId(), verdict.errorCode(),
                        move.from() + move.to() + " tren " + fen));
                return;
            }

            // Tru gio theo moc server nhan duoc, co bu mot nua RTT (dong gop N2).
            // RTT la do server tu do qua chu trinh heartbeat, khong phai so client khai (X33).
            long elapsed = receivedAt - turnStartedAt;
            if (compensateLatency) {
                elapsed -= Math.min(from.rttMs() / 2, compensationCapMs);
            }
            elapsed = Math.max(0, elapsed);

            long remaining = (mover == white ? clockWhiteMs : clockBlackMs) - elapsed;
            if (remaining <= 0) {
                // Kep ve 0 thay vi gui so am cho client (X36).
                if (mover == white) {
                    clockWhiteMs = 0;
                } else {
                    clockBlackMs = 0;
                }
                finishByTimeout(mover);
                return;
            }
            remaining += incrementMs;
            if (mover == white) {
                clockWhiteMs = remaining;
            } else {
                clockBlackMs = remaining;
            }

            String fenAfter = verdict.fenAfter();
            fen = fenAfter;
            ply++;
            sanMoves.add(verdict.san());
            uciMoves.add(verdict.uci());
            turnStartedAt = System.currentTimeMillis();
            drawOfferBy = 0;

            int processMs = (int) Math.min(65_535, System.currentTimeMillis() - receivedAt);
            byte[] applied = format.encodeMoveApplied(new MoveCodec.MoveApplied(
                    ply, move.from(), move.to(), move.promotion(), verdict.flags(),
                    clockWhiteMs, clockBlackMs, processMs), fenAfter, verdict.san());
            appliedPayloads.add(applied);
            broadcast(MsgType.MOVE_APPLIED, applied);

            int snapshotPly = ply;
            long snapshotWhite = clockWhiteMs;
            long snapshotBlack = clockBlackMs;
            dbWriter.submitCritical("move",
                    gameId + "," + snapshotPly + "," + verdict.uci() + "," + verdict.san(),
                    () -> database.appendMove(gameId, snapshotPly, verdict.uci(), verdict.san(),
                            fenAfter, (int) snapshotWhite, (int) snapshotBlack, receivedAt));

            if (verdict.endsGame()) {
                finish(resultFor(verdict.status(), mover), verdict.status());
            }
        });
    }

    /**
     * Het gio.
     *
     * Theo luat FIDE, het gio ma ben con lai KHONG du quan de chieu het thi la
     * hoa chu khong phai thua (X29). Rules service tra cho ta co
     * `insufficient_material` de biet dieu do.
     */
    private void finishByTimeout(Player flagged) {
        boolean opponentCanMate = true;
        try {
            opponentCanMate = !rules.insufficientMaterialFor(fen, flagged == white ? "b" : "w");
        } catch (RuntimeException unavailable) {
            // Khong hoi duoc thi xu theo huong thong thuong va ghi log de biet.
            System.err.printf("Ban #%d: khong kiem tra duoc du quan khi het gio%n", gameId);
        }
        if (!opponentCanMate) {
            finish("1/2-1/2", "timeout_insufficient_material");
            return;
        }
        finish(flagged == white ? "0-1" : "1-0", "timeout");
    }

    /** Xac dinh ket qua tu trang thai ket thuc: chieu het thi nguoi vua di thang, con lai la hoa. */
    private String resultFor(String status, Player mover) {
        if ("checkmate".equals(status)) {
            return mover == white ? "1-0" : "0-1";
        }
        return "1/2-1/2";
    }

    /** Nhat ky request bi tu choi: du lieu tho cho thi nghiem E6 va de soi gian lan. */
    private void logSuspicious(Connection from, int code, MoveCodec.Move move) {
        long userId = from.userId();
        String detail = move.uci() + " ply=" + move.ply() + " (server ply=" + ply + ")";
        dbWriter.submitBestEffort("rejected_move",
                () -> database.logRejected(gameId, userId == 0 ? null : userId, code, detail));
    }

    // ------------------------------------------------------------ thao tac khac

    /** Xu ly dau hang: nguoi dau hang thua, doi thu thang. */
    public void onResign(Connection from) {
        submit(() -> {
            Player mover = playerOf(from);
            if (mover == null) {
                sendError(from, ErrorCode.NOT_A_PLAYER, "ban khong phai nguoi choi cua van nay");
                return;
            }
            if (status == Status.FINISHED) {
                sendError(from, ErrorCode.GAME_ALREADY_OVER, "van da ket thuc");   // X31
                return;
            }
            finish(mover == white ? "0-1" : "1-0", "resign");
        });
    }

    /** Xu ly de nghi hoa: kiem tra quyen va thoi gian cho giua hai lan moi, roi gui DRAW_OFFERED cho doi thu. */
    public void onDrawOffer(Connection from) {
        submit(() -> {
            Player mover = playerOf(from);
            if (mover == null) {
                sendError(from, ErrorCode.NOT_A_PLAYER, "ban khong phai nguoi choi cua van nay");
                return;
            }
            if (status == Status.FINISHED) {
                sendError(from, ErrorCode.GAME_ALREADY_OVER, "van da ket thuc");
                return;
            }
            if (ply - drawOfferPly < drawCooldownPlies) {
                // Chong spam moi hoa (X30).
                sendError(from, ErrorCode.RATE_LIMITED, "moi hoa qua thuong xuyen");
                return;
            }
            drawOfferBy = mover.userId();
            drawOfferPly = ply;
            send(opponentOf(mover).connection(), MsgType.DRAW_OFFERED, new byte[0]);
        });
    }

    /** Xu ly tra loi de nghi hoa: chi doi thu cua nguoi moi moi tra loi duoc; dong y thi ket thuc van hoa. */
    public void onDrawReply(Connection from, boolean accept) {
        submit(() -> {
            Player replier = playerOf(from);
            if (replier == null) {
                sendError(from, ErrorCode.NOT_A_PLAYER, "ban khong phai nguoi choi cua van nay");
                return;
            }
            if (status == Status.FINISHED) {
                sendError(from, ErrorCode.GAME_ALREADY_OVER, "van da ket thuc");   // X31
                return;
            }
            if (drawOfferBy == 0 || drawOfferBy == replier.userId()) {
                return;
            }
            drawOfferBy = 0;
            if (accept) {
                finish("1/2-1/2", "agreement");
            }
        });
    }

    // ------------------------------------------------------ mat ket noi / noi lai

    /** Mot ben mat ket noi: van chuyen PAUSED, dong ho VAN chay (nhu lichess). */
    public void onDisconnect(Connection gone, long graceMs) {
        submit(() -> {
            Player player = playerOf(gone);
            if (player != null && player.connection() == gone && status != Status.FINISHED) {
                status = Status.PAUSED;
                pausedSince = System.currentTimeMillis();
                pausedUserId = player.userId();
                pauseReason = "doi " + player.username() + " noi lai";
                dbWriter.submitBestEffort("game_status", () -> database.setGameStatus(gameId, "PAUSED"));
                send(opponentOf(player).connection(), MsgType.PEER_STATUS, Json.of(Map.of(
                        "state", "disconnected", "graceMs", graceMs)));
                System.out.printf("Ban #%d: %s mat ket noi, an han %d ms%n",
                        gameId, player.username(), graceMs);
            }
            // Khan gia dong tab thi chi can go khoi danh sach (X59).
            if (spectators.remove(gone)) {
                broadcastSpectatorCount();
            }
        });
    }

    /**
     * Gan mot ket noi MOI vao nguoi choi cu va phat lai phan con thieu.
     *
     * Day la noi dung cua dong gop N5, do o thi nghiem E5. Ba diem quan trong:
     *
     *  - Snapshot duoc gui TRUOC, nen du client khai `lastPly` sai kieu gi
     *    (X14: `lastPly` = 9999) thi no van co trang thai dung.
     *  - Phat lai bang dung nhung byte MOVE_APPLIED da gui lan dau, nen chuoi
     *    su kien client thay khong khac gi khi khong rot mang.
     *  - Van chi tro lai IN_PROGRESS khi ca hai ben deu co ket noi song.
     *
     * @return false neu ban nay da ket thuc va khong con gi de noi lai
     */
    public boolean reattach(Connection connection, int lastPly) {
        if (status == Status.FINISHED) {
            return false;
        }
        // Gan gameId NGAY, khong doi task duoi chay.
        //
        // Message ke tiep cua client (thuong la RESIGN hoac MOVE) duoc dinh
        // tuyen bang `connection.gameId()` tren thread mang. Neu de viec gan
        // nam trong task cua actor thi message do co the toi truoc va bi tra
        // 3003 "khong o trong van nao" — trong khi nguoi choi vua noi lai dung
        // van cua ho xong.
        connection.setGameId(gameId);
        submit(() -> {
            Player player = playerOf(connection.userId());
            if (player == null) {
                return;
            }
            player.connection = connection;

            send(connection, MsgType.MATCH_FOUND, Json.of(Map.of(
                    "gameId", gameId,
                    "color", player == white ? "w" : "b",
                    "opponent", opponentOf(player).username(),
                    "oppElo", opponentOf(player).elo(),
                    "timeControl", timeControl)));
            send(connection, MsgType.GAME_SNAPSHOT, snapshot());

            int from = Math.max(0, Math.min(lastPly, ply));
            for (int index = from; index < appliedPayloads.size(); index++) {
                send(connection, MsgType.MOVE_APPLIED, appliedPayloads.get(index));
            }

            if (status == Status.PAUSED && pausedUserId == player.userId()) {
                status = Status.IN_PROGRESS;
                pauseReason = "";
                dbWriter.submitBestEffort("game_status",
                        () -> database.setGameStatus(gameId, "IN_PROGRESS"));
                send(opponentOf(player).connection(), MsgType.PEER_STATUS,
                        Json.of(Map.of("state", "reconnected", "graceMs", 0)));
            }
            System.out.printf("Ban #%d: %s noi lai, phat lai %d nuoc%n",
                    gameId, player.username(), appliedPayloads.size() - from);
        });
        return true;
    }

    // ---------------------------------------------------------------- khan gia

    /** Them khan gia: gui snapshot cho ho va cap nhat so khan gia cho moi nguoi. */
    public void addSpectator(Connection connection) {
        submit(() -> {
            spectators.add(connection);
            connection.spectating().add(gameId);
            send(connection, MsgType.GAME_SNAPSHOT, snapshot());
            broadcastSpectatorCount();
        });
    }

    /** Go khan gia khoi van va cap nhat so khan gia. */
    public void removeSpectator(Connection connection) {
        submit(() -> {
            connection.spectating().remove(gameId);
            if (spectators.remove(connection)) {
                broadcastSpectatorCount();
            }
        });
    }

    /** Gui so khan gia hien tai (2 byte) cho nguoi choi va khan gia. */
    private void broadcastSpectatorCount() {
        byte[] payload = ByteBuffer.allocate(2)
                .putShort((short) Math.min(65_535, spectators.size())).array();
        broadcast(MsgType.SPECTATOR_COUNT, payload);
    }

    // ------------------------------------------------------------ dong ho / tick

    /** Dong ho va thoi gian an han deu do server quet, khong phu thuoc client. */
    public void onTick(long now, long graceMs) {
        submit(() -> {
            if (status == Status.FINISHED) {
                return;
            }
            if (status == Status.PAUSED) {
                if (now - pausedSince > graceMs && pausedUserId != 0) {
                    finish(pausedUserId == white.userId() ? "0-1" : "1-0", "disconnect");
                }
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
                finishByTimeout(whiteToMove ? white : black);
            }
        });
    }

    /** Tam dung van vi loi he thong (vi du rules service chet) va bao loi cho moi nguoi dang xem/choi. */
    private void pause(int code, String message) {
        status = Status.PAUSED;
        pausedSince = System.currentTimeMillis();
        pausedUserId = 0;                    // khong phai loi cua ai ca
        pauseReason = message;
        dbWriter.submitBestEffort("game_status", () -> database.setGameStatus(gameId, "PAUSED"));
        broadcast(MsgType.ERROR, Json.of(Map.of("code", code, "message", message)));
    }

    /**
     * Ban nay dang dung vi RULES SERVICE chet, chu khong phai vi nguoi choi rot mang?
     *
     * Phan biet hai loai PAUSED la can thiet: loai do rules service thi tu chay
     * tiep duoc khi dich vu song lai, con loai do nguoi choi rot mang thi phai
     * cho chinh nguoi do noi lai.
     */
    public boolean pausedByRules() {
        return status == Status.PAUSED && pausedUserId == 0;
    }

    /** Rules service song lai: chay tiep tu dung cho dang dung (kich ban E7). */
    public void resumeAfterRulesRecovered() {
        submit(() -> {
            if (status != Status.PAUSED || pausedUserId != 0) {
                return;
            }
            status = Status.IN_PROGRESS;
            pauseReason = "";
            turnStartedAt = System.currentTimeMillis();
            dbWriter.submitBestEffort("game_status",
                    () -> database.setGameStatus(gameId, "IN_PROGRESS"));
            broadcastSnapshot();
            System.out.printf("Ban #%d: rules service da song lai, van chay tiep%n", gameId);
        });
    }

    // ---------------------------------------------------------------- ket thuc

    /** Ket thuc van: tinh Elo, tao PGN, xep viec ghi database, gui GAME_OVER cho nguoi choi va khan gia, bao GameService don dep. */
    private void finish(String result, String reason) {
        if (status == Status.FINISHED) {
            return;
        }
        status = Status.FINISHED;

        int[] deltas = Elo.deltas(white.elo(), black.elo(), result);
        String pgn = PgnWriter.write(white.username(), black.username(), result, reason,
                timeControl, sanMoves);

        dbWriter.submitCritical("finish_game", gameId + "," + result + "," + reason,
                () -> database.finishGame(gameId, result, reason, pgn));
        dbWriter.submitCritical("elo",
                white.userId() + ":" + (white.elo() + deltas[0]) + ","
                        + black.userId() + ":" + (black.elo() + deltas[1]),
                () -> database.updateElo(white.userId(), white.elo() + deltas[0],
                        black.userId(), black.elo() + deltas[1]));

        sendGameOver(white, result, reason, deltas[0], pgn);
        sendGameOver(black, result, reason, deltas[1], pgn);
        // Khan gia cung phai biet van da xong, neu khong ho ngoi nhin man hinh dung (X57).
        byte[] over = Json.of(Map.of("result", result, "reason", reason, "eloDelta", 0, "pgn", pgn));
        for (Connection spectator : spectators) {
            spectator.offer(FrameCodec.encode(MsgType.GAME_OVER, 0, over));
            spectator.spectating().remove(gameId);
        }
        spectators.clear();

        white.connection().setGameId(0);
        black.connection().setGameId(0);
        service.onGameFinished(this);

        System.out.printf("Ban #%d ket thuc: %s (%s) sau %d nuoc | Elo %+d/%+d%n",
                gameId, result, reason, ply, deltas[0], deltas[1]);
    }

    /** Gui GAME_OVER cho mot nguoi choi kem thay doi Elo cua ho va PGN. */
    private void sendGameOver(Player player, String result, String reason, int eloDelta, String pgn) {
        send(player.connection(), MsgType.GAME_OVER, Json.of(Map.of(
                "result", result, "reason", reason, "eloDelta", eloDelta, "pgn", pgn)));
    }

    // ---------------------------------------------------------------- tro giup

    /** Gui snapshot ban co hien tai cho mot ket noi. */
    public void sendSnapshotTo(Connection connection) {
        submit(() -> send(connection, MsgType.GAME_SNAPSHOT, snapshot()));
    }

    /** Gui snapshot ban co cho ca hai nguoi choi va moi khan gia. */
    private void broadcastSnapshot() {
        byte[] payload = snapshot();
        send(white.connection(), MsgType.GAME_SNAPSHOT, payload);
        send(black.connection(), MsgType.GAME_SNAPSHOT, payload);
        for (Connection spectator : spectators) {
            spectator.offer(FrameCodec.encode(MsgType.GAME_SNAPSHOT, 0, payload));
        }
    }

    /** Dung payload JSON snapshot: FEN, danh sach nuoc, dong ho, luot, trang thai, nguoi choi, so khan gia. */
    private byte[] snapshot() {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("gameId", gameId);
        fields.put("fen", fen);
        fields.put("ply", ply);
        fields.put("moves", sanMoves);
        fields.put("clockW", clockWhiteMs);
        fields.put("clockB", clockBlackMs);
        fields.put("turn", ply % 2 == 0 ? "w" : "b");
        fields.put("status", status.name());
        fields.put("white", white.username());
        fields.put("black", black.username());
        fields.put("timeControl", timeControl);
        fields.put("spectators", spectators.size());
        return Json.of(fields);
    }

    /** Tim nguoi choi ung voi ket noi; khong phai nguoi choi thi tra ve null. */
    private Player playerOf(Connection connection) {
        if (white.connection() == connection) {
            return white;
        }
        return black.connection() == connection ? black : null;
    }

    /** Tim nguoi choi theo userId; khong phai nguoi choi thi tra ve null. */
    private Player playerOf(long userId) {
        if (white.userId() == userId) {
            return white;
        }
        return black.userId() == userId ? black : null;
    }

    /** Tra ve doi thu cua nguoi choi. */
    private Player opponentOf(Player player) {
        return player == white ? black : white;
    }

    /**
     * Gui cho ca hai nguoi choi, roi moi den khan gia.
     *
     * Thu tu nay la co chu dich (X58): nguoi choi duoc phuc vu truoc, va khan
     * gia dung `offer` nen mot khan gia doc cham chi tu bo lo message chu khong
     * lam cham ban co.
     */
    private void broadcast(int type, byte[] payload) {
        send(white.connection(), type, payload);
        send(black.connection(), type, payload);
        if (spectators.isEmpty()) {
            return;
        }
        List<Connection> tooSlow = null;
        for (Connection spectator : spectators) {
            if (!spectator.offer(FrameCodec.encode(type, 0, payload))) {
                if (tooSlow == null) {
                    tooSlow = new ArrayList<>();
                }
                tooSlow.add(spectator);
            }
        }
        if (tooSlow != null) {
            for (Connection slow : tooSlow) {
                spectators.remove(slow);
                slow.spectating().remove(gameId);
            }
            broadcastSpectatorCount();
        }
    }

    /** Gui mot frame cho ket noi; neu hang doi day hoac ket noi da dong thi danh dau dong, khong lam hong ban co. */
    private void send(Connection connection, int type, byte[] payload) {
        try {
            connection.send(FrameCodec.encode(type, 0, payload));
        } catch (RuntimeException overflow) {
            // Client doc qua cham hoac da dong: khong duoc lam hong ban co.
            connection.markClosing();
        }
    }

    /** Gui frame ERROR voi ma loi va thong bao. */
    private void sendError(Connection connection, int code, String message) {
        send(connection, MsgType.ERROR, Json.of(Map.of("code", code, "message", message)));
    }

    /** Ban sao danh sach nuoc di dang SAN. */
    public List<String> sanMoves() {
        return List.copyOf(sanMoves);
    }

    /** So viec bi bo vi hang doi cua ban co bi day. */
    public long droppedFromQueue() {
        return droppedFromQueue;
    }
}
