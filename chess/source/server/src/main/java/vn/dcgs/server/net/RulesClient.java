package vn.dcgs.server.net;

import com.fasterxml.jackson.databind.JsonNode;
import vn.dcgs.common.CgpException;
import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.Frame;
import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.Json;
import vn.dcgs.common.MsgType;
import vn.dcgs.server.Config;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Client goi Rules Service qua RVP.
 *
 * Ba co che deu nham vao mot con so duy nhat se do o thi nghiem E7: do tre
 * them vao moi nuoc di vi da tach luat co sang mot tien trinh khac.
 *
 *  1. Pool ket noi persistent  - khong bat tay TCP lai cho tung nuoc di.
 *  2. Cache theo FEN + nuoc di - khai cuoc lap lai rat nhieu giua cac van.
 *  3. Circuit breaker           - instance chet thi ngung goi thay vi cho
 *                                 timeout tung request mot (X39, X44).
 *
 * Moi request chiem mot ket noi trong suot thoi gian cho. Cach nay don gian
 * va du nhanh o quy mo do an (chess.js tra loi trong vai ms); neu E7 cho thay
 * day la nut that thi buoc tiep theo la pipelining nhieu request tren mot
 * ket noi theo `SEQ`, dung nhu PROTOCOL.md §B da chua san cho.
 */
public final class RulesClient implements RulesEngine {


    private final List<Endpoint> endpoints = new ArrayList<>();
    private final int timeoutMs;
    private final int retries;
    private final boolean cacheEnabled;
    private final Map<String, Verdict> cache;
    private final AtomicLong hits = new AtomicLong();
    private final AtomicLong misses = new AtomicLong();
    private final AtomicLong failures = new AtomicLong();

    /** Doc cau hinh (timeout, retry, cache, circuit breaker), tao cache LRU va danh sach endpoint rules service. */
    public RulesClient(Config config) {
        this.timeoutMs = config.getInt("rules.timeoutMs", 200);
        this.retries = config.getInt("rules.retries", 2);
        this.cacheEnabled = config.getBoolean("rules.cache", true);
        int cacheSize = config.getInt("rules.cacheSize", 50_000);

        // LRU don gian: LinkedHashMap theo thu tu truy cap, bo phan tu cu nhat.
        this.cache = java.util.Collections.synchronizedMap(
                new LinkedHashMap<>(1024, 0.75f, true) {
                    /** Bo phan tu it dung nhat khi cache vuot kich thuoc toi da. */
                    @Override
                    protected boolean removeEldestEntry(Map.Entry<String, Verdict> eldest) {
                        return size() > cacheSize;
                    }
                });

        int poolPerEndpoint = config.getInt("rules.poolPerEndpoint", 4);
        int breakerFailures = config.getInt("rules.breaker.failures", 5);
        long breakerOpenMs = config.getInt("rules.breaker.openMs", 15_000);
        for (Config.Endpoint endpoint : config.getEndpoints("rules.endpoints", "127.0.0.1:6001")) {
            endpoints.add(new Endpoint(endpoint.host(), endpoint.port(), poolPerEndpoint,
                    breakerFailures, breakerOpenMs));
        }
    }

