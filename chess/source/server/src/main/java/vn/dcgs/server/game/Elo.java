package vn.dcgs.server.game;

/**
 * He so Elo tieu chuan, K = 32.
 *
 * Diem ky vong: E = 1 / (1 + 10^((Rb - Ra)/400))
 * Diem moi:     R' = R + K * (S - E),  S = 1 / 0.5 / 0
 *
 * Lam tron ve phia nguoi thang de tong diem khong bi tut dan sau nhieu van.
 */
public final class Elo {

    public static final int K = 32;

    private Elo() {
    }

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
