package vn.dcgs.server.data;

import vn.dcgs.common.CgpException;
import vn.dcgs.common.ErrorCode;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Truy cap PostgreSQL: pool ket noi nho + cac cau lenh cua he thong.
 *
 * Pool tu viet thay vi dung HikariCP: mon hoc quan tam den JDBC va den viec
 * quan ly tai nguyen, va o quy mo nay mot hang doi chan la du. Khi can mot
 * ket noi ma pool rong qua `timeoutMs`, ta tra ve loi 4002 chu KHONG cho vo
 * han — cho vo han se keo tut ca luong game theo (ngoai le X47).
 *
 * Moi loi SQL deu duoc doi thanh CgpException mang ma 4002, de lop mang chi
 * phai biet mot loai ngoai le duy nhat.
 */
public final class Database implements AutoCloseable {

    private final Deque<Connection> pool = new ArrayDeque<>();
    private final String url;
    private final String user;
    private final String password;
    private final int size;
    private final long timeoutMs;
    private int created;
    private volatile boolean closed;

    /** Luu thong tin ket noi JDBC va cau hinh pool; ket noi chi duoc mo khi can (lazy). */
    public Database(String url, String user, String password, int size, long timeoutMs) {
        this.url = url;
        this.user = user;
        this.password = password;
        this.size = Math.max(1, size);
        this.timeoutMs = timeoutMs;
    }

    // ---------------------------------------------------------------- pool