    /**
     * Kiem tra mot nuoc di.
     *
     * @throws CgpException 4001 khi khong con instance nao phuc vu duoc - ban
     *         co se chuyen PAUSED chu khong mat (X44).
     */
    @Override
    public Verdict validate(String fen, String from, String to, String promotion) {
        // Khoa cache la FEN DAY DU (gom quyen nhap thanh, o bat tot qua duong,
        // halfmove) cong nuoc di. Rut gon FEN de tiet kiem bo nho se tra ve ket
        // qua sai cho dung nhung the co trong giong nhau ma khac quyen (X42).
        String key = fen + '|' + from + to + promotion;
        if (cacheEnabled) {
            Verdict cached = cache.get(key);
            if (cached != null) {
                hits.incrementAndGet();
                return cached;
            }
        }
        misses.incrementAndGet();

        byte[] payload = Json.of(Map.of("fen", fen, "from", from, "to", to, "promo", promotion));
        Frame reply = call(MsgType.RULES_VALIDATE, payload);
        Verdict verdict = switch (reply.type()) {
            case MsgType.RULES_OK -> {
                JsonNode node = Json.parse(reply.payload());
                yield new Verdict(true,
                        node.get("fenAfter").asText(),
                        node.get("san").asText(),
                        node.get("uci").asText(),
                        node.get("flags").asInt(),
                        node.get("status").asText(),
                        0, null);
            }
            case MsgType.RULES_ILLEGAL -> {
                JsonNode node = Json.parse(reply.payload());
                yield Verdict.illegal(node.path("code").asInt(ErrorCode.ILLEGAL_MOVE),
                        node.path("reason").asText("nuoc di khong hop le"));
            }
            default -> {
                JsonNode node = Json.parse(reply.payload());
                throw new CgpException(ErrorCode.RULES_UNAVAILABLE,
                        "rules service bao loi: " + node.path("message").asText());
            }
        };

        // Chi cache ket qua hop le: mot nuoc sai co the do client gian lan, khong
        // dang chiem cho, va phan phoi cua chung khong lap lai nhu khai cuoc.
        if (cacheEnabled && verdict.legal()) {
            cache.put(key, verdict);
        }
        return verdict;
    }

    /**
     * Het gio: ben con lai co du quan de chieu het khong? (X29)
     *
     * Khong dung cache: cau hoi nay chi phat sinh mot lan moi van, cache chi
     * lam ban bo nho.
     */
    @Override
    public boolean insufficientMaterialFor(String fen, String side) {
        Frame reply = call(MsgType.RULES_MATERIAL, Json.of(Map.of("fen", fen, "side", side)));
        if (reply.type() != MsgType.RULES_OK) {
            throw new CgpException(ErrorCode.RULES_UNAVAILABLE, "khong hoi duoc tinh trang quan");
        }
        return !Json.parse(reply.payload()).path("sufficient").asBoolean(true);
    }

    /** Con it nhat mot instance khong bi mo mach - dung de hoi lai van dang PAUSED. */
    @Override
    public boolean available() {
        for (Endpoint endpoint : endpoints) {
            if (endpoint.available()) {
                return true;
            }
        }
        return false;
    }

    /** Hoi rules service danh sach moi nuoc di hop le (dang UCI) cua the co FEN. */
    public List<String> legalMoves(String fen) {
        Frame reply = call(MsgType.RULES_LEGAL_MOVES, Json.of(Map.of("fen", fen)));
        List<String> moves = new ArrayList<>();
        for (JsonNode move : Json.parse(reply.payload()).get("moves")) {
            moves.add(move.asText());
        }
        return moves;
    }

    /** Gui mot request, doi phan hoi, co retry sang instance khac. */
    private Frame call(int type, byte[] payload) {
        CgpException last = null;
        // Khong thu lai chinh instance vua hong: neu no dang chet, thu lai chi
        // ton them mot lan timeout nua.
        java.util.Set<Endpoint> tried = new java.util.HashSet<>();
        for (int attempt = 0; attempt <= retries; attempt++) {
            Endpoint endpoint = pick(tried);
            if (endpoint == null) {
                failures.incrementAndGet();
                throw new CgpException(ErrorCode.RULES_UNAVAILABLE,
                        "khong con rules service nao kha dung");
            }
            try {
                Frame reply = endpoint.exchange(type, payload, timeoutMs);
                endpoint.recordSuccess();
                return reply;
            } catch (IOException | CgpException failure) {
                tried.add(endpoint);
                endpoint.recordFailure(failure instanceof java.net.ConnectException
                        || failure instanceof java.net.SocketTimeoutException);
                failures.incrementAndGet();
                last = failure instanceof CgpException cgp ? cgp
                        : new CgpException(ErrorCode.RULES_UNAVAILABLE, failure.getMessage());
            }
        }
        throw last != null ? last
                : new CgpException(ErrorCode.RULES_UNAVAILABLE, "khong goi duoc rules service");
    }

