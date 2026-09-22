package vn.dcgs.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Bo test bat buoc cua protocol - PLAN.md §8 (T01, T02) va PROTOCOL.md §C.
 *
 * Nhung test nay ton tai vi TCP khong giu ranh gioi message: neu decoder sai,
 * loi chi lo ra khi chay tai cao va rat kho tim.
 */
class FrameCodecTest {

    private static byte[] bytes(ByteBuffer buffer) {
        byte[] out = new byte[buffer.remaining()];
        buffer.get(out);
        return out;
    }

    @Test
    @DisplayName("encode roi decode tra lai dung type, seq va payload")
    void roundTrip() {
        byte[] payload = "{\"username\":\"alice\"}".getBytes(StandardCharsets.UTF_8);
        byte[] wire = bytes(FrameCodec.encode(MsgType.LOGIN, 7, payload));

        List<Frame> frames = new FrameCodec.Decoder().feed(wire);

        assertEquals(1, frames.size());
        assertEquals(MsgType.LOGIN, frames.get(0).type());
        assertEquals(7, frames.get(0).seq());
        assertArrayEquals(payload, frames.get(0).payload());
    }

    @Test
    @DisplayName("T02a - mot frame bi cat lam 3 lan ghi van decode dung")
    void halfPacket() {
        byte[] wire = bytes(FrameCodec.encodeJson(MsgType.GAME_SNAPSHOT, 3,
                "{\"fen\":\"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1\"}"));
        FrameCodec.Decoder decoder = new FrameCodec.Decoder();

        int first = 3;                       // cat giua header
        int second = wire.length / 2;
        assertTrue(decoder.feed(wire, 0, first).isEmpty());
        assertTrue(decoder.feed(wire, first, second - first).isEmpty());

        List<Frame> frames = decoder.feed(wire, second, wire.length - second);

        assertEquals(1, frames.size());
        assertEquals(MsgType.GAME_SNAPSHOT, frames.get(0).type());
    }

    @Test
    @DisplayName("T02b - 5 frame trong mot lan ghi decode ra dung 5 message")
    void coalescedPackets() {
        ByteBuffer joined = ByteBuffer.allocate(4096);
        for (int i = 0; i < 5; i++) {
            joined.put(FrameCodec.encode(MsgType.HEARTBEAT, i));
        }
        joined.flip();

        List<Frame> frames = new FrameCodec.Decoder().feed(bytes(joined));

        assertEquals(5, frames.size());
        for (int i = 0; i < 5; i++) {
            assertEquals(i, frames.get(i).seq());
            assertEquals(0, frames.get(i).payload().length);
        }
    }

    @Test
    @DisplayName("T01 - LEN vuot 64 KiB bi tu choi 2003, khong cap phat bo nho theo LEN")
    void oversizeFrameRejected() {
        byte[] header = ByteBuffer.allocate(9)
                .putInt(FrameCodec.MAX_FRAME + 1).put((byte) MsgType.MOVE).putInt(1).array();

        CgpException failure = assertThrows(CgpException.class,
                () -> new FrameCodec.Decoder().feed(header));

        assertEquals(ErrorCode.FRAME_TOO_LARGE, failure.code());
        assertTrue(failure.closesConnection());
    }

    @Test
    @DisplayName("T01 - LEN nho hon 5 bi tu choi 2001")
    void underlengthFrameRejected() {
        byte[] header = ByteBuffer.allocate(9)
                .putInt(2).put((byte) MsgType.MOVE).putInt(1).array();

        CgpException failure = assertThrows(CgpException.class,
                () -> new FrameCodec.Decoder().feed(header));

        assertEquals(ErrorCode.MALFORMED_FRAME, failure.code());
    }

    @Test
    @DisplayName("Nuoc di di qua duong day 8 byte va khong doi noi dung")
    void moveRoundTrip() {
        MoveCodec.Move move = new MoveCodec.Move("e2", "e4", 0, 12);

        byte[] wire = MoveCodec.encodeMove(move);

        assertEquals(MoveCodec.MOVE_SIZE, wire.length);
        assertEquals(move, MoveCodec.decodeMove(wire));
    }

    @Test
    @DisplayName("Nuoc phong cap giu dung quan duoc chon")
    void promotionRoundTrip() {
        MoveCodec.Move move = new MoveCodec.Move("e7", "e8", MoveCodec.promotionCode('n'), 41);

        MoveCodec.Move decoded = MoveCodec.decodeMove(MoveCodec.encodeMove(move));

        assertEquals("e7e8n", decoded.uci());
    }

    @Test
    @DisplayName("MOVE_APPLIED day 16 byte, mang ca hai dong ho")
    void moveAppliedRoundTrip() {
        MoveCodec.MoveApplied applied = new MoveCodec.MoveApplied(
                13, "g1", "f3", 0, MoveCodec.FLAG_CHECK, 178_500, 181_000, 4);

        byte[] wire = MoveCodec.encodeMoveApplied(applied);

        assertEquals(MoveCodec.MOVE_APPLIED_SIZE, wire.length);
        MoveCodec.MoveApplied decoded = MoveCodec.decodeMoveApplied(wire);
        assertEquals(applied, decoded);
        assertTrue(decoded.has(MoveCodec.FLAG_CHECK));
    }

    @Test
    @DisplayName("Chi so o co khop quy uoc a1 = 0, h8 = 63")
    void squareIndexing() {
        assertEquals(0, MoveCodec.squareToIndex("a1"));
        assertEquals(7, MoveCodec.squareToIndex("h1"));
        assertEquals(56, MoveCodec.squareToIndex("a8"));
        assertEquals(63, MoveCodec.squareToIndex("h8"));
        for (int index = 0; index < 64; index++) {
            assertEquals(index, MoveCodec.squareToIndex(MoveCodec.indexToSquare(index)));
        }
    }

    @Test
    @DisplayName("Dong ho: 16 byte MOVE_APPLIED re hon nhieu so voi JSON kem FEN (co so cua E3)")
    void binaryIsSmallerThanJson() {
        byte[] binary = MoveCodec.encodeMoveApplied(new MoveCodec.MoveApplied(
                13, "g1", "f3", 0, 0, 178_500, 181_000, 4));
        String json = "{\"ply\":13,\"from\":\"g1\",\"to\":\"f3\",\"promo\":\"\",\"flags\":0,"
                + "\"clockW\":178500,\"clockB\":181000,"
                + "\"fen\":\"rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1\"}";

        assertTrue(binary.length * 5 < json.getBytes(StandardCharsets.UTF_8).length,
                "binary phai nho hon JSON it nhat 5 lan");
    }
}
