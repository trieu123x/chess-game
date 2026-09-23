package vn.dcgs.server.data;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Hang doi ghi PostgreSQL.
 *
 * Ly do ton tai la ngoai le X51, loi de mac nhat va kho thay nhat trong ca he
 * thong: goi JDBC ngay tren thread cua {@link vn.dcgs.server.game.GameActor}.
 * Mot cau INSERT cham 50 ms se chan bang do ca ban co, va khi pool JDBC can
 * (X47) thi toan bo thread game dung cho - 400 ban co dung vi mot cau lenh.
 *
 * Vi vay GameActor KHONG duoc phep goi {@link Database} truc tiep. No xep viec
 * vao day roi di tiep; hai thread ghi o duoi lo phan con lai.
 *
 * Khi hang doi day (X45 - vi du PostgreSQL chet giua luc 100 van dang chay):
 *   - viec KHONG duoc mat (nuoc di, ket qua van, Elo) -> ghi ra `pending-moves.log`
 *     de con doi chieu lai sau; van van tiep tuc chay tren RAM
 *   - viec co the mat (nhat ky nuoc bi tu choi, doi trang thai) -> bo va dem
 *
 * Nguyen tac: **drop metric truoc, khong bao gio drop nuoc di**.
 */
public final class DbWriter implements AutoCloseable {

    private record Task(String label, Runnable work, String fallback, boolean droppable) {
    }

    private final BlockingQueue<Task> queue;
    private final Thread[] workers;
    private final Path fallbackFile;

    private final AtomicLong done = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong();
    private final AtomicLong spilled = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private volatile boolean running = true;

    /** Tao hang doi ghi voi suc chua `queueMax` va khoi dong `threads` thread nen de ghi xuong database. */
    public DbWriter(int queueMax, int threads, Path fallbackFile) {
        this.queue = new ArrayBlockingQueue<>(Math.max(16, queueMax));
        this.fallbackFile = fallbackFile;
        this.workers = new Thread[Math.max(1, threads)];
        for (int i = 0; i < workers.length; i++) {
            workers[i] = new Thread(this::drain, "db-writer-" + i);
            workers[i].setDaemon(true);
            workers[i].start();
        }
    }

    /**
     * Viec khong duoc mat.
     *
     * @param fallback mot dong text du de dung lai ban ghi neu phai ghi ra file
     */
    public void submitCritical(String label, String fallback, Runnable work) {
        if (!queue.offer(new Task(label, work, fallback, false))) {
            spill(label, fallback, "hang doi day");
        }
    }

    /** Viec bo di duoc khi qua tai: nhat ky, cap nhat trang thai trung gian. */
    public void submitBestEffort(String label, Runnable work) {
        if (!queue.offer(new Task(label, work, null, true))) {
            dropped.incrementAndGet();
        }
    }

    /** Vong lap cua thread ghi: lay tung viec trong hang doi ra chay; viec quan trong bi loi thi ghi ra file du phong. */
    private void drain() {
        while (running || !queue.isEmpty()) {
            Task task;
            try {
                task = queue.poll(200, TimeUnit.MILLISECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
            if (task == null) {
                continue;
            }
            try {
                task.work().run();
                done.incrementAndGet();
            } catch (RuntimeException failure) {
                failed.incrementAndGet();
                if (task.droppable()) {
                    // Nhat ky mat mot dong khong lam sai ket qua van dau.
                    continue;
                }
                spill(task.label(), task.fallback(), failure.getMessage());
            }
        }
    }

    /** Ghi tam ra file de khong mat du lieu khi database khong ghi duoc (X45). */
    private void spill(String label, String fallback, String reason) {
        spilled.incrementAndGet();
        String line = Instant.now() + "\t" + label + "\t" + reason + "\t"
                + (fallback == null ? "" : fallback) + System.lineSeparator();
        try {
            Files.writeString(fallbackFile, line, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException cannotWrite) {
            // Het duong: it nhat phai hien ra console, khong duoc im lang.
            System.err.println("Khong ghi duoc " + fallbackFile + ": " + cannotWrite.getMessage());
            System.err.println("  ban ghi bi mat: " + line.trim());
        }
    }

    /** So viec dang cho trong hang doi. */
    public int pending() {
        return queue.size();
    }

    /** Tra ve chuoi thong ke: so viec da ghi, dang cho, bi bo, ghi ra file, loi. */
    public String stats() {
        return String.format("da ghi %d, dang cho %d, bo qua %d, ghi ra file %d, loi %d",
                done.get(), queue.size(), dropped.get(), spilled.get(), failed.get());
    }

    /** Dung nhan viec moi va cho cac thread ghi xu ly not hang doi (toi da 3 giay moi thread). */
    @Override
    public void close() {
        running = false;
        // Cho cac worker ghi not: mat nuoc di luc tat may van la mat nuoc di.
        for (Thread worker : workers) {
            try {
                worker.join(3_000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }
}