    /**
     * Chon instance de goi.
     *
     * Chi dem so request dang cho la KHONG du: mot instance da chet luon co 0
     * request dang cho nen se luon duoc chon - dung loi da gap that khi chay
     * 20 van dong thoi. Vi vay thu tu uu tien la: (1) instance da tung tra loi
     * duoc, (2) it request dang cho nhat.
     */
    private Endpoint pick(java.util.Set<Endpoint> excluded) {
        Endpoint best = null;
        for (Endpoint endpoint : endpoints) {
            if (!endpoint.available() || excluded.contains(endpoint)) {
                continue;
            }
            if (best == null
                    || (endpoint.healthy() && !best.healthy())
                    || (endpoint.healthy() == best.healthy()
                        && endpoint.outstanding() < best.outstanding())) {
                best = endpoint;
            }
        }
        return best;
    }

    /** Tra ve thong ke: ti le trung cache, so loi va trang thai cac endpoint. */
    @Override
    public String stats() {
        long hit = hits.get();
        long miss = misses.get();
        long total = hit + miss;
        return String.format("cache %d/%d (%.1f%%), loi %d, endpoint %s",
                hit, total, total == 0 ? 0.0 : hit * 100.0 / total, failures.get(), endpoints);
    }

    /** Dong moi ket noi dang nam trong pool cua cac endpoint. */
    @Override
    public void close() {
        endpoints.forEach(Endpoint::close);
    }

    // ------------------------------------------------------------- endpoint

    /** Mot instance rules service: pool ket noi + circuit breaker rieng. */
    private static final class Endpoint {

        private final String host;
        private final int port;
        private final int poolSize;
        private final int breakerThreshold;
        private final long breakerOpenMs;

        private final Deque<Link> idle = new ArrayDeque<>();
        private int created;
        private int outstanding;
        private int consecutiveFailures;
        private long openedUntil;
        private boolean proven;

        /** Tao endpoint voi dia chi, kich thuoc pool va nguong circuit breaker. */
        Endpoint(String host, int port, int poolSize, int breakerThreshold, long breakerOpenMs) {
            this.host = host;
            this.port = port;
            this.poolSize = poolSize;
            this.breakerThreshold = breakerThreshold;
            this.breakerOpenMs = breakerOpenMs;
        }

        /** Endpoint co dang nhan request khong (circuit breaker khong mo). */
        synchronized boolean available() {
            return System.currentTimeMillis() >= openedUntil;
        }

        /** So request dang cho phan hoi tu endpoint nay. */
        synchronized int outstanding() {
            return outstanding;
        }

        /** Ghi nhan mot lan goi thanh cong: xoa dem loi lien tiep va danh dau da tung tra loi duoc. */
        synchronized void recordSuccess() {
            consecutiveFailures = 0;
            proven = true;
        }

        /** Da tung tra loi duoc it nhat mot lan ke tu khi khoi dong. */
        synchronized boolean healthy() {
            return proven && consecutiveFailures == 0;
        }

        /** Ghi nhan mot lan goi loi; khong ket noi duoc hoac loi lien tiep qua nguong thi mo mach tam ngung endpoint. */
        synchronized void recordFailure(boolean cannotConnect) {
            // Khong mo duoc ket noi nghia la tien trinh do khong chay: mo mach
            // ngay, khong can doi du so lan that bai.
            if (cannotConnect) {
                openedUntil = System.currentTimeMillis() + breakerOpenMs;
                consecutiveFailures = 0;
                return;
            }
            if (++consecutiveFailures >= breakerThreshold) {
                // Mo mach: ngung goi mot luc thay vi cho timeout tung request (X39).
                openedUntil = System.currentTimeMillis() + breakerOpenMs;
                consecutiveFailures = 0;
                System.err.printf("Rules %s:%d tam ngung %d ms (qua nhieu loi lien tiep)%n",
                        host, port, breakerOpenMs);
            }
        }

