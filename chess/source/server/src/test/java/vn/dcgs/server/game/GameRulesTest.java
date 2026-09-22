package vn.dcgs.server.game;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import vn.dcgs.common.CgpException;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Test cho phan logic thuan cua lop game: Elo, PGN, doc the thuc.
 *
 * Nhung ham nay khong cham mang hay database nen test duoc truc tiep; phan
 * con lai cua GameActor duoc kiem qua bot danh het van (xem source/bot).
 */
class GameRulesTest {

    // ---------------------------------------------------------------- Elo

    @Test
    @DisplayName("Hai nguoi cung Elo: thang duoc +16, thua mat 16")
    void equalRatingsSwapSixteen() {
        int[] deltas = Elo.deltas(1200, 1200, "1-0");
        assertEquals(16, deltas[0]);
        assertEquals(-16, deltas[1]);
    }

    @Test
    @DisplayName("Hai nguoi cung Elo hoa nhau thi khong ai doi diem")
    void equalRatingsDrawKeepsRatings() {
        int[] deltas = Elo.deltas(1500, 1500, "1/2-1/2");
        assertEquals(0, deltas[0]);
        assertEquals(0, deltas[1]);
    }

    @Test
    @DisplayName("Thang nguoi manh hon duoc nhieu diem hon thang nguoi yeu hon")
    void upsetsAreWorthMore() {
        int[] beatStronger = Elo.deltas(1200, 1800, "1-0");
        int[] beatWeaker = Elo.deltas(1800, 1200, "1-0");
        assertTrue(beatStronger[0] > beatWeaker[0],
                "thang nguoi tren co phai duoc nhieu diem hon");
        assertTrue(beatStronger[0] > 25 && beatStronger[0] <= Elo.K);
    }

    @Test
    @DisplayName("Diem ky vong cua hai ben cong lai bang 1")
    void expectationsSumToOne() {
        double white = Elo.expected(1420, 1650);
        double black = Elo.expected(1650, 1420);
        assertEquals(1.0, white + black, 1e-9);
    }

    // ---------------------------------------------------------------- PGN

    @Test
    @DisplayName("PGN co du seven tag roster va ket thuc bang ket qua")
    void pgnHasRequiredTags() {
        String pgn = PgnWriter.write("alice", "bob", "1-0", "checkmate", "300+2",
                List.of("e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"));

        for (String tag : List.of("[Event ", "[Site ", "[Date ", "[Round ",
                "[White \"alice\"]", "[Black \"bob\"]", "[Result \"1-0\"]",
                "[TimeControl \"300+2\"]", "[Termination \"checkmate\"]")) {
            assertTrue(pgn.contains(tag), "thieu " + tag);
        }
        assertTrue(pgn.trim().endsWith("1-0"), "PGN phai ket thuc bang ket qua");
    }

    @Test
    @DisplayName("So thu tu nuoc di danh dung cho ben Trang")
    void pgnNumbersMoves() {
        String pgn = PgnWriter.write("a", "b", "1/2-1/2", "agreement", "60+0",
                List.of("d4", "d5", "c4", "c6"));
        String movetext = pgn.substring(pgn.indexOf("\n\n") + 2).trim();
        assertEquals("1. d4 d5 2. c4 c6 1/2-1/2", movetext);
    }

    @Test
    @DisplayName("Ten nguoi choi co dau nhay duoc thoat, khong lam hong PGN")
    void pgnEscapesQuotes() {
        String pgn = PgnWriter.write("nguoi \"X\"", "b", "0-1", "resign", "60+0", List.of("e4"));
        assertTrue(pgn.contains("[White \"nguoi \\\"X\\\"\"]"));
    }

    @Test
    @DisplayName("Van dai bi xuong dong, khong tao mot dong vo han")
    void pgnWrapsLongGames() {
        List<String> moves = java.util.stream.IntStream.range(0, 120)
                .mapToObj(index -> "Nf3").toList();
        String pgn = PgnWriter.write("a", "b", "1-0", "timeout", "60+0", moves);

        for (String line : pgn.split("\n")) {
            assertTrue(line.length() <= 80, "dong dai qua 80 ky tu: " + line.length());
        }
    }

    // ------------------------------------------------------------ the thuc

    @Test
    @DisplayName("Doc the thuc '300+2' thanh mili giay")
    void parsesTimeControl() {
        assertEquals(300_000, GameService.parseTimeControl("300+2")[0]);
        assertEquals(2_000, GameService.parseTimeControl("300+2")[1]);
        assertEquals(60_000, GameService.parseTimeControl("60+0")[0]);
        assertEquals(0, GameService.parseTimeControl("60+0")[1]);
    }

    @Test
    @DisplayName("The thuc sai dinh dang bi tu choi ngay, khong tao van hong")
    void rejectsMalformedTimeControl() {
        for (String bad : List.of("", "300", "abc+2", "300+", "-5+2", "300+2+1")) {
            assertThrows(CgpException.class, () -> GameService.parseTimeControl(bad),
                    "phai tu choi: '" + bad + "'");
        }
    }
}
