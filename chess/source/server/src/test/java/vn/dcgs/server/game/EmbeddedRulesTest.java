package vn.dcgs.server.game;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import vn.dcgs.common.ErrorCode;
import vn.dcgs.common.MoveCodec;
import vn.dcgs.server.net.RulesEngine;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Kiem chung ban luat co Java dung lam doi chung cho thi nghiem E7.
 *
 * Mot moc doi chung SAI thi con so do duoc cua E7 vo nghia, nen phan nay khong
 * duoc kiem bang vai ván danh thu ma phai bang perft: dem so the co la o tung
 * do sau tu cac the co chuan. Dap an cua chung da duoc cong dong co vua kiem
 * cheo tu lau (Chess Programming Wiki), nen neu bo sinh nuoc di bo sot mot luat
 * hiem - bat tot qua duong khi quan dang bi ghim, nhap thanh khi vua di qua o
 * bi kiem soat - con so lech ngay o do sau 3 hoac 4.
 */
class EmbeddedRulesTest {

    private final EmbeddedRules rules = new EmbeddedRules();

    /** Dem so the co (perft) tu the co ban dau toi do sau 4 va so voi so lieu chuan. */
    @Test
    @DisplayName("perft the co ban dau khop so lieu chuan toi do sau 4")
    void perftFromStart() {
        ChessPosition start = ChessPosition.fromFen(ChessPosition.START_FEN);
        assertEquals(20, start.perft(1));
        assertEquals(400, start.perft(2));
        assertEquals(8_902, start.perft(3));
        assertEquals(197_281, start.perft(4));
    }

    /** Perft the co Kiwipete toi do sau 3 - kiem tra nhap thanh, ghim quan, bat tot qua duong. */
    @Test
    @DisplayName("perft the co Kiwipete - phu nhap thanh, ghim va bat tot qua duong")
    void perftKiwipete() {
        // The co chuan cua Peter McKenzie, duoc dung rong rai vi no chua gan nhu
        // moi truong hop dac biet cung mot luc.
        ChessPosition position = ChessPosition.fromFen(
                "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1");
        assertEquals(48, position.perft(1));
        assertEquals(2_039, position.perft(2));
        assertEquals(97_862, position.perft(3));
    }

    /** Perft the co chuan so 3 toi do sau 4 - kiem tra bay bat tot qua duong va phong cap. */
    @Test
    @DisplayName("perft the co 3 - bay bat tot qua duong va phong cap")
    void perftPosition3() {
        ChessPosition position = ChessPosition.fromFen("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1");
        assertEquals(14, position.perft(1));
        assertEquals(191, position.perft(2));
        assertEquals(2_812, position.perft(3));
        assertEquals(43_238, position.perft(4));
    }

    /** Perft the co chuan so 4 toi do sau 3 - vua bi chieu ngay tu dau. */
    @Test
    @DisplayName("perft the co 4 - vua bi chieu ngay tu dau")
    void perftPosition4() {
        ChessPosition position = ChessPosition.fromFen(
                "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1");
        assertEquals(6, position.perft(1));
        assertEquals(264, position.perft(2));
        assertEquals(9_467, position.perft(3));
    }

    /** Kiem tra nuoc e2-e4 tra ve dung SAN, UCI, trang thai va FEN sau nuoc di. */
    @Test
    @DisplayName("nuoc di thuong tra ve FEN, SAN va co dung")
    void ordinaryMove() {
        RulesEngine.Verdict verdict = rules.validate(ChessPosition.START_FEN, "e2", "e4", "");
        assertTrue(verdict.legal());
        assertEquals("e4", verdict.san());
        assertEquals("e2e4", verdict.uci());
        assertEquals("ongoing", verdict.status());
        assertEquals("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1", verdict.fenAfter());
    }

    /** Kiem tra nuoc di sai luat bi tu choi voi ma 3002. */
    @Test
    @DisplayName("nuoc di sai luat bi tu choi voi ma 3002")
    void illegalMove() {
        RulesEngine.Verdict verdict = rules.validate(ChessPosition.START_FEN, "e2", "e5", "");
        assertFalse(verdict.legal());
        assertEquals(ErrorCode.ILLEGAL_MOVE, verdict.errorCode());
    }

    /** Kiem tra phong cap thieu quan duoc chon bi tu choi (3006), con phong Ma thi hop le. */
    @Test
    @DisplayName("phong cap thieu truong promo bi tu choi voi ma 3006, khong tu chon Hau (X27)")
    void promotionNeedsChoice() {
        String fen = "8/P6k/8/8/8/8/8/K7 w - - 0 1";
        RulesEngine.Verdict missing = rules.validate(fen, "a7", "a8", "");
        assertFalse(missing.legal());
        assertEquals(ErrorCode.PROMOTION_REQUIRED, missing.errorCode());

        RulesEngine.Verdict knight = rules.validate(fen, "a7", "a8", "n");
        assertTrue(knight.legal());
        assertEquals("a8=N", knight.san());
    }