    /** Muon mot ket noi tu pool: lay ket noi ranh, chua du so luong thi mo moi, het thi cho toi da timeoutMs roi bao loi 4002. */
    private Connection borrow() {
        synchronized (pool) {
            long deadline = System.currentTimeMillis() + timeoutMs;
            for (;;) {
                if (closed) {
                    throw new CgpException(ErrorCode.DATABASE_ERROR, "pool da dong");
                }
                Connection connection = pool.pollFirst();
                if (connection != null) {
                    return connection;
                }
                if (created < size) {
                    created++;
                    try {
                        return DriverManager.getConnection(url, user, password);
                    } catch (SQLException failure) {
                        created--;
                        throw new CgpException(ErrorCode.DATABASE_ERROR, failure.getMessage());
                    }
                }
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) {
                    throw new CgpException(ErrorCode.DATABASE_ERROR, "het ket noi trong pool");
                }
                try {
                    pool.wait(remaining);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new CgpException(ErrorCode.DATABASE_ERROR, "bi ngat khi cho ket noi");
                }
            }
        }
    }

    /** Tra ket noi ve pool va danh thuc mot thread dang cho. */
    private void release(Connection connection) {
        synchronized (pool) {
            pool.addLast(connection);
            pool.notify();
        }
    }

    private interface Work<T> {
        /** Cong viec chay tren mot ket noi JDBC, duoc phep nem SQLException. */
        T run(Connection connection) throws SQLException;
    }

    /** Muon ket noi, chay cong viec roi tra ket noi ve pool; doi SQLException thanh CgpException 4002. */
    private <T> T withConnection(Work<T> work) {
        Connection connection = borrow();
        try {
            return work.run(connection);
        } catch (SQLException failure) {
            throw new CgpException(ErrorCode.DATABASE_ERROR, failure.getMessage());
        } finally {
            release(connection);
        }
    }

    /** Kiem tra ket noi khi khoi dong: that bai thi bao ngay chu khong cho toi luc co client. */
    public String ping() {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM games)");
                 ResultSet rows = statement.executeQuery()) {
                rows.next();
                return rows.getLong(1) + " tai khoan, " + rows.getLong(2) + " van";
            }
        });
    }

    // ---------------------------------------------------------------- users

    public record UserRow(long id, String username, String passwordHash, int elo) {
    }

    /** Tim nguoi dung theo ten dang nhap. */
    public Optional<UserRow> findUser(String username) {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT id, username, password_hash, elo FROM users WHERE username = ?")) {
                statement.setString(1, username);
                try (ResultSet rows = statement.executeQuery()) {
                    if (!rows.next()) {
                        return Optional.empty();
                    }
                    return Optional.of(new UserRow(
                            rows.getLong("id"), rows.getString("username"),
                            rows.getString("password_hash"), rows.getInt("elo")));
                }
            }
        });
    }

    /** Tim nguoi dung theo id. */
    public Optional<UserRow> findUserById(long userId) {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT id, username, password_hash, elo FROM users WHERE id = ?")) {
                statement.setLong(1, userId);
                try (ResultSet rows = statement.executeQuery()) {
                    if (!rows.next()) {
                        return Optional.empty();
                    }
                    return Optional.of(new UserRow(
                            rows.getLong("id"), rows.getString("username"),
                            rows.getString("password_hash"), rows.getInt("elo")));
                }
            }
        });
    }

    /** Tao tai khoan moi va tra ve id; ten da ton tai thi nem loi 1004. */
    public long createUser(String username, String passwordHash) {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "INSERT INTO users (username, password_hash) VALUES (?, ?) "
                            + "ON CONFLICT (username) DO NOTHING RETURNING id")) {
                statement.setString(1, username);
                statement.setString(2, passwordHash);
                try (ResultSet rows = statement.executeQuery()) {
                    if (!rows.next()) {
                        throw new CgpException(ErrorCode.USERNAME_TAKEN, username);
                    }
                    return rows.getLong(1);
                }
            }
        });
    }

    /** Cap nhat Elo cho ca hai nguoi choi trong mot giao dich, theo thu tu id tang dan (X48). */
    public void updateElo(long firstId, int firstElo, long secondId, int secondElo) {
        withConnection(connection -> {
            boolean autoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            try (PreparedStatement statement = connection.prepareStatement(
                    "UPDATE users SET elo = ? WHERE id = ?")) {
                long lowId = Math.min(firstId, secondId);
                long highId = Math.max(firstId, secondId);
                int lowElo = lowId == firstId ? firstElo : secondElo;
                int highElo = highId == firstId ? firstElo : secondElo;

                statement.setInt(1, lowElo);
                statement.setLong(2, lowId);
                statement.addBatch();
                statement.setInt(1, highElo);
                statement.setLong(2, highId);
                statement.addBatch();
                statement.executeBatch();
                connection.commit();
            } catch (SQLException failure) {
                connection.rollback();
                throw failure;
            } finally {
                connection.setAutoCommit(autoCommit);
            }
            return null;
        });
    }

    // ------------------------------------------------------------- sessions

    public record SessionRow(UUID token, long userId, Long gameId, long expiresAtMs) {
        /** Phien da qua thoi diem het han chua. */
        public boolean expired() {
            return System.currentTimeMillis() > expiresAtMs;
        }
    }

    /** Tao phien dang nhap moi voi token ngau nhien va thoi han ttlMs, tra ve token. */
    public UUID createSession(long userId, long ttlMs) {
        UUID token = UUID.randomUUID();
        withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")) {
                statement.setObject(1, token);
                statement.setLong(2, userId);
                statement.setTimestamp(3, new Timestamp(System.currentTimeMillis() + ttlMs));
                statement.executeUpdate();
            }
            return null;
        });
        return token;
    }

    /** Tim phien theo token. */
    public Optional<SessionRow> findSession(UUID token) {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT token, user_id, game_id, expires_at FROM sessions WHERE token = ?")) {
                statement.setObject(1, token);
                try (ResultSet rows = statement.executeQuery()) {
                    if (!rows.next()) {
                        return Optional.empty();
                    }
                    long gameId = rows.getLong("game_id");
                    return Optional.of(new SessionRow(
                            (UUID) rows.getObject("token"),
                            rows.getLong("user_id"),
                            rows.wasNull() ? null : gameId,
                            rows.getTimestamp("expires_at").getTime()));
                }
            }
        });
    }

    /** Gia han phien: goi khi con van dang danh de phien khong het han giua chung (X12). */
    public void extendSession(UUID token, long ttlMs) {
        withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "UPDATE sessions SET expires_at = ? WHERE token = ?")) {
                statement.setTimestamp(1, new Timestamp(System.currentTimeMillis() + ttlMs));
                statement.setObject(2, token);
                statement.executeUpdate();
            }
            return null;
        });
    }

    /** Xoa phien theo token (dang xuat hoac phien het han). */
    public void deleteSession(UUID token) {
        withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "DELETE FROM sessions WHERE token = ?")) {
                statement.setObject(1, token);
                statement.executeUpdate();
            }
            return null;
        });
    }

    /** Xoa moi phien da het han, tra ve so phien bi xoa. */
    public int deleteExpiredSessions() {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "DELETE FROM sessions WHERE expires_at < now()")) {
                return statement.executeUpdate();
            }
        });
    }

    // ---------------------------------------------------------------- games

    /** Tao ban ghi van moi o trang thai IN_PROGRESS va tra ve id van. */
    public long createGame(long whiteId, long blackId, String timeControl) {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "INSERT INTO games (white_id, black_id, time_control, status, started_at) "
                            + "VALUES (?, ?, ?, 'IN_PROGRESS', now()) RETURNING id")) {
                statement.setLong(1, whiteId);
                statement.setLong(2, blackId);
                statement.setString(3, timeControl);
                try (ResultSet rows = statement.executeQuery()) {
                    rows.next();
                    return rows.getLong(1);
                }
            }
        });
    }

    /** Cap nhat trang thai cua van (vi du PAUSED, IN_PROGRESS). */
    public void setGameStatus(long gameId, String status) {
        withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "UPDATE games SET status = ? WHERE id = ?")) {
                statement.setString(1, status);
                statement.setLong(2, gameId);
                statement.executeUpdate();
            }
            return null;
        });
    }

    /** Danh dau van da ket thuc, luu ket qua, ly do, PGN va thoi diem ket thuc. */
    public void finishGame(long gameId, String result, String reason, String pgn) {
        withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "UPDATE games SET status = 'FINISHED', result = ?, reason = ?, pgn = ?, "
                            + "ended_at = now() WHERE id = ?")) {
                statement.setString(1, result);
                statement.setString(2, reason);
                if (pgn == null) {
                    statement.setNull(3, Types.VARCHAR);
                } else {
                    statement.setString(3, pgn);
                }
                statement.setLong(4, gameId);
                statement.executeUpdate();
            }
            return null;
        });
    }

    /** Khi khoi dong lai: van con dang chay trong DB khong the phuc hoi (X49). */
    public int abortDanglingGames() {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "UPDATE games SET status = 'ABORTED', reason = 'server_restart', ended_at = now() "
                            + "WHERE status IN ('IN_PROGRESS', 'PAUSED', 'WAITING')")) {
                return statement.executeUpdate();
            }
        });
    }

    // ---------------------------------------------------------------- moves

    /**
     * Ghi mot nuoc di. Khoa chinh la (game_id, ply) nen ghi lai lan nua khong
     * tao ban ghi trung - can cho co che retry (X46).
     */
    public void appendMove(long gameId, int ply, String uci, String san, String fenAfter,
                           int clockWhiteMs, int clockBlackMs, long serverTs) {
        withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "INSERT INTO moves (game_id, ply, uci, san, fen_after, clock_w_ms, clock_b_ms, server_ts) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (game_id, ply) DO NOTHING")) {
                statement.setLong(1, gameId);
                statement.setInt(2, ply);
                statement.setString(3, uci);
                statement.setString(4, san);
                statement.setString(5, fenAfter);
                statement.setInt(6, clockWhiteMs);
                statement.setInt(7, clockBlackMs);
                statement.setLong(8, serverTs);
                statement.executeUpdate();
            }
            return null;
        });
    }

    /** Nhat ky request bi tu choi - du lieu tho cho thi nghiem E6. */
    public void logRejected(Long gameId, Long userId, int errorCode, String detail) {
        withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "INSERT INTO rejected_moves (game_id, user_id, error_code, detail) VALUES (?, ?, ?, ?)")) {
                if (gameId == null) {
                    statement.setNull(1, Types.BIGINT);
                } else {
                    statement.setLong(1, gameId);
                }
                if (userId == null) {
                    statement.setNull(2, Types.BIGINT);
                } else {
                    statement.setLong(2, userId);
                }
                statement.setInt(3, errorCode);
                statement.setString(4, detail);
                statement.executeUpdate();
            }
            return null;
        });
    }

    // --------------------------------------------------------- bang xep hang

    public record LeaderRow(String username, int elo, int played, int won) {
    }

    /**
     * Bang xep hang theo Elo.
     *
     * Chi tinh nhung tai khoan da danh it nhat mot van da ket thuc: neu khong,
     * 400 tai khoan bot moi tao deu 1200 diem se chiem het bang.
     */
    public List<LeaderRow> leaderboard(int limit) {
        return withConnection(connection -> {
            String sql = """
                    SELECT u.username, u.elo,
                           count(g.id) AS played,
                           count(*) FILTER (WHERE (g.white_id = u.id AND g.result = '1-0')
                                              OR (g.black_id = u.id AND g.result = '0-1')) AS won
                    FROM users u
                    JOIN games g ON (g.white_id = u.id OR g.black_id = u.id) AND g.status = 'FINISHED'
                    GROUP BY u.id, u.username, u.elo
                    ORDER BY u.elo DESC, played DESC
                    LIMIT ?""";
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                statement.setInt(1, limit);
                try (ResultSet rows = statement.executeQuery()) {
                    List<LeaderRow> board = new ArrayList<>();
                    while (rows.next()) {
                        board.add(new LeaderRow(rows.getString("username"), rows.getInt("elo"),
                                rows.getInt("played"), rows.getInt("won")));
                    }
                    return board;
                }
            }
        });
    }

    // ------------------------------------------------------- xem lai van cu

    public record GameRow(long id, String white, String black, String timeControl,
                          String status, String result, String reason, String pgn) {
    }

    private static final String GAME_SELECT = """
            SELECT g.id, w.username AS white, b.username AS black, g.time_control,
                   g.status, g.result, g.reason, g.pgn
            FROM games g JOIN users w ON w.id = g.white_id JOIN users b ON b.id = g.black_id
            """;

    /** Doc mot dong ket qua truy van thanh GameRow. */
    private static GameRow readGame(ResultSet rows) throws SQLException {
        return new GameRow(rows.getLong("id"), rows.getString("white"), rows.getString("black"),
                rows.getString("time_control"), rows.getString("status"),
                rows.getString("result"), rows.getString("reason"), rows.getString("pgn"));
    }

    /** Tim van theo id, kem ten hai nguoi choi. */
    public Optional<GameRow> findGame(long gameId) {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(GAME_SELECT + " WHERE g.id = ?")) {
                statement.setLong(1, gameId);
                try (ResultSet rows = statement.executeQuery()) {
                    return rows.next() ? Optional.of(readGame(rows)) : Optional.empty();
                }
            }
        });
    }

    /** Van vua ket thuc cua mot nguoi choi - de tra loi RESUME sau khi van da xong (X13). */
    public Optional<GameRow> findLastFinishedGame(long userId) {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(GAME_SELECT
                    + " WHERE (g.white_id = ? OR g.black_id = ?) AND g.status = 'FINISHED'"
                    + " ORDER BY g.ended_at DESC LIMIT 1")) {
                statement.setLong(1, userId);
                statement.setLong(2, userId);
                try (ResultSet rows = statement.executeQuery()) {
                    return rows.next() ? Optional.of(readGame(rows)) : Optional.empty();
                }
            }
        });
    }

    public record MoveRow(int ply, String uci, String san, String fenAfter,
                          int clockWhiteMs, int clockBlackMs) {
    }

    /** Nuoc di cua mot van, theo thu tu - nguon de phat lai va de xem lai. */
    public List<MoveRow> movesOf(long gameId) {
        return withConnection(connection -> {
            try (PreparedStatement statement = connection.prepareStatement(
                    "SELECT ply, uci, san, fen_after, clock_w_ms, clock_b_ms "
                            + "FROM moves WHERE game_id = ? ORDER BY ply")) {
                statement.setLong(1, gameId);
                try (ResultSet rows = statement.executeQuery()) {
                    List<MoveRow> moves = new ArrayList<>();
                    while (rows.next()) {
                        moves.add(new MoveRow(rows.getInt("ply"), rows.getString("uci"),
                                rows.getString("san"), rows.getString("fen_after"),
                                rows.getInt("clock_w_ms"), rows.getInt("clock_b_ms")));
                    }
                    return moves;
                }
            }
        });
    }

    /** Dong pool: dong moi ket noi ranh va danh thuc cac thread dang cho de chung bao loi. */
    @Override
    public void close() {
        synchronized (pool) {
            closed = true;
            for (Connection connection : pool) {
                try {
                    connection.close();
                } catch (SQLException ignored) {
                    // Dang tat may, khong con gi de lam voi loi nay.
                }
            }
            pool.clear();
            pool.notifyAll();
        }
    }
}
