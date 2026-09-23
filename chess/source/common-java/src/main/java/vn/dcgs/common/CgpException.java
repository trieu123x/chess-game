package vn.dcgs.common;

/** Loi protocol, luon mang theo mot ma trong ErrorCode de tra ve cho client. */
public class CgpException extends RuntimeException {

    private final int code;
    private final String reason;

    /** Tao loi protocol voi ma loi (ErrorCode) va ly do; message cua exception co tien to "CGP <ma>". */
    public CgpException(int code, String message) {
        super("CGP " + code + ": " + message);
        this.code = code;
        this.reason = message;
    }

    /** Ly do tran, khong kem tien to "CGP <ma>" - dung khi gui cho client. */
    public String reason() {
        return reason;
    }

    /** Tra ve ma loi ErrorCode cua exception nay. */
    public int code() {
        return code;
    }

    /** Kiem tra loi nay co buoc phai dong ket noi voi client hay khong. */
    public boolean closesConnection() {
        return ErrorCode.closesConnection(code);
    }
}
