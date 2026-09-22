package vn.dcgs.common;

import java.nio.ByteBuffer;

/**
 * Ma hoa nuoc di - phan "hot path" cua protocol (PROTOCOL.md §A3, §A4).
 *
 * Mot nuoc di gui len 8 byte, cap nhat tra ve 16 byte va KHONG kem FEN: client
 * tu ap dung nuoc di len ban co cuc bo. Day chinh la delta encoding duoc do o
 * thi nghiem E3, doi chung voi che do JSON kem FEN day du.
 */
public final class MoveCodec {

    public static final int MOVE_SIZE = 8;
    public static final int MOVE_APPLIED_SIZE = 16;

    // flags trong MOVE_APPLIED
    public static final int FLAG_CAPTURE = 1;
    public static final int FLAG_CASTLE = 1 << 1;
    public static final int FLAG_EN_PASSANT = 1 << 2;
    public static final int FLAG_PROMOTION = 1 << 3;
    public static final int FLAG_CHECK = 1 << 4;
    public static final int FLAG_CHECKMATE = 1 << 5;
    public static final int FLAG_DRAW = 1 << 6;

    private static final char[] PROMO_LETTERS = {' ', 'n', 'b', 'r', 'q'};

    private MoveCodec() {
    }

    /** "e2" -> 12. index = rank*8 + file, a1 = 0, h8 = 63. */
    public static int squareToIndex(String square) {
        if (square == null || square.length() != 2) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME, "o co khong hop le: " + square);
        }
        int file = square.charAt(0) - 'a';
        int rank = square.charAt(1) - '1';
        if (file < 0 || file > 7 || rank < 0 || rank > 7) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME, "o co khong hop le: " + square);
        }
        return rank * 8 + file;
    }

    public static String indexToSquare(int index) {
        if (index < 0 || index > 63) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME, "chi so o khong hop le: " + index);
        }
        return "" + (char) ('a' + index % 8) + (char) ('1' + index / 8);
    }

    public static int promotionCode(char piece) {
        return switch (Character.toLowerCase(piece)) {
            case 'n' -> 1;
            case 'b' -> 2;
            case 'r' -> 3;
            case 'q' -> 4;
            default -> 0;
        };
    }

    public static char promotionLetter(int code) {
        return code >= 1 && code <= 4 ? PROMO_LETTERS[code] : ' ';
    }

    /** Nuoc di client gui len. Client luon dat flags = 0; server tu tinh. */
    public record Move(String from, String to, int promotion, int ply) {

        public String uci() {
            String base = from + to;
            return promotion == 0 ? base : base + promotionLetter(promotion);
        }
    }

    public static byte[] encodeMove(Move move) {
        ByteBuffer out = ByteBuffer.allocate(MOVE_SIZE);
        out.put((byte) squareToIndex(move.from()));
        out.put((byte) squareToIndex(move.to()));
        out.put((byte) move.promotion());
        out.put((byte) 0);                   // flags
        out.putShort((short) move.ply());
        out.putShort((short) 0);             // reserved
        return out.array();
    }

    public static Move decodeMove(byte[] payload) {
        if (payload.length != MOVE_SIZE) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME,
                    "MOVE phai " + MOVE_SIZE + " byte, nhan " + payload.length);
        }
        ByteBuffer in = ByteBuffer.wrap(payload);
        String from = indexToSquare(in.get() & 0xFF);
        String to = indexToSquare(in.get() & 0xFF);
        int promotion = in.get() & 0xFF;
        in.get();                            // flags: bo qua, khong tin client
        int ply = in.getShort() & 0xFFFF;
        return new Move(from, to, promotion, ply);
    }

    /**
     * Ket qua server gui ve. Mang theo CA HAI dong ho vi server la nguon chan ly
     * duy nhat ve thoi gian (dong gop N2).
     */
    public record MoveApplied(int ply, String from, String to, int promotion, int flags,
                              long clockWhiteMs, long clockBlackMs, int serverProcessMs) {

        public boolean has(int flag) {
            return (flags & flag) != 0;
        }

        public boolean endsGame() {
            return has(FLAG_CHECKMATE) || has(FLAG_DRAW);
        }
    }

    public static byte[] encodeMoveApplied(MoveApplied applied) {
        ByteBuffer out = ByteBuffer.allocate(MOVE_APPLIED_SIZE);
        out.putShort((short) applied.ply());
        out.put((byte) squareToIndex(applied.from()));
        out.put((byte) squareToIndex(applied.to()));
        out.put((byte) applied.promotion());
        out.put((byte) applied.flags());
        out.putInt((int) Math.max(0, applied.clockWhiteMs()));
        out.putInt((int) Math.max(0, applied.clockBlackMs()));
        out.putShort((short) applied.serverProcessMs());
        return out.array();
    }

    public static MoveApplied decodeMoveApplied(byte[] payload) {
        if (payload.length != MOVE_APPLIED_SIZE) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME,
                    "MOVE_APPLIED phai " + MOVE_APPLIED_SIZE + " byte, nhan " + payload.length);
        }
        ByteBuffer in = ByteBuffer.wrap(payload);
        int ply = in.getShort() & 0xFFFF;
        String from = indexToSquare(in.get() & 0xFF);
        String to = indexToSquare(in.get() & 0xFF);
        int promotion = in.get() & 0xFF;
        int flags = in.get() & 0xFF;
        long clockWhite = in.getInt() & 0xFFFFFFFFL;
        long clockBlack = in.getInt() & 0xFFFFFFFFL;
        int processMs = in.getShort() & 0xFFFF;
        return new MoveApplied(ply, from, to, promotion, flags, clockWhite, clockBlack, processMs);
    }

    // ---------- CLOCK_PING / CLOCK_PONG (PROTOCOL.md §A5) ----------

    public static byte[] encodeClockPing(long t1) {
        return ByteBuffer.allocate(8).putLong(t1).array();
    }

    public static byte[] encodeClockPong(long t1, long t2, long t3) {
        return ByteBuffer.allocate(24).putLong(t1).putLong(t2).putLong(t3).array();
    }

    public record ClockPong(long t1, long t2, long t3) {
    }

    public static ClockPong decodeClockPong(byte[] payload) {
        if (payload.length != 24) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME,
                    "CLOCK_PONG phai 24 byte, nhan " + payload.length);
        }
        ByteBuffer in = ByteBuffer.wrap(payload);
        return new ClockPong(in.getLong(), in.getLong(), in.getLong());
    }
}
