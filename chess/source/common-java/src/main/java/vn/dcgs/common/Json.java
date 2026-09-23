package vn.dcgs.common;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Payload JSON cho "control path" cua CGP (LOGIN, MATCH_FOUND, GAME_OVER...).
 *
 * Duong "hot path" (MOVE, MOVE_APPLIED, CLOCK, HEARTBEAT) dung nhi phan, xem
 * MoveCodec — day la quyet dinh thiet ke duoc do o thi nghiem E3, khong phai
 * su thieu nhat quan.
 *
 * Moi loi doc JSON deu thanh CgpException 2001 de lop mang chi xu ly mot loai.
 */
public final class Json {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** Lop tien ich, khong cho tao instance. */
    private Json() {
    }

    /** Chuyen mot doi tuong bat ky thanh mang byte JSON; loi thi nem CgpException 4004. */
    public static byte[] bytes(Object value) {
        try {
            return MAPPER.writeValueAsBytes(value);
        } catch (Exception failure) {
            throw new CgpException(ErrorCode.INTERNAL_ERROR, "khong tao duoc JSON: " + failure.getMessage());
        }
    }

    /** Chuyen mot Map cac truong thanh mang byte JSON. */
    public static byte[] of(Map<String, ?> fields) {
        return bytes(fields);
    }

    /** Doc payload byte thanh cay JsonNode; JSON hong thi nem CgpException 2001. */
    public static JsonNode parse(byte[] payload) {
        try {
            return MAPPER.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception failure) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME, "payload JSON hong");
        }
    }

    /** Tao mot ObjectNode JSON rong de dien truong vao. */
    public static ObjectNode object() {
        return MAPPER.createObjectNode();
    }

    /** Doc mot truong bat buoc: thieu thi la frame hong, khong phai gia tri rong. */
    public static String required(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull() || !value.isTextual()) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME, "thieu truong '" + field + "'");
        }
        return value.asText();
    }

    /** Doc mot truong chuoi tuy chon; thieu hoac null thi tra ve gia tri mac dinh. */
    public static String optional(JsonNode node, String field, String fallback) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? fallback : value.asText();
    }

    /** Doc mot truong so nguyen tuy chon; thieu, null hoac sai kieu thi tra ve gia tri mac dinh. */
    public static int optionalInt(JsonNode node, String field, int fallback) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? fallback : value.asInt(fallback);
    }
}
