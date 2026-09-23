package vn.dcgs.server.net;

/**
 * Ben phan xu luat co, nhin tu phia ban co.
 *
 * Co hai ban hien thuc va viec chon ban nao la mot dong cau hinh (`rules.mode`):
 *
 *   remote   {@link RulesClient}                       - goi sang tien trinh Node
 *                                                        chay chess.js, qua RVP.
 *                                                        Day la thiet ke duoc de
 *                                                        xuat (dong gop N3).
 *   embedded {@link vn.dcgs.server.game.EmbeddedRules}  - bang luat viet trong
 *                                                        Java, chay ngay trong
 *                                                        tien trinh server.
 *
 * Ban `embedded` ton tai DUY NHAT de lam doi chung cho thi nghiem E7: no cho
 * biet mot nuoc di ton bao nhieu thoi gian khi KHONG co round-trip noi bo, nho
 * do tach duoc "chi phi cua viec tach dich vu" ra khoi "chi phi cua viec kiem
 * tra luat". He thong that chay o che do `remote`.
 */
public interface RulesEngine extends AutoCloseable {

    /** Ket qua kiem tra luat - dich thang tu RULES_OK. */
    record Verdict(boolean legal, String fenAfter, String san, String uci,
                   int flags, String status, int errorCode, String reason) {

        public static Verdict illegal(int code, String reason) {
            return new Verdict(false, null, null, null, 0, null, code, reason);
        }

        /** Trang thai nay ket thuc van? "check" thi chua - van van dang danh. */
        public boolean endsGame() {
            return legal && !"ongoing".equals(status) && !"check".equals(status);
        }
    }

    Verdict validate(String fen, String from, String to, String promotion);

    /**
     * Ben `side` ("w"/"b") co du quan de chieu het khong?
     *
     * Can rieng mot cau hoi nay vi luc HET GIO, ban co chua o trang thai hoa -
     * ta phai hoi truoc khi xu (X29): het gio ma doi thu chi con vua thi theo
     * luat FIDE la HOA, khong phai thua.
     */
    boolean insufficientMaterialFor(String fen, String side);

    /** Con phuc vu duoc khong? Dung de dua van dang PAUSED chay tiep (X44). */
    boolean available();

    String stats();

    @Override
    void close();
}
