package vn.dcgs.server;

import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.MsgType;
import vn.dcgs.server.data.Database;
import vn.dcgs.server.game.GameService;
import vn.dcgs.server.net.NioServer;
import vn.dcgs.server.net.RulesClient;

import java.nio.file.Path;

/**
 * Diem vao cua Game Server.
 *
 * Chay:  java -jar dcgs-server.jar [--config duong/dan/config.properties] [--check]
 *
 *   --check  kiem tra cau hinh + database roi thoat (dung trong CI va truoc khi demo)
 */
public final class Main {

    public static void main(String[] args) throws Exception {
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

        System.out.println("Codec CGP: san sang (HEARTBEAT = "
                + FrameCodec.encode(MsgType.HEARTBEAT, 1).remaining() + " byte tren duong day)");

        Database database = new Database(
                config.get("db.url", "jdbc:postgresql://127.0.0.1:5432/dcgs"),
                config.get("db.user", "dcgs_app"),
                config.get("db.password", ""),
                config.getInt("db.poolSize", 8),
                config.getInt("db.connectionTimeoutMs", 2000));

        try {
            System.out.println("Database: OK - " + database.ping());
        } catch (RuntimeException failure) {
            System.out.println("Database: KHONG KET NOI DUOC - " + failure.getMessage());
            database.close();
            System.exit(1);
            return;
        }

        if (checkOnly) {
            System.out.println("Kiem tra xong.");
            database.close();
            return;
        }

        // Van con dang chay trong DB tu lan chay truoc khong the phuc hoi (X49):
        // danh dau ABORTED de du lieu khong noi doi rang chung van dang dien ra.
        int aborted = database.abortDanglingGames();
        if (aborted > 0) {
            System.out.println("Da danh dau ABORTED cho " + aborted + " van con do tu lan chay truoc");
        }
        int expired = database.deleteExpiredSessions();
        if (expired > 0) {
            System.out.println("Da don " + expired + " phien het han");
        }

        String ioMode = config.get("server.io", "nio");
        if (!"nio".equals(ioMode)) {
            System.out.println("Canh bao: che do '" + ioMode
                    + "' chua duoc trien khai (baseline cua thi nghiem E2), dang chay 'nio'");
        }

        RulesClient rules = new RulesClient(config);
        GameService games = new GameService(config, database, rules);
        NioServer server = new NioServer(config, database, games);
        server.start();

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("\nDang tat: " + server.stats());
            System.out.println("  " + games.stats());
            System.out.println("  rules: " + rules.stats());
            server.close();
            games.close();
            rules.close();
            database.close();
        }));

        server.run();
    }
}
