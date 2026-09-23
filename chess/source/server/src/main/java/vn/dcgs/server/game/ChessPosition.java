package vn.dcgs.server.game;

import java.util.ArrayList;
import java.util.List;

/**
 * Mot the co, va bang luat di kem.
 *
 * **Doc ky truoc khi dung:** he thong that KHONG chay bang lop nay. Luat co cua
 * DCGS do `chess.js` phan xu trong Rules Service (khai bao o README theo
 * `Instruction.md` §4), va do la duong duy nhat duoc dung khi choi.
 *
 * Lop nay ton tai vi thi nghiem E7 can mot moc doi chung: "neu KHONG phai goi
 * sang mot tien trinh khac thi mot nuoc di ton bao nhieu?". Khong co no thi so
 * do cua E7 chi noi duoc rang round-trip mat X ms, chu khong noi duoc X do lon
 * hay nho so voi chinh cong viec kiem tra luat.
 *
 * Vi la doi chung nen no phai DUNG, neu khong thi phep so sanh vo nghia. Bang
 * chung dung la perft: dem so the co la tai moi do sau tu nhung vi tri chuan
 * ma cong dong co vua da co san dap an. Xem {@code EmbeddedRulesTest}.
 *
 * Bieu dien: mang 64 o, index = rank*8 + file, a1 = 0, h8 = 63 - dung quy uoc
 * cua `PROTOCOL.md` §A3 de khong phai doi he toa do o bat ky cho nao.
 */
public final class ChessPosition {

    public static final String START_FEN =
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    /** Mot nuoc di da sinh ra. `promo` la ' ' khi khong phong cap. */
    public record Move(int from, int to, char promo, boolean capture, boolean castle,
                       boolean enPassant) {

        /** Bieu dien nuoc di dang UCI, vi du "e2e4" hoac "e7e8q". */
        public String uci() {
            return square(from) + square(to) + (promo == ' ' ? "" : String.valueOf(promo));
        }
    }

    private final char[] board;
    private final boolean whiteToMove;
    private final boolean castleWhiteKing;
    private final boolean castleWhiteQueen;
    private final boolean castleBlackKing;
    private final boolean castleBlackQueen;
    private final int epSquare;          // -1 neu khong co
    private final int halfmove;
    private final int fullmove;

    /** Tao the co tu mang 64 o va cac thong tin phu (luot di, quyen nhap thanh, o bat tot qua duong, dem nuoc). */
    private ChessPosition(char[] board, boolean whiteToMove,
                          boolean castleWhiteKing, boolean castleWhiteQueen,
                          boolean castleBlackKing, boolean castleBlackQueen,
                          int epSquare, int halfmove, int fullmove) {
        this.board = board;
        this.whiteToMove = whiteToMove;
        this.castleWhiteKing = castleWhiteKing;
        this.castleWhiteQueen = castleWhiteQueen;
        this.castleBlackKing = castleBlackKing;
        this.castleBlackQueen = castleBlackQueen;
        this.epSquare = epSquare;
        this.halfmove = halfmove;
        this.fullmove = fullmove;
    }

    // ------------------------------------------------------------------ FEN

    /** Doc chuoi FEN thanh the co; FEN thieu truong hoac tran ban co thi nem IllegalArgumentException. */
    public static ChessPosition fromFen(String fen) {
        String[] parts = fen.trim().split("\\s+");
        if (parts.length < 4) {
            throw new IllegalArgumentException("FEN thieu truong: " + fen);
        }
        char[] squares = new char[64];
        java.util.Arrays.fill(squares, ' ');

        int rank = 7;
        int file = 0;
        for (char symbol : parts[0].toCharArray()) {
            if (symbol == '/') {
                rank--;
                file = 0;
            } else if (symbol >= '1' && symbol <= '8') {
                file += symbol - '0';
            } else {
                if (rank < 0 || file > 7) {
                    throw new IllegalArgumentException("FEN tran ban co: " + fen);
                }
                squares[rank * 8 + file] = symbol;
                file++;
            }
        }

        String rights = parts[2];
        int ep = "-".equals(parts[3]) ? -1 : index(parts[3]);
        int half = parts.length > 4 ? parseOr(parts[4], 0) : 0;
        int full = parts.length > 5 ? parseOr(parts[5], 1) : 1;

        return new ChessPosition(squares, "w".equals(parts[1]),
                rights.indexOf('K') >= 0, rights.indexOf('Q') >= 0,
                rights.indexOf('k') >= 0, rights.indexOf('q') >= 0,
                ep, half, full);
    }