    /** Kiem tra nhan dien chieu het va bat co FLAG_CHECKMATE. */
    @Test
    @DisplayName("chieu het duoc nhan dien va co FLAG_CHECKMATE duoc bat")
    void detectsCheckmate() {
        // Chieu het kieu "thang co": 1.f3 e5 2.g4 Qh4#
        String fen = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2";
        RulesEngine.Verdict verdict = rules.validate(fen, "d8", "h4", "");
        assertTrue(verdict.legal());
        assertEquals("checkmate", verdict.status());
        assertEquals("Qh4#", verdict.san());
        assertTrue((verdict.flags() & MoveCodec.FLAG_CHECKMATE) != 0);
        assertTrue(verdict.endsGame());
    }

    /** Kiem tra nhan dien hoa vi het nuoc (stalemate). */
    @Test
    @DisplayName("het nuoc di ma khong bi chieu la hoa vi het nuoc")
    void detectsStalemate() {
        RulesEngine.Verdict verdict = rules.validate("k7/8/1Q6/8/8/8/8/K7 w - - 0 1", "b6", "c7", "");
        assertEquals("stalemate", verdict.status());
        assertTrue(verdict.endsGame());
    }

    /** Kiem tra nhap thanh canh vua: SAN "O-O", xe di chuyen dung va bat FLAG_CASTLE. */
    @Test
    @DisplayName("nhap thanh sinh dung SAN va di chuyen ca xe")
    void castling() {
        RulesEngine.Verdict verdict = rules.validate(
                "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", "e1", "g1", "");
        assertTrue(verdict.legal());
        assertEquals("O-O", verdict.san());
        assertTrue(verdict.fenAfter().startsWith("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R4RK1"));
        assertTrue((verdict.flags() & MoveCodec.FLAG_CASTLE) != 0);
    }

    /** Kiem tra bat tot qua duong: SAN dung, bat co va xoa dung quan tot bi bat. */
    @Test
    @DisplayName("bat tot qua duong xoa quan o hang cua quan di, khong phai o o den")
    void enPassant() {
        RulesEngine.Verdict verdict = rules.validate(
                "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3", "e5", "f6", "");
        assertTrue(verdict.legal());
        assertEquals("exf6", verdict.san());
        assertTrue((verdict.flags() & MoveCodec.FLAG_EN_PASSANT) != 0);
        // Quan tot den o f5 phai bien mat khoi the co sau.
        assertFalse(verdict.fenAfter().split(" ")[0].contains("3pP"));
    }

    /** Kiem tra xac dinh thieu quan chieu het khi het gio (chi vua, vua+ma, vua+2 ma, vua+xe). */
    @Test
    @DisplayName("het gio ma doi thu chi con vua thi la hoa, khong phai thang (X29)")
    void insufficientMaterialAtTimeout() {
        // Trang chi con vua: khong the chieu het du doi thu het gio.
        assertTrue(rules.insufficientMaterialFor("7k/8/8/8/8/8/8/K7 w - - 0 1", "w"));
        // Vua + mot ma: van khong the ep chieu het.
        assertTrue(rules.insufficientMaterialFor("7k/8/8/8/8/8/8/KN6 w - - 0 1", "w"));
        // Vua + hai ma: theo FIDE la co the chieu het, nen khong tinh la thieu quan.
        assertFalse(rules.insufficientMaterialFor("7k/8/8/8/8/8/8/KNN5 w - - 0 1", "w"));
        // Co xe thi du quan.
        assertFalse(rules.insufficientMaterialFor("7k/8/8/8/8/8/8/KR6 w - - 0 1", "w"));
    }

    /** Kiem tra hoa vi thieu quan duoc nhan dien ngay sau nuoc an quan cuoi. */
    @Test
    @DisplayName("hoa vi thieu quan duoc nhan ngay sau nuoc an quan cuoi cung")
    void drawByInsufficientMaterial() {
        // Trang an not con tot cuoi cung: chi con vua + ma vs vua, khong ben nao chieu het duoc.
        RulesEngine.Verdict verdict = rules.validate("7k/8/8/8/8/8/5p2/K2N4 w - - 0 1", "d1", "f2", "");
        assertTrue(verdict.legal());
        assertEquals("draw_insufficient", verdict.status());
        assertTrue(verdict.endsGame());
    }

    /** Kiem tra SAN them cot xuat phat khi hai ma cung di duoc toi mot o (Nbd2). */
    @Test
    @DisplayName("SAN phan biet duoc hai quan cung loai cung di duoc toi mot o")
    void disambiguation() {
        // Hai ma o b1 va f3 deu di duoc toi d2.
        RulesEngine.Verdict verdict = rules.validate(
                "4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1", "b1", "d2", "");
        assertEquals("Nbd2", verdict.san());
    }
}
