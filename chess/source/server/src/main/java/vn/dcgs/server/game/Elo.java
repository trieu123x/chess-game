package vn.dcgs.server.game;

/**
 * He so Elo tieu chuan, K = 32.
 *
 * Diem ky vong: E = 1 / (1 + 10^((Rb - Ra)/400))
 * Diem moi:     R' = R + K * (S - E),  S = 1 / 0.5 / 0
 *
 * Tong diem gan nhu duoc bao toan: vi E(a,b) + E(b,a) = 1 va tong diem tran
 * bang 1, hai delta luon doi nhau truoc khi lam tron. Sau khi lam tron thi co
 * the lech 1 diem o dung truong hop phan le bang .5 - hiem, va khong tich luy
 * theo huong nao ca.
 */
public final class Elo {

    public static final int K = 32;

    /** Lop tien ich, khong cho tao instance. */
    private Elo() {
    }

    /** Tinh diem ky vong (0..1) cua nguoi choi co rating `rating` khi gap doi thu `opponentRating`. */
    public static double expected(int rating, int opponentRating) {
        return 1.0 / (1.0 + Math.pow(10, (opponentRating - rating) / 400.0));
    }

    /**
     * @param result "1-0" | "0-1" | "1/2-1/2"
     * @return {thay doi cua Trang, thay doi cua Den}
     */
    public static int[] deltas(int whiteElo, int blackElo, String result) {
        double whiteScore = switch (result) {
            case "1-0" -> 1.0;
            case "0-1" -> 0.0;
            default -> 0.5;
        };
        int whiteDelta = (int) Math.round(K * (whiteScore - expected(whiteElo, blackElo)));
        int blackDelta = (int) Math.round(K * ((1 - whiteScore) - expected(blackElo, whiteElo)));
        return new int[] { whiteDelta, blackDelta };
    }
}
