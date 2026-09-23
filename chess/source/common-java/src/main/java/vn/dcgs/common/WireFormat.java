package vn.dcgs.common;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Cach ma hoa duong "hot path" cua CGP - doi bang `server.format`.
 *
 * Day khong phai mot lop truu tuong cho vui: no ton tai de thi nghiem E3 so
 * duoc HAI cach ma hoa CUNG MOT ban co, cung mot chuoi nuoc di, chi khac moi
 * cach dong goi:
 *
 *   binary  (de xuat) : MOVE 8 byte, MOVE_APPLIED 16 byte, KHONG kem FEN -
 *                       client tu ap nuoc di len ban co cuc bo (delta encoding).
 *   json    (baseline): MOVE va MOVE_APPLIED deu la JSON, va MOVE_APPLIED mang
 *                       theo FEN day du - dung cach ma phan lon he thong hoc
 *                       thuat lam cho tien.
 *
 * Doi che do bang cau hinh chu khong sua code, nen so lieu E3 tai lap duoc.
 */
public interface WireFormat {

    String name();

    /** Nuoc di client gui len. */
    MoveCodec.Move decodeMove(byte[] payload);

    /** Dung de test khu hoi va de bot/client gui theo dung dinh dang dang bat. */
    byte[] encodeMove(MoveCodec.Move move);

    /**
     * Cap nhat server gui ve.
     *
     * @param fenAfter the co sau nuoc di - ban binary BO QUA truong nay, do
     *                 chinh la cho tiet kiem duoc cua delta encoding.
     */
    byte[] encodeMoveApplied(MoveCodec.MoveApplied applied, String fenAfter, String san);

    WireFormat BINARY = new WireFormat() {

        @Override
        public String name() {
            return "binary";
        }

        @Override
        public MoveCodec.Move decodeMove(byte[] payload) {
            return MoveCodec.decodeMove(payload);
        }

        @Override
        public byte[] encodeMove(MoveCodec.Move move) {
            return MoveCodec.encodeMove(move);
        }

        @Override
        public byte[] encodeMoveApplied(MoveCodec.MoveApplied applied, String fenAfter, String san) {
            return MoveCodec.encodeMoveApplied(applied);
        }
    };

    WireFormat JSON = new WireFormat() {

        @Override
        public String name() {
            return "json";
        }

        @Override
        public MoveCodec.Move decodeMove(byte[] payload) {
            JsonNode node = Json.parse(payload);
            String promo = Json.optional(node, "promo", "");
            return new MoveCodec.Move(
                    Json.required(node, "from"),
                    Json.required(node, "to"),
                    promo.isEmpty() ? 0 : MoveCodec.promotionCode(promo.charAt(0)),
                    Json.optionalInt(node, "ply", 0));
        }

        @Override
        public byte[] encodeMove(MoveCodec.Move move) {
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("from", move.from());
            fields.put("to", move.to());
            fields.put("promo", move.promotion() == 0 ? ""
                    : String.valueOf(MoveCodec.promotionLetter(move.promotion())));
            fields.put("ply", move.ply());
            return Json.of(fields);
        }

        @Override
        public byte[] encodeMoveApplied(MoveCodec.MoveApplied applied, String fenAfter, String san) {
            // Baseline co chu dich: gui ca FEN va SAN, khong bat client tu suy ra.
            Map<String, Object> fields = new LinkedHashMap<>();
            fields.put("ply", applied.ply());
            fields.put("from", applied.from());
            fields.put("to", applied.to());
            fields.put("promo", applied.promotion() == 0 ? ""
                    : String.valueOf(MoveCodec.promotionLetter(applied.promotion())));
            fields.put("flags", applied.flags());
            fields.put("clockW", applied.clockWhiteMs());
            fields.put("clockB", applied.clockBlackMs());
            fields.put("tsOff", applied.serverProcessMs());
            fields.put("san", san == null ? "" : san);
            fields.put("fen", fenAfter == null ? "" : fenAfter);
            return Json.of(fields);
        }
    };

    static WireFormat of(String name) {
        if ("json".equalsIgnoreCase(name)) {
            return JSON;
        }
        if ("binary".equalsIgnoreCase(name)) {
            return BINARY;
        }
        throw new IllegalArgumentException("server.format phai la 'binary' hoac 'json', nhan: " + name);
    }
}
