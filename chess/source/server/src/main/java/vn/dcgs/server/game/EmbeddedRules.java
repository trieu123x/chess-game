package vn.dcgs.server.game;

import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.MoveCodec;
import vn.dcgs.server.net.RulesEngine;

import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Ban luat co chay NGAY TRONG server - doi chung cua thi nghiem E7.
 *
 * Bat bang `rules.mode=embedded`. Khi do khong con RVP, khong con round-trip,
 * khong con pool va cache: mot nuoc di chi mat dung thoi gian tinh toan luat.
 * Hieu so giua che do nay va che do `remote` chinh la cai gia phai tra cho viec
 * tach rules service ra thanh dich vu rieng - va do la con so ma dong gop N3
 * phai chung minh la dang tra.
 *
 * He thong that chay o `rules.mode=remote` voi chess.js. Xem {@link ChessPosition}
 * de biet vi sao ban Java nay ton tai va no duoc kiem chung bang gi.
 */
public final class EmbeddedRules implements RulesEngine {

    private final AtomicLong validated = new AtomicLong();
    private final AtomicLong illegal = new AtomicLong();

    /** Kiem tra nuoc di from->to (kem quan phong cap) tren the co FEN; hop le thi tra ve FEN moi, SAN, UCI, flags va trang thai van. */
    @Override
    public Verdict validate(String fen, String from, String to, String promotion) {
        ChessPosition position;
        try {
            position = ChessPosition.fromFen(fen);
        } catch (RuntimeException badFen) {
            return Verdict.illegal(ErrorCode.MALFORMED_FRAME, "FEN khong doc duoc: " + badFen.getMessage());
        }

        int fromIndex;
        int toIndex;
        try {
            fromIndex = ChessPosition.index(from);
            toIndex = ChessPosition.index(to);
        } catch (RuntimeException badSquare) {
            return Verdict.illegal(ErrorCode.MALFORMED_FRAME, badSquare.getMessage());
        }

        // Phong cap ma thieu `promo`: KHONG duoc tu mac dinh thanh Hau, vi co
        // nguoi muon phong Ma de chieu het (X27). Bat client chon lai.
        char piece = position.pieceAt(fromIndex);
        boolean pawn = Character.toUpperCase(piece) == 'P';
        int targetRank = toIndex / 8;
        if (pawn && (targetRank == 7 || targetRank == 0) && promotion.isEmpty()) {
            illegal.incrementAndGet();
            return Verdict.illegal(ErrorCode.PROMOTION_REQUIRED, "thieu quan phong cap");
        }

        char promo = promotion.isEmpty() ? ' ' : Character.toLowerCase(promotion.charAt(0));
        ChessPosition.Move chosen = null;
        for (ChessPosition.Move candidate : position.legalMoves()) {
            if (candidate.from() == fromIndex && candidate.to() == toIndex
                    && candidate.promo() == promo) {
                chosen = candidate;
                break;
            }
        }
        if (chosen == null) {
            illegal.incrementAndGet();
            return Verdict.illegal(ErrorCode.ILLEGAL_MOVE, "nuoc di khong hop le voi the co nay");
        }

        ChessPosition after = position.applyUnchecked(chosen);
        String san = position.toSan(chosen, after);
        String status = after.status();
        validated.incrementAndGet();

        return new Verdict(true, after.toFen(), san, chosen.uci(),
                flagsOf(chosen, san, status), status, 0, null);
    }

    /** Dung byte `flags` cua MOVE_APPLIED - phai khop voi ban o `common-js/cgp.js`. */
    private static int flagsOf(ChessPosition.Move move, String san, String status) {
        int flags = 0;
        if (move.capture()) {
            flags |= MoveCodec.FLAG_CAPTURE;
        }
        if (move.castle()) {
            flags |= MoveCodec.FLAG_CASTLE;
        }
        if (move.enPassant()) {
            flags |= MoveCodec.FLAG_EN_PASSANT;
        }
        if (move.promo() != ' ') {
            flags |= MoveCodec.FLAG_PROMOTION;
        }
        if (san.indexOf('+') >= 0 || "check".equals(status)) {
            flags |= MoveCodec.FLAG_CHECK;
        }
        if (san.indexOf('#') >= 0 || "checkmate".equals(status)) {
            // Chieu het cung la chieu: client chi nhin flags de phat am thanh.
            flags |= MoveCodec.FLAG_CHECK | MoveCodec.FLAG_CHECKMATE;
        }
        if ("stalemate".equals(status) || status.startsWith("draw")) {
            flags |= MoveCodec.FLAG_DRAW;
        }
        return flags;
    }

    /** Kiem tra ben `side` ("w"/"b") co KHONG du quan de chieu het hay khong. */
    @Override
    public boolean insufficientMaterialFor(String fen, String side) {
        return !ChessPosition.fromFen(fen).canMate("w".equals(side));
    }

    /** Chay trong chinh tien trinh nay: khong co gi de mat ket noi ca. */
    @Override
    public boolean available() {
        return true;
    }

    /** Liet ke moi nuoc di hop le (dang UCI) cua the co FEN. */
    public List<String> legalMoves(String fen) {
        return ChessPosition.fromFen(fen).legalMoves().stream()
                .map(ChessPosition.Move::uci).toList();
    }

    /** Tra ve thong ke so nuoc hop le / bi tu choi da kiem tra. */
    @Override
    public String stats() {
        return String.format("embedded (doi chung E7): %d nuoc hop le, %d nuoc bi tu choi",
                validated.get(), illegal.get());
    }

    /** Dong engine; ban embedded khong giu tai nguyen nen khong lam gi. */
    @Override
    public void close() {
        // Khong co tai nguyen ngoai.
    }
}
