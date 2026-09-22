package vn.dcgs.common;

/**
 * Bang ma loi cua CGP - chess/PROTOCOL.md §A6.
 *
 * Moi loi deu phai tra ve mot ma trong bang nay. Khong duoc de exception thoat
 * ra ngoai bien ket noi (nguyen tac o PLAN.md §7).
 */
public final class ErrorCode {

    private ErrorCode() {
    }

    // 1xxx - xac thuc / phien
    public static final int BAD_CREDENTIALS = 1001;
    public static final int SESSION_EXPIRED = 1002;
    public static final int LOGGED_IN_ELSEWHERE = 1003;
    public static final int USERNAME_TAKEN = 1004;
    public static final int INVALID_CREDENTIALS_FORMAT = 1005;

    // 2xxx - protocol
    public static final int MALFORMED_FRAME = 2001;
    public static final int UNKNOWN_TYPE = 2002;
    public static final int FRAME_TOO_LARGE = 2003;
    public static final int BAD_PROTOCOL_VERSION = 2004;
    public static final int NOT_AUTHENTICATED = 2005;

    // 3xxx - luat choi / trang thai van
    public static final int NOT_YOUR_TURN = 3001;
    public static final int ILLEGAL_MOVE = 3002;
    public static final int GAME_NOT_FOUND = 3003;
    public static final int NOT_A_PLAYER = 3004;
    public static final int STALE_PLY = 3005;
    public static final int PROMOTION_REQUIRED = 3006;
    public static final int GAME_ALREADY_OVER = 3007;
    public static final int ALREADY_QUEUED = 3008;

    // 4xxx - he thong
    public static final int RULES_UNAVAILABLE = 4001;
    public static final int DATABASE_ERROR = 4002;
    public static final int SERVER_OVERLOADED = 4003;
    public static final int INTERNAL_ERROR = 4004;
    public static final int RATE_LIMITED = 4005;

    /** Loi nay co phai dong ket noi khong? (cot "Hanh dong" trong bang §A6). */
    public static boolean closesConnection(int code) {
        return switch (code) {
            case MALFORMED_FRAME, UNKNOWN_TYPE, FRAME_TOO_LARGE, BAD_PROTOCOL_VERSION -> true;
            default -> false;
        };
    }

    public static String message(int code) {
        return switch (code) {
            case BAD_CREDENTIALS -> "Sai tai khoan hoac mat khau";
            case SESSION_EXPIRED -> "Phien da het han";
            case LOGGED_IN_ELSEWHERE -> "Tai khoan da dang nhap o noi khac";
            case USERNAME_TAKEN -> "Ten dang nhap da ton tai";
            case INVALID_CREDENTIALS_FORMAT -> "Ten dang nhap hoac mat khau khong hop le";
            case MALFORMED_FRAME -> "Frame sai dinh dang";
            case UNKNOWN_TYPE -> "Loai message khong ton tai";
            case FRAME_TOO_LARGE -> "Frame vuot gioi han 64 KiB";
            case BAD_PROTOCOL_VERSION -> "Sai phien ban protocol";
            case NOT_AUTHENTICATED -> "Chua dang nhap";
            case NOT_YOUR_TURN -> "Khong phai luot cua ban";
            case ILLEGAL_MOVE -> "Nuoc di khong hop le";
            case GAME_NOT_FOUND -> "Khong tim thay van";
            case NOT_A_PLAYER -> "Ban khong phai nguoi choi cua van nay";
            case STALE_PLY -> "Nuoc di den muon hoac trung";
            case PROMOTION_REQUIRED -> "Thieu thong tin phong cap";
            case GAME_ALREADY_OVER -> "Van da ket thuc";
            case ALREADY_QUEUED -> "Da o trong hang doi";
            case RULES_UNAVAILABLE -> "Rules service khong kha dung";
            case DATABASE_ERROR -> "Loi database";
            case SERVER_OVERLOADED -> "Server qua tai";
            case RATE_LIMITED -> "Gui qua nhanh";
            default -> "Loi noi bo";
        };
    }
}
