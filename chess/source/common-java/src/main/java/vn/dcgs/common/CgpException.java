package vn.dcgs.common;

/** Loi protocol, luon mang theo mot ma trong ErrorCode de tra ve cho client. */
public class CgpException extends RuntimeException {

    private final int code;

    public CgpException(int code, String message) {
        super("CGP " + code + ": " + message);
        this.code = code;
    }

    public int code() {
        return code;
    }

    public boolean closesConnection() {
        return ErrorCode.closesConnection(code);
    }
}
