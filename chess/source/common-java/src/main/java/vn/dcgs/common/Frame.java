package vn.dcgs.common;

import java.nio.charset.StandardCharsets;

/**
 * Mot don vi message cua CGP/RVP: LEN(4) | TYPE(1) | SEQ(4) | PAYLOAD.
 * LEN khong nam trong record vi luon suy ra duoc = 5 + payload.length.
 */
public record Frame(int type, int seq, byte[] payload) {

    public static final byte[] EMPTY = new byte[0];

    public Frame(int type, int seq) {
        this(type, seq, EMPTY);
    }

    public String payloadAsString() {
        return new String(payload, StandardCharsets.UTF_8);
    }

    public int wireSize() {
        return 4 + 5 + payload.length;
    }

    @Override
    public String toString() {
        return MsgType.name(type) + "#" + seq + "[" + payload.length + "B]";
    }
}
