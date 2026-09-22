package vn.dcgs.client;

import vn.dcgs.common.FrameCodec;
import vn.dcgs.common.MoveCodec;
import vn.dcgs.common.MsgType;

/**
 * Client TCP thuan, khong giao dien.
 *
 * Vai tro trong do an: chung minh giao tiep socket truc tiep voi Game Server
 * (khong qua WebSocket gateway) va lam mot dau do cho thi nghiem E8 - so sanh
 * overhead giua TCP thuan va WebSocket.
 *
 * Phan ket noi se duoc viet cung voi lop mang cua server (PLAN.md tuan 1-2).
 */
public final class Main {

    public static void main(String[] args) {
        System.out.println("=== DCGS CLI Client ===");
        System.out.println("Codec CGP san sang:");
        System.out.println("  HEARTBEAT     = " + FrameCodec.encode(MsgType.HEARTBEAT, 1).remaining() + " byte");
        System.out.println("  MOVE e2e4     = " + (4 + 5 + MoveCodec.MOVE_SIZE) + " byte tren duong day");
        System.out.println("  MOVE_APPLIED  = " + (4 + 5 + MoveCodec.MOVE_APPLIED_SIZE) + " byte tren duong day");
        System.out.println();
        System.out.println("Lop ket noi chua duoc trien khai - xem PLAN.md tuan 1-2.");
    }
}