    /** Doi chuoi thanh so nguyen; khong phai so thi tra ve gia tri mac dinh. */
    private static int parseOr(String value, int fallback) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException notANumber) {
            return fallback;
        }
    }

    /** Xuat the co hien tai thanh chuoi FEN day du 6 truong. */
    public String toFen() {
        StringBuilder out = new StringBuilder(80);
        for (int rank = 7; rank >= 0; rank--) {
            int empty = 0;
            for (int file = 0; file < 8; file++) {
                char piece = board[rank * 8 + file];
                if (piece == ' ') {
                    empty++;
                    continue;
                }
                if (empty > 0) {
                    out.append(empty);
                    empty = 0;
                }
                out.append(piece);
            }
            if (empty > 0) {
                out.append(empty);
            }
            if (rank > 0) {
                out.append('/');
            }
        }
        out.append(whiteToMove ? " w " : " b ");

        String rights = (castleWhiteKing ? "K" : "") + (castleWhiteQueen ? "Q" : "")
                + (castleBlackKing ? "k" : "") + (castleBlackQueen ? "q" : "");
        out.append(rights.isEmpty() ? "-" : rights);
        out.append(' ').append(epSquare < 0 ? "-" : square(epSquare));
        out.append(' ').append(halfmove).append(' ').append(fullmove);
        return out.toString();
    }

    /** Co phai luot cua ben Trang khong. */
    public boolean whiteToMove() {
        return whiteToMove;
    }

    /** So nua nuoc tu lan an quan hoac di tot gan nhat (dung cho luat 50 nuoc). */
    public int halfmove() {
        return halfmove;
    }

    // ------------------------------------------------------------- toa do o

    /** Chi so o 0..63 -> ten o co (vi du 12 -> "e2"). */
    public static String square(int index) {
        return "" + (char) ('a' + index % 8) + (char) ('1' + index / 8);
    }

    /** Ten o co -> chi so 0..63 (vi du "e2" -> 12); sai dinh dang thi nem IllegalArgumentException. */
    public static int index(String square) {
        if (square == null || square.length() != 2) {
            throw new IllegalArgumentException("o co khong hop le: " + square);
        }
        int file = square.charAt(0) - 'a';
        int rank = square.charAt(1) - '1';
        if (file < 0 || file > 7 || rank < 0 || rank > 7) {
            throw new IllegalArgumentException("o co khong hop le: " + square);
        }
        return rank * 8 + file;
    }

    /** Quan nay co phai quan Trang khong (chu hoa la Trang). */
    private static boolean isWhite(char piece) {
        return piece >= 'A' && piece <= 'Z';
    }

    /** Quan nay co phai cua ben dang toi luot khong. */
    private boolean mine(char piece) {
        return piece != ' ' && isWhite(piece) == whiteToMove;
    }

    /** Quan nay co phai cua ben doi phuong khong. */
    private boolean theirs(char piece) {
        return piece != ' ' && isWhite(piece) != whiteToMove;
    }

    /** Tra ve ky tu quan tai o `index` (' ' neu o trong). */
    public char pieceAt(int index) {
        return board[index];
    }

    // ------------------------------------------------------------ sinh nuoc di

    private static final int[][] KNIGHT = {
            {1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}};
    private static final int[][] KING = {
            {1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1}};
    private static final int[][] ROOK_DIRS = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
    private static final int[][] BISHOP_DIRS = {{1, 1}, {1, -1}, {-1, 1}, {-1, -1}};
    private static final char[] PROMO_PIECES = {'q', 'r', 'b', 'n'};

    /** Nuoc di hop le that su: da loc nhung nuoc de vua cua chinh minh bi an. */
    public List<Move> legalMoves() {
        List<Move> legal = new ArrayList<>(40);
        for (Move move : pseudoLegalMoves()) {
            ChessPosition after = applyUnchecked(move);
            if (!after.kingAttacked(whiteToMove)) {
                legal.add(move);
            }
        }
        return legal;
    }

    /** Sinh moi nuoc di theo cach di cua quan, chua loc nuoc de vua minh bi chieu. */
    private List<Move> pseudoLegalMoves() {
        List<Move> moves = new ArrayList<>(48);
        for (int from = 0; from < 64; from++) {
            char piece = board[from];
            if (!mine(piece)) {
                continue;
            }
            switch (Character.toUpperCase(piece)) {
                case 'P' -> pawnMoves(from, moves);
                case 'N' -> stepMoves(from, KNIGHT, moves);
                case 'B' -> slideMoves(from, BISHOP_DIRS, moves);
                case 'R' -> slideMoves(from, ROOK_DIRS, moves);
                case 'Q' -> {
                    slideMoves(from, ROOK_DIRS, moves);
                    slideMoves(from, BISHOP_DIRS, moves);
                }
                case 'K' -> {
                    stepMoves(from, KING, moves);
                    castlingMoves(from, moves);
                }
                default -> throw new IllegalArgumentException("quan la trong FEN: " + piece);
            }
        }
        return moves;
    }

    /** Sinh nuoc di cua tot: tien 1 o, tien 2 o tu hang xuat phat, an cheo va bat tot qua duong. */
    private void pawnMoves(int from, List<Move> moves) {
        int file = from % 8;
        int rank = from / 8;
        int step = whiteToMove ? 1 : -1;
        int promoRank = whiteToMove ? 7 : 0;
        int startRank = whiteToMove ? 1 : 6;

        int ahead = (rank + step) * 8 + file;
        if (rank + step >= 0 && rank + step <= 7 && board[ahead] == ' ') {
            addPawnMove(from, ahead, false, false, promoRank, moves);
            int twoAhead = (rank + 2 * step) * 8 + file;
            if (rank == startRank && board[twoAhead] == ' ') {
                moves.add(new Move(from, twoAhead, ' ', false, false, false));
            }
        }
        for (int side = -1; side <= 1; side += 2) {
            int targetFile = file + side;
            if (targetFile < 0 || targetFile > 7 || rank + step < 0 || rank + step > 7) {
                continue;
            }
            int target = (rank + step) * 8 + targetFile;
            if (theirs(board[target])) {
                addPawnMove(from, target, true, false, promoRank, moves);
            } else if (target == epSquare && board[target] == ' ') {
                // Bat tot qua duong: quan bi an KHONG nam o o den.
                moves.add(new Move(from, target, ' ', true, false, true));
            }
        }
    }

    /** Them nuoc di cua tot; neu toi hang cuoi thi sinh du 4 lua chon phong cap (q, r, b, n). */
    private void addPawnMove(int from, int to, boolean capture, boolean castle,
                             int promoRank, List<Move> moves) {
        if (to / 8 == promoRank) {
            for (char promo : PROMO_PIECES) {
                moves.add(new Move(from, to, promo, capture, castle, false));
            }
        } else {
            moves.add(new Move(from, to, ' ', capture, castle, false));
        }
    }

    /** Sinh nuoc di cho quan di tung buoc (Ma, Vua) theo danh sach do lech. */
    private void stepMoves(int from, int[][] deltas, List<Move> moves) {
        int file = from % 8;
        int rank = from / 8;
        for (int[] delta : deltas) {
            int targetFile = file + delta[0];
            int targetRank = rank + delta[1];
            if (targetFile < 0 || targetFile > 7 || targetRank < 0 || targetRank > 7) {
                continue;
            }
            int to = targetRank * 8 + targetFile;
            if (mine(board[to])) {
                continue;
            }
            moves.add(new Move(from, to, ' ', board[to] != ' ', false, false));
        }
    }

    /** Sinh nuoc di cho quan truot (Xe, Tuong, Hau) theo tung huong cho toi khi bi chan. */
    private void slideMoves(int from, int[][] dirs, List<Move> moves) {
        int file = from % 8;
        int rank = from / 8;
        for (int[] dir : dirs) {
            int targetFile = file;
            int targetRank = rank;
            for (;;) {
                targetFile += dir[0];
                targetRank += dir[1];
                if (targetFile < 0 || targetFile > 7 || targetRank < 0 || targetRank > 7) {
                    break;
                }
                int to = targetRank * 8 + targetFile;
                if (mine(board[to])) {
                    break;
                }
                moves.add(new Move(from, to, ' ', board[to] != ' ', false, false));
                if (board[to] != ' ') {
                    break;                     // an quan roi thi dung, khong xuyen qua
                }
            }
        }
    }

    /**
     * Nhap thanh.
     *
     * Ba dieu kien deu phai kiem, va bo sot dieu kien thu ba la loi kinh dien:
     * vua khong duoc DI QUA o dang bi kiem soat, chu khong chi la o den.
     */
    private void castlingMoves(int from, List<Move> moves) {
        int homeSquare = whiteToMove ? 4 : 60;
        if (from != homeSquare || kingAttacked(whiteToMove)) {
            return;
        }
        boolean kingSide = whiteToMove ? castleWhiteKing : castleBlackKing;
        boolean queenSide = whiteToMove ? castleWhiteQueen : castleBlackQueen;

        if (kingSide && board[homeSquare + 1] == ' ' && board[homeSquare + 2] == ' '
                && !attacked(homeSquare + 1, !whiteToMove)
                && !attacked(homeSquare + 2, !whiteToMove)) {
            moves.add(new Move(from, homeSquare + 2, ' ', false, true, false));
        }
        if (queenSide && board[homeSquare - 1] == ' ' && board[homeSquare - 2] == ' '
                && board[homeSquare - 3] == ' '
                && !attacked(homeSquare - 1, !whiteToMove)
                && !attacked(homeSquare - 2, !whiteToMove)) {
            moves.add(new Move(from, homeSquare - 2, ' ', false, true, false));
        }
    }

    // --------------------------------------------------------------- chieu

    /** Ben dang toi luot co dang bi chieu khong. */
    public boolean inCheck() {
        return kingAttacked(whiteToMove);
    }

    /** Vua cua ben chi dinh co dang bi tan cong khong. */
    private boolean kingAttacked(boolean whiteKing) {
        char king = whiteKing ? 'K' : 'k';
        for (int index = 0; index < 64; index++) {
            if (board[index] == king) {
                return attacked(index, !whiteKing);
            }
        }
        return false;                       // khong co vua: chi gap o the co dung de test
    }

    /** O `target` co bi ben `byWhite` kiem soat khong? */
    private boolean attacked(int target, boolean byWhite) {
        int file = target % 8;
        int rank = target / 8;

        // Tot: quan tot cua ben tan cong nam o phia DUOI o bi tan cong (voi Trang).
        int pawnRank = rank + (byWhite ? -1 : 1);
        if (pawnRank >= 0 && pawnRank <= 7) {
            char pawn = byWhite ? 'P' : 'p';
            for (int side = -1; side <= 1; side += 2) {
                int pawnFile = file + side;
                if (pawnFile >= 0 && pawnFile <= 7 && board[pawnRank * 8 + pawnFile] == pawn) {
                    return true;
                }
            }
        }
        if (stepAttack(file, rank, KNIGHT, byWhite ? 'N' : 'n')) {
            return true;
        }
        if (stepAttack(file, rank, KING, byWhite ? 'K' : 'k')) {
            return true;
        }
        if (slideAttack(file, rank, ROOK_DIRS, byWhite ? 'R' : 'r', byWhite ? 'Q' : 'q')) {
            return true;
        }
        return slideAttack(file, rank, BISHOP_DIRS, byWhite ? 'B' : 'b', byWhite ? 'Q' : 'q');
    }

    /** Kiem tra co quan `piece` (Ma/Vua) dung o vi tri cach o dich mot buoc theo `deltas` khong. */
    private boolean stepAttack(int file, int rank, int[][] deltas, char piece) {
        for (int[] delta : deltas) {
            int targetFile = file + delta[0];
            int targetRank = rank + delta[1];
            if (targetFile < 0 || targetFile > 7 || targetRank < 0 || targetRank > 7) {
                continue;
            }
            if (board[targetRank * 8 + targetFile] == piece) {
                return true;
            }
        }
        return false;
    }

    /** Kiem tra theo tung huong: quan dau tien gap phai co phai `piece` hoac Hau khong. */
    private boolean slideAttack(int file, int rank, int[][] dirs, char piece, char queen) {
        for (int[] dir : dirs) {
            int targetFile = file;
            int targetRank = rank;
            for (;;) {
                targetFile += dir[0];
                targetRank += dir[1];
                if (targetFile < 0 || targetFile > 7 || targetRank < 0 || targetRank > 7) {
                    break;
                }
                char found = board[targetRank * 8 + targetFile];
                if (found == ' ') {
                    continue;
                }
                if (found == piece || found == queen) {
                    return true;
                }
                break;             // quan dau tien chan huong nay: thoi, sang huong khac
            }
        }
        return false;
    }

    // ------------------------------------------------------------- di nuoc co

    /** Ap dung nuoc di. Khong kiem tra tinh hop le - dung sau khi da loc. */
    public ChessPosition applyUnchecked(Move move) {
        char[] next = board.clone();
        char piece = next[move.from()];
        boolean pawn = Character.toUpperCase(piece) == 'P';
        boolean capture = next[move.to()] != ' ' || move.enPassant();

        next[move.from()] = ' ';
        next[move.to()] = move.promo() == ' ' ? piece
                : (isWhite(piece) ? Character.toUpperCase(move.promo()) : move.promo());

        if (move.enPassant()) {
            // Quan bi an dung o hang cua quan di, khong phai o o den.
            next[(move.from() / 8) * 8 + move.to() % 8] = ' ';
        }
        if (move.castle()) {
            int rank = move.to() / 8;
            if (move.to() % 8 == 6) {                      // canh vua
                next[rank * 8 + 5] = next[rank * 8 + 7];
                next[rank * 8 + 7] = ' ';
            } else {                                       // canh hau
                next[rank * 8 + 3] = next[rank * 8];
                next[rank * 8] = ' ';
            }
        }

        boolean wk = castleWhiteKing;
        boolean wq = castleWhiteQueen;
        boolean bk = castleBlackKing;
        boolean bq = castleBlackQueen;
        // Vua di (ke ca nhap thanh) -> mat ca hai quyen; xe roi o goc, hoac xe bi
        // an ngay tai goc -> mat quyen ben do.
        switch (piece) {
            case 'K' -> {
                wk = false;
                wq = false;
            }
            case 'k' -> {
                bk = false;
                bq = false;
            }
            default -> {
                // khong doi
            }
        }
        for (int corner : new int[] {move.from(), move.to()}) {
            switch (corner) {
                case 0 -> wq = false;
                case 7 -> wk = false;
                case 56 -> bq = false;
                case 63 -> bk = false;
                default -> {
                    // khong phai o goc
                }
            }
        }

        int nextEp = -1;
        if (pawn && Math.abs(move.to() / 8 - move.from() / 8) == 2) {
            nextEp = (move.from() / 8 + move.to() / 8) / 2 * 8 + move.from() % 8;
        }
        int nextHalfmove = (pawn || capture) ? 0 : halfmove + 1;
        int nextFullmove = whiteToMove ? fullmove : fullmove + 1;

        return new ChessPosition(next, !whiteToMove, wk, wq, bk, bq,
                nextEp, nextHalfmove, nextFullmove);
    }

    // ------------------------------------------------------------------ SAN

    /** Ky hieu dai so rut gon, co phan biet khi hai quan cung loai cung di duoc. */
    public String toSan(Move move, ChessPosition after) {
        if (move.castle()) {
            String base = move.to() % 8 == 6 ? "O-O" : "O-O-O";
            return base + checkSuffix(after);
        }
        char piece = Character.toUpperCase(board[move.from()]);
        StringBuilder san = new StringBuilder(8);

        if (piece == 'P') {
            if (move.capture()) {
                san.append((char) ('a' + move.from() % 8)).append('x');
            }
            san.append(square(move.to()));
            if (move.promo() != ' ') {
                san.append('=').append(Character.toUpperCase(move.promo()));
            }
        } else {
            san.append(piece).append(disambiguate(move, piece));
            if (move.capture()) {
                san.append('x');
            }
            san.append(square(move.to()));
        }
        return san.append(checkSuffix(after)).toString();
    }

    /** Tim phan phan biet trong SAN (cot, hang hoac ca o) khi co quan cung loai khac cung di toi o dich. */
    private String disambiguate(Move move, char piece) {
        List<Move> rivals = new ArrayList<>(2);
        for (Move other : legalMoves()) {
            if (other.from() != move.from() && other.to() == move.to()
                    && Character.toUpperCase(board[other.from()]) == piece) {
                rivals.add(other);
            }
        }
        if (rivals.isEmpty()) {
            return "";
        }
        boolean sameFile = false;
        boolean sameRank = false;
        for (Move rival : rivals) {
            if (rival.from() % 8 == move.from() % 8) {
                sameFile = true;
            }
            if (rival.from() / 8 == move.from() / 8) {
                sameRank = true;
            }
        }
        if (!sameFile) {
            return String.valueOf((char) ('a' + move.from() % 8));
        }
        if (!sameRank) {
            return String.valueOf((char) ('1' + move.from() / 8));
        }
        return square(move.from());
    }

    /** Hau to SAN sau nuoc di: "#" neu chieu het, "+" neu chieu, rong neu khong. */
    private static String checkSuffix(ChessPosition after) {
        if (!after.inCheck()) {
            return "";
        }
        return after.legalMoves().isEmpty() ? "#" : "+";
    }

    // --------------------------------------------------------- ket thuc van

    /**
     * Ben `white` co du quan de chieu het khong?
     *
     * Dung luat ma FIDE ap cho truong hop het gio (X29): chi con vua, vua + 1
     * tinh, hoac vua + 1 ma thi KHONG the chieu het. Hai ma thi co the (khong
     * ep duoc, nhung van co the), nen khong tinh la thieu quan.
     */
    public boolean canMate(boolean white) {
        int minors = 0;
        for (char piece : board) {
            if (piece == ' ' || isWhite(piece) != white) {
                continue;
            }
            switch (Character.toUpperCase(piece)) {
                case 'P', 'R', 'Q' -> {
                    return true;
                }
                case 'B', 'N' -> minors++;
                default -> {
                    // vua
                }
            }
        }
        return minors >= 2;
    }

    /** Hoa vi ca hai ben deu khong du quan, ke ca hai tinh cung mau o. */
    public boolean insufficientMaterial() {
        int whiteMinors = 0;
        int blackMinors = 0;
        int bishops = 0;
        int bishopSquareColor = -1;
        boolean bishopsSameColor = true;

        for (int index = 0; index < 64; index++) {
            char piece = board[index];
            if (piece == ' ') {
                continue;
            }
            switch (Character.toUpperCase(piece)) {
                case 'P', 'R', 'Q' -> {
                    return false;
                }
                case 'B' -> {
                    bishops++;
                    int color = (index / 8 + index % 8) % 2;
                    if (bishopSquareColor < 0) {
                        bishopSquareColor = color;
                    } else if (bishopSquareColor != color) {
                        bishopsSameColor = false;
                    }
                    if (isWhite(piece)) {
                        whiteMinors++;
                    } else {
                        blackMinors++;
                    }
                }
                case 'N' -> {
                    if (isWhite(piece)) {
                        whiteMinors++;
                    } else {
                        blackMinors++;
                    }
                }
                default -> {
                    // vua
                }
            }
        }
        if (whiteMinors + blackMinors <= 1) {
            return true;                    // K-K, K+quan nhe vs K
        }
        // Chi con tinh, va tat ca deu cung mau o -> khong ben nao chieu het duoc.
        return bishops == whiteMinors + blackMinors && bishopsSameColor;
    }

    /**
     * Trang thai sau khi nuoc di da duoc ap dung, dung bo gia tri cua
     * `PROTOCOL.md` §B.
     *
     * Khong tra `draw_threefold`: mot the co roi rac khong mang lich su van dau,
     * nen tu mot FEN khong the biet the co da lap ba lan hay chua. Ban remote
     * (chess.js nap tu FEN) cung o dung hoan canh do - han che nay duoc ghi o
     * muc Limitations chu khong duoc giau di.
     */
    public String status() {
        boolean noMoves = legalMoves().isEmpty();
        if (noMoves) {
            return inCheck() ? "checkmate" : "stalemate";
        }
        if (insufficientMaterial()) {
            return "draw_insufficient";
        }
        if (halfmove >= 100) {
            return "draw_fifty";
        }
        return inCheck() ? "check" : "ongoing";
    }

    // ---------------------------------------------------------------- perft

    /**
     * Dem so the co la o do sau `depth`.
     *
     * Day la phep kiem tra chuan cua mot bo sinh nuoc di: chi can sai mot luat
     * hiem (bat tot qua duong khi dang bi ghim, nhap thanh qua o bi kiem soat)
     * la con so lech ngay. Dap an cua cac the co chuan da co san.
     */
    public long perft(int depth) {
        if (depth == 0) {
            return 1;
        }
        List<Move> moves = legalMoves();
        if (depth == 1) {
            return moves.size();
        }
        long total = 0;
        for (Move move : moves) {
            total += applyUnchecked(move).perft(depth - 1);
        }
        return total;
    }
}
