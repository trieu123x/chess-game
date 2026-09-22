package vn.dcgs.common;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Dong goi va mo goi khung CGP/RVP.
 *
 * TCP la mot dong byte lien tuc, khong co ranh gioi message. Mot lan doc co the
 * nhan duoc nua message (half-packet) hoac vai message dinh lien nhau. Lop
 * {@link Decoder} ben duoi giai quyet ca hai truong hop - day la test bat buoc
 * T02 trong PLAN.md §8.
 *
 * Khung:  LEN(u32) | TYPE(u8) | SEQ(u32) | PAYLOAD,  LEN = 5 + payload.length
 * Thu tu byte: big-endian (network byte order), giong ByteBuffer mac dinh.
 */
public final class FrameCodec {

    /** Frame lon hon nguong nay bi tu choi ngay, truoc khi cap phat bo nho (X06). */
    public static final int MAX_FRAME = 65536;

    private static final int HEADER = 9;          // LEN + TYPE + SEQ
    private static final int LENGTH_PREFIX = 4;

    private FrameCodec() {
    }

    public static ByteBuffer encode(int type, int seq, byte[] payload) {
        if (payload.length + 5 > MAX_FRAME) {
            throw new CgpException(ErrorCode.FRAME_TOO_LARGE,
                    "payload " + payload.length + " byte vuot gioi han");
        }
        ByteBuffer out = ByteBuffer.allocate(LENGTH_PREFIX + 5 + payload.length);
        out.putInt(5 + payload.length);
        out.put((byte) type);
        out.putInt(seq);
        out.put(payload);
        return out.flip();
    }

    public static ByteBuffer encode(int type, int seq) {
        return encode(type, seq, Frame.EMPTY);
    }

    public static ByteBuffer encodeJson(int type, int seq, String json) {
        return encode(type, seq, json.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Bo gom byte cho mot ket noi. Moi ket noi giu mot Decoder rieng; khong
     * duoc dung chung giua cac ket noi vi trang thai la byte con do dang.
     */
    public static final class Decoder {

        private ByteBuffer buffer;   // luon o che do GHI

        public Decoder() {
            this(8192);
        }

        public Decoder(int initialCapacity) {
            this.buffer = ByteBuffer.allocate(Math.max(initialCapacity, HEADER));
        }

        public List<Frame> feed(byte[] data) {
            return feed(data, 0, data.length);
        }

        /**
         * Nap them byte vua doc duoc tu socket, tra ve nhung frame da du.
         *
         * @throws CgpException 2001/2003 khi do dai khong hop le - ben goi phai
         *                      dong ket noi va KHONG duoc de anh huong ket noi khac.
         */
        public List<Frame> feed(byte[] data, int offset, int length) {
            ensureWritable(length);
            buffer.put(data, offset, length);

            List<Frame> frames = new ArrayList<>();
            buffer.flip();                                   // sang che do DOC
            while (buffer.remaining() >= LENGTH_PREFIX) {
                buffer.mark();
                int len = buffer.getInt();
                if (len < 5) {
                    throw new CgpException(ErrorCode.MALFORMED_FRAME, "LEN khong hop le: " + len);
                }
                if (len > MAX_FRAME) {
                    throw new CgpException(ErrorCode.FRAME_TOO_LARGE, "LEN = " + len);
                }
                if (buffer.remaining() < len) {
                    buffer.reset();                          // con thieu byte: cho lan doc sau
                    break;
                }
                int type = buffer.get() & 0xFF;
                int seq = buffer.getInt();
                byte[] payload = new byte[len - 5];
                buffer.get(payload);
                frames.add(new Frame(type, seq, payload));
            }
            buffer.compact();                                // ve che do GHI, giu phan con du
            return frames;
        }

        /** So byte dang cho them du lieu - dung de phat hien ket noi gui rac. */
        public int pending() {
            return buffer.position();
        }

        private void ensureWritable(int extra) {
            if (buffer.remaining() >= extra) {
                return;
            }
            int needed = buffer.position() + extra;
            int capacity = Math.max(buffer.capacity() * 2, needed);
            // Tran capacity chi xay ra khi ai do gui rac lien tuc; chan tu day.
            if (capacity > MAX_FRAME + LENGTH_PREFIX) {
                capacity = MAX_FRAME + LENGTH_PREFIX;
                if (capacity < needed) {
                    throw new CgpException(ErrorCode.FRAME_TOO_LARGE,
                            "du lieu cho xu ly vuot " + capacity + " byte");
                }
            }
            ByteBuffer grown = ByteBuffer.allocate(capacity);
            buffer.flip();
            grown.put(buffer);
            buffer = grown;
        }
    }
}
