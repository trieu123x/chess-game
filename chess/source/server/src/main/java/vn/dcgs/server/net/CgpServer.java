package vn.dcgs.server.net;

import java.io.IOException;

/**
 * Mot ban hien thuc lop mang. Co dung hai ban, va viec chon ban nao la mot
 * dong trong `config.properties` (`server.io`) chu khong phai mot lan sua code:
 *
 *   nio       {@link NioServer}      - 1 selector cho moi ket noi (de xuat, N4)
 *   blocking  {@link BlockingServer} - 2 thread cho moi ket noi   (baseline E2)
 *
 * Ca hai dung chung {@link ServerCore}, nen thi nghiem E2 do dung cai can do:
 * mo hinh I/O, khong phai hai ban server viet khac nhau.
 */
public interface CgpServer extends AutoCloseable {

    void start() throws IOException;

    /** Vong lap chinh - chay tren thread goi, tra ve khi server dong. */
    void run();

    String stats();

    @Override
    void close();
}
