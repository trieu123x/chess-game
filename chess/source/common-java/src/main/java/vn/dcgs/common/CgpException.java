package vn.dcgs.common;

/** Loi protocol, luon mang theo mot ma trong ErrorCode de tra ve cho client. */
public class CgpException extends RuntimeException {

    private final int code;
    private final String reason;

    public CgpException(int code, String message) {
        super("CGP " + code + ": " + message);
        this.code = code;
        this.reason = message;
    }

    /** Ly do tran, khong kem tien to "CGP <ma>" - dung khi gui cho client. */
    public String reason() {
        return reason;
    }

    public int code() {
        return code;
    }

    public boolean closesConnection() {
        return ErrorCode.closesConnection(code);
    }
}
