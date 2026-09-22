package vn.dcgs.server;

import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.MsgType;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Diem vao cua Game Server.
 *
 * Hien tai: doc cau hinh, kiem tra ket noi database va tinh san sang cua
 * codec. Lop mang (Acceptor, Selector, IoWorker, GameActor) la phan tiep theo
 * theo PLAN.md tuan 1-2.
 *
 * Chay:  java -jar dcgs-server.jar [--config duong/dan/config.properties] [--check]
 */
public final class Main {

    public static void main(String[] args) {
        Path configPath = Path.of("config.properties");
        boolean checkOnly = false;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--config" -> configPath = Path.of(args[++i]);
                case "--check" -> checkOnly = true;
                case "--help" -> {
                    System.out.println("""
                            DCGS Game Server
                              --config <file>   duong dan config.properties (mac dinh: ./config.properties)
                              --check           kiem tra cau hinh + database roi thoat
                              --help            in tro giup nay""");
                    return;
                }
                default -> {
                    System.err.println("Tham so khong biet: " + args[i]);
                    System.exit(2);
                }
            }
        }

        Config config = Config.load(configPath);
        System.out.println("=== DCGS Game Server ===");
        System.out.println("Cau hinh (" + configPath.toAbsolutePath() + "):");
        System.out.println(config.describe());

        System.out.print("Codec CGP: ");
        int frameBytes = FrameCodec.encode(MsgType.HEARTBEAT, 1).remaining();
        System.out.println("san sang (HEARTBEAT = " + frameBytes + " byte tren duong day)");

        System.out.print("Database: ");
        try {
            System.out.println(probeDatabase(config));
        } catch (SQLException failure) {
            // Loi DB khong duoc lam sap server (ngoai le X45): bao ro roi di tiep.
            System.out.println("KHONG KET NOI DUOC - " + failure.getMessage());
            if (checkOnly) {
                System.exit(1);
            }
        }

        if (checkOnly) {
            System.out.println("Kiem tra xong.");
            return;
        }

        System.out.println();
        System.out.println("Lop mang chua duoc trien khai - xem PLAN.md tuan 1-2.");
        System.out.println("Cong du kien lang nghe: " + config.getInt("server.port", 5555)
                + " (" + config.get("server.io", "nio") + ")");
    }

    private static String probeDatabase(Config config) throws SQLException {
        String url = config.get("db.url", "jdbc:postgresql://127.0.0.1:5432/dcgs");
        String user = config.get("db.user", "dcgs_app");
        String password = config.get("db.password", "");

        try (Connection connection = DriverManager.getConnection(url, user, password);
             Statement statement = connection.createStatement();
             ResultSet users = statement.executeQuery("SELECT count(*) FROM users")) {
            users.next();
            int userCount = users.getInt(1);
            try (ResultSet games = statement.executeQuery("SELECT count(*) FROM games")) {
                games.next();
                return "OK - " + url + " (" + userCount + " tai khoan, "
                        + games.getInt(1) + " van)";
            }
        }
    }
}
