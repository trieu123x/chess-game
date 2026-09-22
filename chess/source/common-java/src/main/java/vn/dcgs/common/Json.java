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

    private Json() {
    }

    public static byte[] bytes(Object value) {
        try {
            return MAPPER.writeValueAsBytes(value);
        } catch (Exception failure) {
            throw new CgpException(ErrorCode.INTERNAL_ERROR, "khong tao duoc JSON: " + failure.getMessage());
        }
    }

    public static byte[] of(Map<String, ?> fields) {
        return bytes(fields);
    }

    public static JsonNode parse(byte[] payload) {
        try {
            return MAPPER.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception failure) {
            throw new CgpException(ErrorCode.MALFORMED_FRAME, "payload JSON hong");
        }
    }

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

    public static String optional(JsonNode node, String field, String fallback) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? fallback : value.asText();
    }

    public static int optionalInt(JsonNode node, String field, int fallback) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? fallback : value.asInt(fallback);
    }
}
