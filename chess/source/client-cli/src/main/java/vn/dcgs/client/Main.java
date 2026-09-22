package vn.dcgs.client;

import com.fasterxml.jackson.databind.JsonNode;
import vn.dcgs.common.Frame;
import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.Json;
import vn.dcgs.common.MoveCodec;
import vn.dcgs.common.MsgType;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.util.List;
import java.util.Map;

/**
 * Client TCP thuan, khong giao dien.
 *
 * Vai tro trong do an:
 *  - Chung minh Game Server noi CGP tren socket that, khong qua WebSocket
 *    gateway va khong qua trinh duyet.
 *  - Dau do cho thi nghiem E8 (so sanh TCP thuan voi WebSocket).
 *  - Cong cu kiem tra nhanh khi server vua thay doi.
 *
 * Chay:
 *   java -jar dcgs-client.jar --host 127.0.0.1 --port 5555 --user alice --pass chess123
 */
public final class Main {

    private static final int CONNECT_TIMEOUT_MS = 5_000;
    private static final int READ_TIMEOUT_MS = 10_000;

    public static void main(String[] args) {
        String host = "127.0.0.1";
        int port = 5555;
        String username = "alice";
        String password = "chess123";
        int heartbeats = 2;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--host" -> host = args[++i];
                case "--port" -> port = Integer.parseInt(args[++i]);
                case "--user" -> username = args[++i];
                case "--pass" -> password = args[++i];
                case "--beats" -> heartbeats = Integer.parseInt(args[++i]);
                case "--help" -> {
                    System.out.println("""
                            DCGS CLI Client
                              --host <ip>     mac dinh 127.0.0.1
                              --port <cong>   mac dinh 5555
                              --user <ten>    mac dinh alice
                              --pass <mk>     mac dinh chess123
                              --beats <so>    so lan heartbeat truoc khi thoat (mac dinh 2)""");
                    return;
                }
                default -> {
                    System.err.println("Tham so khong biet: " + args[i]);
                    System.exit(2);
                }
            }
        }

        System.out.printf("=== DCGS CLI Client -> %s:%d ===%n", host, port);
        int exitCode = 0;

        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            socket.setSoTimeout(READ_TIMEOUT_MS);
            socket.setTcpNoDelay(true);
            System.out.println("Da mo ket noi TCP");

            Session session = new Session(socket);

            // 1. LOGIN
            long loginStart = System.nanoTime();
            session.send(MsgType.LOGIN, Json.of(Map.of("username", username, "password", password)));
            Frame reply = session.receive();
            long loginMs = (System.nanoTime() - loginStart) / 1_000_000;

            if (reply.type() == MsgType.ERROR) {
                JsonNode error = Json.parse(reply.payload());
                System.out.printf("LOGIN that bai: %d %s%n",
                        error.get("code").asInt(), error.get("message").asText());
                System.exit(1);
            }
            if (reply.type() != MsgType.LOGIN_OK) {
                System.out.println("Khong mong doi message: " + MsgType.name(reply.type()));
                System.exit(1);
            }

            JsonNode ok = Json.parse(reply.payload());
            System.out.printf("LOGIN_OK  user=%s  id=%d  elo=%d  (%d ms)%n",
                    ok.get("username").asText(), ok.get("userId").asLong(),
                    ok.get("elo").asInt(), loginMs);
            System.out.println("Session token: " + ok.get("sessionToken").asText());

            // 2. Do RTT bang CLOCK_PING/PONG theo cong thuc NTP (PROTOCOL.md §A5)
            long t1 = System.currentTimeMillis();
            session.send(MsgType.CLOCK_PING, MoveCodec.encodeClockPing(t1));
            Frame pong = session.receive();
            long t4 = System.currentTimeMillis();
            if (pong.type() == MsgType.CLOCK_PONG) {
                MoveCodec.ClockPong times = MoveCodec.decodeClockPong(pong.payload());
                long rtt = (t4 - times.t1()) - (times.t3() - times.t2());
                long offset = ((times.t2() - times.t1()) + (times.t3() - t4)) / 2;
                System.out.printf("CLOCK_PONG  rtt=%d ms  offset=%d ms%n", rtt, offset);
            }

            // 3. Heartbeat
            for (int beat = 1; beat <= heartbeats; beat++) {
                session.send(MsgType.HEARTBEAT, new byte[0]);
                Frame ack = session.receive();
                System.out.printf("HEARTBEAT %d -> %s%n", beat, MsgType.name(ack.type()));
                Thread.sleep(300);
            }

            // 4. Thu mot message chua duoc phuc vu: phai nhan ERROR co ma, khong phai im lang
            session.send(MsgType.QUEUE_JOIN, Json.of(Map.of("timeControl", "300+2")));
            Frame queued = session.receive();
            if (queued.type() == MsgType.ERROR) {
                JsonNode error = Json.parse(queued.payload());
                System.out.printf("QUEUE_JOIN -> ERROR %d: %s%n",
                        error.get("code").asInt(), error.get("message").asText());
            } else {
                System.out.println("QUEUE_JOIN -> " + MsgType.name(queued.type()));
            }

            // 5. LOGOUT
            session.send(MsgType.LOGOUT, new byte[0]);
            System.out.println("Da gui LOGOUT, dong ket noi");
            System.out.printf("Tong: gui %d byte, nhan %d byte%n", session.bytesOut, session.bytesIn);
        } catch (IOException failure) {
            System.err.println("Loi mang: " + failure.getMessage());
            exitCode = 1;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            exitCode = 1;
        }

        System.exit(exitCode);
    }

    /** Mot phien CGP tren socket chan, du cho client dong lenh. */
    private static final class Session {

        private final InputStream in;
        private final OutputStream out;
        private final FrameCodec.Decoder decoder = new FrameCodec.Decoder();
        private final byte[] buffer = new byte[8192];
        private final java.util.ArrayDeque<Frame> ready = new java.util.ArrayDeque<>();
        private int seq = 1;
        long bytesIn;
        long bytesOut;

        Session(Socket socket) throws IOException {
            this.in = socket.getInputStream();
            this.out = socket.getOutputStream();
        }

        void send(int type, byte[] payload) throws IOException {
            ByteBuffer frame = FrameCodec.encode(type, seq++, payload);
            byte[] bytes = new byte[frame.remaining()];
            frame.get(bytes);
            out.write(bytes);
            out.flush();
            bytesOut += bytes.length;
        }

        /**
         * Doc toi khi co mot frame ma ben goi quan tam.
         *
         * Server co the chen HEARTBEAT bat cu luc nao (protocol v1.1) de tu do
         * RTT, nen khong duoc gia dinh "gui gi thi nhan ngay cai do" — phai tra
         * loi roi doc tiep.
         */
        Frame receive() throws IOException {
            while (ready.isEmpty()) {
                int count = in.read(buffer);
                if (count < 0) {
                    throw new IOException("server dong ket noi");
                }
                bytesIn += count;
                for (Frame frame : decoder.feed(buffer, 0, count)) {
                    if (frame.type() == MsgType.HEARTBEAT) {
                        send(MsgType.HEARTBEAT_ACK, new byte[0]);
                    } else {
                        ready.addLast(frame);
                    }
                }
            }
            return ready.pollFirst();
        }
    }
}
