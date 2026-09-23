package vn.dcgs.server;

import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.MsgType;
import vn.dcgs.server.data.Database;
import vn.dcgs.server.data.DbWriter;
import vn.dcgs.server.game.EmbeddedRules;
import vn.dcgs.server.game.GameService;
import vn.dcgs.server.net.BlockingServer;
import vn.dcgs.server.net.CgpServer;
import vn.dcgs.server.net.NioServer;
import vn.dcgs.server.net.RulesClient;
import vn.dcgs.server.net.RulesEngine;
import vn.dcgs.server.net.ServerCore;

import java.lang.management.ManagementFactory;
import java.nio.file.Path;

/**
 * Diem vao cua Game Server.
 *
 * Chay:  java -jar dcgs-server.jar [--config duong/dan/config.properties] [--check]
 *
 *   --check  kiem tra cau hinh + database roi thoat (dung trong CI va truoc khi demo)
 *
 * Moi kich ban thuc nghiem duoc chon o day bang cau hinh chu khong bang mot
 * nhanh code rieng: `server.io` chon lop mang (E2), `server.format` chon cach
 * ma hoa (E3), `clock.compensation` bat/tat bu RTT (E4), `rules.mode` chon ben
 * phan xu luat (E7).
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

        DbWriter dbWriter = new DbWriter(
                config.getInt("db.queueMax", 10_000),
                config.getInt("db.writerThreads", 2),
                Path.of(config.get("db.pendingFile", "pending-moves.log")));

        RulesEngine rules = createRules(config);
        GameService games = new GameService(config, database, dbWriter, rules);
        ServerCore core = new ServerCore(config, database, games);
        CgpServer server = createServer(config, core);
        server.start();

        startStatsLogger(config, server, games, dbWriter);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("\nDang tat: " + server.stats());
            System.out.println("  " + games.stats());
            System.out.println("  rules: " + rules.stats());
            server.close();
            games.close();
            // Thu tu quan trong: dong hang doi ghi TRUOC khi dong database, neu
            // khong thi nhung nuoc di con trong hang doi se khong ghi duoc.
            dbWriter.close();
            System.out.println("  db: " + dbWriter.stats());
            rules.close();
            database.close();
        }));

        server.run();
    }

    /**
     * In mot dong so lieu van hanh theo chu ky.
     *
     * Ba con so nay deu la du lieu do cua thi nghiem, khong phai log cho vui:
     *
     *   threads  - E2 so sanh nio voi blocking chinh bang con so nay. Che do
     *              blocking ton ~2 thread moi ket noi nen no tang tuyen tinh,
     *              con nio thi gan nhu khong doi.
     *   heapMB   - E1 theo doi RAM, va ca T19 (chay 60 phut xem co ro bo nho
     *              khong). Ro bo nho se hien ra thanh duong di len khong quay lai.
     *   dbQueue  - hang doi ghi database (X45): day len nghia la DB dang la
     *              nut that, day la bang chung de tra loi cau hoi "bottleneck
     *              nam o dau?" trong phan Discussion.
     *
     * In ra stdout de cong cu do doc duoc ma khong can JMX hay `jcmd` - khong
     * phai may nao cung co JDK day du tren PATH.
     */
    private static void startStatsLogger(Config config, CgpServer server,
                                         GameService games, DbWriter dbWriter) {
        long intervalMs = config.getInt("server.statsIntervalMs", 10_000);
        if (intervalMs <= 0) {
            return;
        }
        Thread reporter = new Thread(() -> {
            Runtime runtime = Runtime.getRuntime();
            while (true) {
                try {
                    Thread.sleep(intervalMs);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
                long usedMb = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024);
                System.out.printf("[stats] threads=%d heapMB=%d games=%d dbQueue=%d | %s%n",
                        ManagementFactory.getThreadMXBean().getThreadCount(), usedMb, games.liveGameCount(),
                        dbWriter.pending(), server.stats());
                // Bat buoc phai flush.
                //
                // Khi stdout bi chuyen huong vao pipe (dung la cach cong cu do
                // chay server), JVM dem theo khoi 8 KiB chu khong theo dong. Bai
                // do ngan se ket thuc truoc khi day duoc khoi do, va cong cu doc
                // se khong thay dong nao - roi ket luan nham rang server khong
                // co ban nao dang chay. Loi nay da lam cot thread/heap cua E2 o
                // muc 10 ban bo trong, va lam bai T20 bao sai.
                System.out.flush();
            }
        }, "stats-reporter");
        reporter.setDaemon(true);
        reporter.start();
    }

    /** `server.io` quyet dinh lop mang - doi tuong duoc do o thi nghiem E2. */
    private static CgpServer createServer(Config config, ServerCore core) {
        String mode = config.get("server.io", "nio");
        return switch (mode) {
            case "nio" -> new NioServer(config, core);
            case "blocking" -> new BlockingServer(config, core);
            default -> throw new IllegalArgumentException(
                    "server.io phai la 'nio' hoac 'blocking', nhan: " + mode);
        };
    }

    /** `rules.mode` quyet dinh ben phan xu luat - doi tuong duoc do o thi nghiem E7. */
    private static RulesEngine createRules(Config config) {
        String mode = config.get("rules.mode", "remote");
        return switch (mode) {
            case "remote" -> new RulesClient(config);
            case "embedded" -> {
                System.out.println("Rules: che do EMBEDDED - bang luat trong Java, "
                        + "chi dung lam doi chung cho E7");
                yield new EmbeddedRules();
            }
            default -> throw new IllegalArgumentException(
                    "rules.mode phai la 'remote' hoac 'embedded', nhan: " + mode);
        };
    }
}
