package vn.dcgs.server.game;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.List;

/**
 * Xuat bien ban PGN theo chuan seven tag roster.
 *
 * PGN la dinh dang ma moi phan mem co deu doc duoc, nen mot van luu o day co
 * the mo lai bang lichess hay SCID de kiem chung - huu ich khi bao ve: khong
 * phai tin loi nhom noi rang van dau da dien ra dung.
 */
public final class PgnWriter {

    private static final DateTimeFormatter PGN_DATE = DateTimeFormatter.ofPattern("yyyy.MM.dd");
    private static final int LINE_WIDTH = 80;

    /** Lop tien ich, khong cho tao instance. */
    private PgnWriter() {
    }

    /** Tao chuoi PGN day du: cac tag header (nguoi choi, ket qua, ly do...) va danh sach nuoc di SAN, ngat dong o 80 ky tu. */
    public static String write(String white, String black, String result, String reason,
                               String timeControl, List<String> sanMoves) {
        StringBuilder pgn = new StringBuilder();
        pgn.append("[Event \"DCGS online\"]\n");
        pgn.append("[Site \"DCGS\"]\n");
        pgn.append("[Date \"").append(LocalDate.now().format(PGN_DATE)).append("\"]\n");
        pgn.append("[Round \"-\"]\n");
        pgn.append("[White \"").append(escape(white)).append("\"]\n");
        pgn.append("[Black \"").append(escape(black)).append("\"]\n");
        pgn.append("[Result \"").append(result).append("\"]\n");
        pgn.append("[TimeControl \"").append(timeControl).append("\"]\n");
        pgn.append("[Termination \"").append(escape(reason)).append("\"]\n\n");

        StringBuilder line = new StringBuilder();
        for (int index = 0; index < sanMoves.size(); index++) {
            String token = (index % 2 == 0 ? (index / 2 + 1) + ". " : "") + sanMoves.get(index);
            if (line.length() + token.length() + 1 > LINE_WIDTH) {
                pgn.append(line).append('\n');
                line.setLength(0);
            }
            if (line.length() > 0) {
                line.append(' ');
            }
            line.append(token);
        }
        if (line.length() + result.length() + 1 > LINE_WIDTH) {
            pgn.append(line).append('\n');
            line.setLength(0);
        }
        if (line.length() > 0) {
            line.append(' ');
        }
        line.append(result);
        pgn.append(line).append('\n');
        return pgn.toString();
    }

    /** Escape dau \ va dau nhay kep trong gia tri tag PGN; null thi thay bang "?". */
    private static String escape(String value) {
        return value == null ? "?" : value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
