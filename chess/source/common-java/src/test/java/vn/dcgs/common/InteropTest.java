package vn.dcgs.common;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Interop: ban Java phai sinh ra DUNG TUNG BYTE nhu ban Node va ban TypeScript.
 *
 * Nguon su that dung chung: source/common-js/testvectors.json, sinh boi
 * `node gen-testvectors.mjs`. Ba ban hien thuc cua cung mot protocol deu doc
 * file nay - day la bang chung cho dong gop N6 (protocol doc lap ngon ngu),
 * va la thu chan viec mot ban lang le lech chuan khi sua doi.
 */
class InteropTest {

    private static final Path VECTORS = Path.of("..", "common-js", "testvectors.json");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Tra ma so tu ten message: "LOGIN" -> 0x01, doc thang tu MsgType. */
    private static Map<String, Integer> typeCodes() {
        Map<String, Integer> codes = new HashMap<>();
        for (Field field : MsgType.class.getDeclaredFields()) {
            if (Modifier.isStatic(field.getModifiers()) && field.getType() == int.class) {
                try {
                    codes.put(field.getName(), field.getInt(null));
                } catch (IllegalAccessException ignored) {
                    // Field cong khai, khong the xay ra.
                }
            }
        }
        return codes;
    }

    private static String hex(ByteBuffer buffer) {
        StringBuilder out = new StringBuilder(buffer.remaining() * 2);
        while (buffer.hasRemaining()) {
            out.append(String.format("%02x", buffer.get()));
        }
        return out.toString();
    }

    private static byte[] unhex(String text) {
        byte[] out = new byte[text.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(text.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static byte[] payloadFor(JsonNode vector) throws Exception {
        JsonNode payload = vector.get("payload");
        return switch (vector.get("payloadKind").asText()) {
            case "json" -> MAPPER.writeValueAsString(payload).getBytes(StandardCharsets.UTF_8);
            case "move" -> MoveCodec.encodeMove(new MoveCodec.Move(
                    payload.get("from").asText(),
                    payload.get("to").asText(),
                    MoveCodec.promotionCode(promoChar(payload.get("promo").asText())),
                    payload.get("ply").asInt()));
            case "moveApplied" -> MoveCodec.encodeMoveApplied(new MoveCodec.MoveApplied(
                    payload.get("ply").asInt(),
                    payload.get("from").asText(),
                    payload.get("to").asText(),
                    MoveCodec.promotionCode(promoChar(payload.get("promo").asText())),
                    payload.get("flags").asInt(),
                    payload.get("clockWhiteMs").asLong(),
                    payload.get("clockBlackMs").asLong(),
                    payload.get("serverProcessMs").asInt()));
            case "clockPong" -> MoveCodec.encodeClockPong(
                    payload.get("t1").asLong(), payload.get("t2").asLong(), payload.get("t3").asLong());
            default -> Frame.EMPTY;
        };
    }

    private static char promoChar(String promo) {
        return promo == null || promo.isEmpty() ? ' ' : promo.charAt(0);
    }

    @TestFactory
    @DisplayName("Java sinh ra dung tung byte nhu Node/TypeScript cho moi test vector")
    List<DynamicTest> matchesSharedVectors() throws Exception {
        JsonNode root = MAPPER.readTree(Files.readString(VECTORS, StandardCharsets.UTF_8));
        Map<String, Integer> codes = typeCodes();
        List<DynamicTest> tests = new ArrayList<>();

        for (JsonNode vector : root.get("frames")) {
            String name = vector.get("name").asText();
            tests.add(DynamicTest.dynamicTest(name, () -> {
                int type = codes.get(vector.get("type").asText());
                int seq = vector.get("seq").asInt();
                String expected = vector.get("hex").asText();

                // 1. Ma hoa: Java phai ra dung chuoi hex chung.
                assertEquals(expected, hex(FrameCodec.encode(type, seq, payloadFor(vector))),
                        "vector " + name + ": byte ma hoa lech voi ban Node");

                // 2. Giai ma nguoc: doc duoc frame do ngon ngu khac sinh ra.
                List<Frame> frames = new FrameCodec.Decoder().feed(unhex(expected));
                assertEquals(1, frames.size(), "vector " + name + ": phai ra dung 1 frame");
                assertEquals(type, frames.get(0).type());
                assertEquals(seq, frames.get(0).seq());
            }));
        }

        assertEquals(root.get("frames").size(), tests.size());
        return tests;
    }
}