        /** Muon mot ket noi trong pool, gui request va cho phan hoi; ket noi loi thi bo han thay vi tra ve pool. */
        Frame exchange(int type, byte[] payload, int timeoutMs) throws IOException {
            Link link = borrow(timeoutMs);
            synchronized (this) {
                outstanding++;
            }
            try {
                Frame reply = link.exchange(type, payload);
                release(link);
                return reply;
            } catch (IOException | CgpException failure) {
                link.close();                 // ket noi hong thi bo han, khong tra lai pool
                synchronized (this) {
                    created--;
                }
                throw failure;
            } finally {
                synchronized (this) {
                    outstanding--;
                }
            }
        }

        /** Lay ket noi ranh trong pool; het thi mo ket noi moi (pool day thi mo ket noi tam ngoai pool). */
        private Link borrow(int timeoutMs) throws IOException {
            synchronized (this) {
                Link link = idle.pollFirst();
                if (link != null) {
                    return link;
                }
                if (created >= poolSize) {
                    // Pool het: mo them mot ket noi tam thoi con hon de nuoc di doi.
                    return new Link(host, port, timeoutMs);
                }
                created++;
            }
            try {
                return new Link(host, port, timeoutMs);
            } catch (IOException failure) {
                synchronized (this) {
                    created--;
                }
                throw failure;
            }
        }

        /** Tra ket noi ve pool; pool da du thi dong ket noi do. */
        private synchronized void release(Link link) {
            if (idle.size() < poolSize) {
                idle.addLast(link);
            } else {
                link.close();
                created--;
            }
        }

        /** Dong moi ket noi ranh trong pool. */
        synchronized void close() {
            idle.forEach(Link::close);
            idle.clear();
        }

        /** Hien thi endpoint dang host:port, kem ghi chu neu dang mo mach. */
        @Override
        public String toString() {
            return host + ":" + port + (available() ? "" : "(dang mo mach)");
        }
    }

    /** Mot ket noi TCP toi rules service, dung request/response tuan tu. */
    private static final class Link {

        private final Socket socket;
        private final InputStream in;
        private final OutputStream out;
        private final FrameCodec.Decoder decoder = new FrameCodec.Decoder();
        private final byte[] buffer = new byte[8192];
        private int seq = 1;

        /** Mo ket noi TCP toi rules service voi timeout ket noi va timeout doc. */
        Link(String host, int port, int timeoutMs) throws IOException {
            socket = new Socket();
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            socket.setSoTimeout(timeoutMs);
            socket.setTcpNoDelay(true);
            in = socket.getInputStream();
            out = socket.getOutputStream();
        }

        /** Gui mot frame request va doc cho toi khi nhan du mot frame phan hoi. */
        Frame exchange(int type, byte[] payload) throws IOException {
            java.nio.ByteBuffer frame = FrameCodec.encode(type, seq++, payload);
            byte[] bytes = new byte[frame.remaining()];
            frame.get(bytes);
            out.write(bytes);
            out.flush();

            for (;;) {
                int count = in.read(buffer);
                if (count < 0) {
                    throw new IOException("rules service dong ket noi");
                }
                List<Frame> frames = decoder.feed(buffer, 0, count);
                if (!frames.isEmpty()) {
                    return frames.get(0);
                }
            }
        }

        /** Dong socket, bo qua loi. */
        void close() {
            try {
                socket.close();
            } catch (IOException ignored) {
                // Dang bo ket noi nay di.
            }
        }
    }
}
