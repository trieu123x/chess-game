package vn.dcgs.common;

import java.nio.charset.StandardCharsets;

/**
 * Mot don vi message cua CGP/RVP: LEN(4) | TYPE(1) | SEQ(4) | PAYLOAD.
 * LEN khong nam trong record vi luon suy ra duoc = 5 + payload.length.
 */
public record Frame(int type, int seq, byte[] payload) {

    public static final byte[] EMPTY = new byte[0];

    /** Tao frame khong co payload (chi co TYPE va SEQ). */
    public Frame(int type, int seq) {
        this(type, seq, EMPTY);
    }

    /** Giai ma payload thanh chuoi UTF-8. */
    public String payloadAsString() {
        return new String(payload, StandardCharsets.UTF_8);
    }

    /** Tong so byte frame chiem tren duong truyen: LEN(4) + TYPE(1) + SEQ(4) + payload. */
    public int wireSize() {
        return 4 + 5 + payload.length;
    }

    /** Mo ta ngan gon frame de ghi log: TEN_TYPE#seq[so byte payload]. */
    @Override
    public String toString() {
        return MsgType.name(type) + "#" + seq + "[" + payload.length + "B]";
    }
}
