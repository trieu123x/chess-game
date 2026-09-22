package vn.dcgs.common;

/**
 * Ma message cua CGP v1.0 va RVP v1.0.
 *
 * Phai khop tuyet doi voi ban TypeScript o source/web-client/src/net/cgp.ts
 * va voi bang trong chess/PROTOCOL.md §A2, §B.
 */
public final class MsgType {

    private MsgType() {
    }

    // ---------- CGP: client -> server (0x01..0x1F) ----------
    public static final int LOGIN = 0x01;
    public static final int RESUME = 0x02;
    public static final int LOGOUT = 0x03;
    public static final int QUEUE_JOIN = 0x04;
    public static final int QUEUE_LEAVE = 0x05;
    public static final int MOVE = 0x06;
    public static final int RESIGN = 0x07;
    public static final int DRAW_OFFER = 0x08;
    public static final int DRAW_REPLY = 0x09;
    public static final int SPECTATE_JOIN = 0x0A;
    public static final int SPECTATE_LEAVE = 0x0B;
    public static final int HISTORY_REQ = 0x0C;
    public static final int CLOCK_PING = 0x0D;
    public static final int HEARTBEAT = 0x0E;

    // ---------- RVP: server -> rules service (0x20..0x2F) ----------
    public static final int RULES_VALIDATE = 0x20;
    public static final int RULES_LEGAL_MOVES = 0x21;
    public static final int RULES_PING = 0x22;

    // ---------- CGP: server -> client (0x80..0x9F) ----------
    public static final int LOGIN_OK = 0x80;
    public static final int MATCH_FOUND = 0x81;
    public static final int GAME_SNAPSHOT = 0x82;
    public static final int MOVE_APPLIED = 0x83;
    public static final int MOVE_REJECTED = 0x84;
    public static final int CLOCK_PONG = 0x85;
    public static final int GAME_OVER = 0x86;
    public static final int PEER_STATUS = 0x87;
    public static final int DRAW_OFFERED = 0x88;
    public static final int SPECTATOR_COUNT = 0x89;
    public static final int HISTORY_RESULT = 0x8A;
    public static final int HEARTBEAT_ACK = 0x8E;
    public static final int ERROR = 0x8F;

    // ---------- RVP: rules service -> server (0xA0..0xAF) ----------
    public static final int RULES_OK = 0xA0;
    public static final int RULES_ILLEGAL = 0xA1;
    public static final int RULES_LEGAL_MOVES_RESULT = 0xA2;
    public static final int RULES_ERROR = 0xAF;

    /** Ten de ghi log; message la nhi phan nen khong doc duoc neu khong co bang nay. */
    public static String name(int type) {
        return switch (type) {
            case LOGIN -> "LOGIN";
            case RESUME -> "RESUME";
            case LOGOUT -> "LOGOUT";
            case QUEUE_JOIN -> "QUEUE_JOIN";
            case QUEUE_LEAVE -> "QUEUE_LEAVE";
            case MOVE -> "MOVE";
            case RESIGN -> "RESIGN";
            case DRAW_OFFER -> "DRAW_OFFER";
            case DRAW_REPLY -> "DRAW_REPLY";
            case SPECTATE_JOIN -> "SPECTATE_JOIN";
            case SPECTATE_LEAVE -> "SPECTATE_LEAVE";
            case HISTORY_REQ -> "HISTORY_REQ";
            case CLOCK_PING -> "CLOCK_PING";
            case HEARTBEAT -> "HEARTBEAT";
            case RULES_VALIDATE -> "RULES_VALIDATE";
            case RULES_LEGAL_MOVES -> "RULES_LEGAL_MOVES";
            case RULES_PING -> "RULES_PING";
            case LOGIN_OK -> "LOGIN_OK";
            case MATCH_FOUND -> "MATCH_FOUND";
            case GAME_SNAPSHOT -> "GAME_SNAPSHOT";
            case MOVE_APPLIED -> "MOVE_APPLIED";
            case MOVE_REJECTED -> "MOVE_REJECTED";
            case CLOCK_PONG -> "CLOCK_PONG";
            case GAME_OVER -> "GAME_OVER";
            case PEER_STATUS -> "PEER_STATUS";
            case DRAW_OFFERED -> "DRAW_OFFERED";
            case SPECTATOR_COUNT -> "SPECTATOR_COUNT";
            case HISTORY_RESULT -> "HISTORY_RESULT";
            case HEARTBEAT_ACK -> "HEARTBEAT_ACK";
            case ERROR -> "ERROR";
            case RULES_OK -> "RULES_OK";
            case RULES_ILLEGAL -> "RULES_ILLEGAL";
            case RULES_LEGAL_MOVES_RESULT -> "RULES_LEGAL_MOVES_RESULT";
            case RULES_ERROR -> "RULES_ERROR";
            default -> String.format("UNKNOWN(0x%02X)", type);
        };
    }

    /** Message nay chi hop le sau khi da dang nhap? (ngoai le X07 -> ERROR 2005). */
    public static boolean requiresSession(int type) {
        return switch (type) {
            case LOGIN, RESUME, HEARTBEAT, CLOCK_PING -> false;
            default -> type < 0x80;
        };
    }
}
