# Protocol Specification – CGP v1.0 & RVP v1.0

Đặc tả này là **hợp đồng giữa 4 thành viên**: SV1 chốt file này trong tuần 1, mọi người code theo.
Mọi thay đổi sau khi chốt phải tăng `PROTOCOL_VERSION` và ghi vào mục Changelog cuối file.

Phục vụ mục 5.3 (`README.md`) và mục 8.9 (`Instruction.md`).

---

# Phần A – CGP (Chess Game Protocol), client ↔ server

## A1. Khung truyền (framing)

TCP là stream, không có ranh giới message → tự đóng khung theo độ dài:

```text
 byte:  0      3 4      5          8 9                          LEN+3
       ┌────────┬────────┬───────────┬───────────────────────────┐
       │ LEN u32│ TYPE u8│  SEQ u32  │        PAYLOAD            │
       └────────┴────────┴───────────┴───────────────────────────┘
       │◄──4───►│◄──1───►│◄────4────►│◄───── LEN - 5 bytes ─────►│

LEN   = 5 + payload.length  (big-endian, KHÔNG tính chính 4 byte LEN)
TYPE  = mã message (bảng A2)
SEQ   = số thứ tự tăng dần của bên gửi; response echo lại SEQ của request
```

* Byte order: **big-endian** (network byte order) cho mọi số nguyên.
* `LEN > 65536` → `ERROR 2003` và đóng kết nối (chống tấn công cạn RAM).
* Bộ giải mã phải xử lý được **half-packet** (một message đến làm nhiều lần đọc) và **gộp packet** (nhiều message trong một lần đọc). Đây là test case bắt buộc của SV1.
* Cùng một chuỗi byte này được mang nguyên vẹn trong WebSocket binary frame cho client trình duyệt.

## A2. Bảng message

### Client → Server (0x01–0x1F)

| TYPE | Tên | Payload | Ghi chú |
| --- | --- | --- | --- |
| 0x01 | LOGIN | JSON `{username, password}` | |
| 0x02 | RESUME | JSON `{sessionToken, lastPly}` | nối lại sau mất kết nối |
| 0x03 | LOGOUT | rỗng | |
| 0x04 | QUEUE_JOIN | JSON `{timeControl:"300+2"}` | vào hàng đợi ghép cặp |
| 0x05 | QUEUE_LEAVE | rỗng | |
| 0x06 | MOVE | **binary 8 byte** (A3) | nước đi |
| 0x07 | RESIGN | rỗng | |
| 0x08 | DRAW_OFFER | rỗng | |
| 0x09 | DRAW_REPLY | 1 byte: 0=từ chối, 1=đồng ý | |
| 0x0A | SPECTATE_JOIN | JSON `{gameId}` | |
| 0x0B | SPECTATE_LEAVE | JSON `{gameId}` | |
| 0x0C | HISTORY_REQ | JSON `{gameId}` | xem lại ván |
| 0x0D | CLOCK_PING | **binary 8 byte**: `t1 u64` | t1 = đồng hồ client (ms) |
| 0x0E | HEARTBEAT | rỗng | gửi mỗi 5 s |

### Server → Client (0x80–0x9F)

| TYPE | Tên | Payload | Ghi chú |
| --- | --- | --- | --- |
| 0x80 | LOGIN_OK | JSON `{sessionToken, userId, username, elo}` | |
| 0x81 | MATCH_FOUND | JSON `{gameId, color:"w"/"b", opponent, oppElo, timeControl}` | |
| 0x82 | GAME_SNAPSHOT | JSON `{gameId, fen, ply, moves[], clockW, clockB, turn, status}` | dùng khi RESUME / spectate |
| 0x83 | MOVE_APPLIED | **binary 16 byte** (A4) | delta – message nóng nhất |
| 0x84 | MOVE_REJECTED | JSON `{code, reason, expectedPly}` | |
| 0x85 | CLOCK_PONG | **binary 24 byte**: `t1 u64, t2 u64, t3 u64` | t2 = server nhận, t3 = server gửi |
| 0x86 | GAME_OVER | JSON `{result, reason, eloDelta, pgn}` | |
| 0x87 | PEER_STATUS | JSON `{state:"disconnected"/"reconnected", graceMs}` | |
| 0x88 | DRAW_OFFERED | rỗng | |
| 0x89 | SPECTATOR_COUNT | binary 2 byte `u16` | |
| 0x8A | HISTORY_RESULT | JSON `{pgn, moves[]}` | |
| 0x8E | HEARTBEAT_ACK | rỗng | |
| 0x8F | ERROR | JSON `{code, message}` | bảng A6 |

## A3. Mã hoá MOVE (client → server, 8 byte)

```text
 offset 0    1    2      3      4        6        8
       ┌────┬────┬──────┬──────┬────────┬────────┐
       │from│ to │promo │flags │  ply   │reserved│
       │ u8 │ u8 │  u8  │  u8  │  u16   │  u16   │
       └────┴────┴──────┴──────┴────────┴────────┘

from/to : chỉ số ô 0..63,  index = rank*8 + file  (a1=0, h1=7, a8=56, h8=63)
promo   : 0=không, 1=N, 2=B, 3=R, 4=Q
flags   : client gửi 0 (server tự tính) – giữ chỗ cho tương thích ngược
ply     : số thứ tự nước đi mà client tin là đúng → chống trùng/đến muộn
```

## A4. Mã hoá MOVE_APPLIED (server → client, 16 byte)

```text
 offset 0      2    3    4      5      6        10       14      16
       ┌──────┬────┬────┬──────┬──────┬────────┬────────┬───────┐
       │ ply  │from│ to │promo │flags │clockW  │clockB  │ tsOff │
       │ u16  │ u8 │ u8 │  u8  │  u8  │u32(ms) │u32(ms) │u16(ms)│
       └──────┴────┴────┴──────┴──────┴────────┴────────┴───────┘

flags bit0 capture · bit1 castle · bit2 en-passant · bit3 promotion
      bit4 check   · bit5 checkmate · bit6 draw (stalemate/50/3-fold)
tsOff : thời gian server xử lý nước đi này (ms), dùng cho client hiệu chỉnh hiển thị
```

**Không gửi FEN.** Client tự áp dụng nước đi lên bàn cờ cục bộ; FEN đầy đủ chỉ xuất hiện trong `GAME_SNAPSHOT`. Đây chính là delta encoding được đo ở E3.

## A5. Đồng bộ đồng hồ (đóng góp N2)

Client gửi `CLOCK_PING` mỗi 10 s. Ký hiệu: `t1` client gửi, `t2` server nhận, `t3` server gửi, `t4` client nhận.

```text
offset = ((t2 - t1) + (t3 - t4)) / 2        # lệch đồng hồ client so với server
rtt    = (t4 - t1) - (t3 - t2)              # thời gian khứ hồi thực
```

Client lấy **trung vị của 5 mẫu gần nhất** để loại nhiễu và dùng `offset` để hiển thị đồng hồ cho đúng.

> **Quan trọng (X33):** giá trị `rtt` dùng để trừ giờ là do **server tự đo** qua chu trình `HEARTBEAT`/`HEARTBEAT_ACK` của chính nó, **không** lấy con số client báo lên. Nếu tin client, người chơi chỉ cần khai `rtt` lớn là được cộng thêm thời gian. Trần bù luôn bị kẹp bởi `clock.compensationCapMs`.

Server trừ giờ khi nhận nước đi thứ *n*:

```text
elapsed_charged = (t_server_recv_move_n - t_server_sent_state_(n-1))
                  - min(rtt/2, clock.compensationCapMs)
clock[side] = clock[side] - elapsed_charged + increment
```

**Baseline đối chứng** (`clock.compensation=false`): client tự đếm ngược từ lúc nhận state, server chấp nhận con số client báo. E4 đo sai lệch của hai phương án ở các mức delay khác nhau.

## A6. Bảng mã lỗi

| Mã | Ý nghĩa | Hành động |
| --- | --- | --- |
| 1001 | Sai tài khoản/mật khẩu | giữ kết nối |
| 1002 | Session hết hạn / token sai | client phải LOGIN lại |
| 1003 | Tài khoản đã đăng nhập nơi khác | đóng phiên cũ |
| 1004 | Username đã tồn tại (khi đăng ký) | giữ kết nối |
| 1005 | Username/password không hợp lệ (độ dài, ký tự) | giữ kết nối |
| 2001 | Frame sai định dạng | đóng kết nối |
| 2002 | TYPE không tồn tại | đóng kết nối |
| 2003 | Frame vượt 64 KiB | đóng kết nối |
| 2004 | Sai phiên bản protocol | đóng kết nối |
| 2005 | Chưa đăng nhập mà gửi message cần phiên | giữ kết nối |
| 3001 | Không phải lượt của bạn | giữ kết nối |
| 3002 | Nước đi không hợp lệ | giữ kết nối, ghi log gian lận |
| 3003 | Không tìm thấy ván | giữ kết nối |
| 3004 | Bạn không phải người chơi của ván này | giữ kết nối, ghi log |
| 3005 | `ply` cũ/trùng | bỏ qua message |
| 3006 | Nước phong cấp thiếu trường `promo` | giữ kết nối, client chọn lại |
| 3007 | Ván đã kết thúc | bỏ qua thao tác |
| 3008 | Đã ở trong hàng đợi / không thể tự ghép với chính mình | giữ kết nối |
| 4001 | Rules service không khả dụng | ván PAUSED |
| 4002 | Lỗi database | ván vẫn chạy |
| 4003 | Server quá tải / hàng đợi đầy | từ chối kết nối hoặc drop message |
| 4004 | Lỗi nội bộ | ghi log |
| 4005 | Vượt giới hạn tốc độ gửi (rate limit) | vi phạm 3 lần → đóng kết nối |

## A7. Chuỗi tương tác

### Đăng nhập → ghép cặp → đánh

```text
Client                         Server
  │──── LOGIN ─────────────────►│
  │◄─── LOGIN_OK(token) ────────│
  │──── QUEUE_JOIN ────────────►│
  │◄─── MATCH_FOUND(gameId,w) ──│
  │◄─── GAME_SNAPSHOT ──────────│   (bàn đầu, đồng hồ bắt đầu)
  │──── MOVE(ply=0,e2e4) ──────►│──► RVP VALIDATE ──► RulesService
  │◄─── MOVE_APPLIED(ply=1) ────│◄── RULES_OK ───────┘
  │        ... lặp ...          │
  │◄─── MOVE_APPLIED(mate) ─────│
  │◄─── GAME_OVER(1-0) ─────────│
```

### Mất kết nối và nối lại

```text
Client A        Server                       Client B
   ╳ rớt mạng     │
                  │ heartbeat timeout 15s
                  │──── PEER_STATUS(disconnected, grace=60000) ──►│
                  │ game -> PAUSED (đồng hồ A vẫn chạy)
   │──── TCP reconnect + RESUME(token,lastPly=12) ──►│
                  │◄─ kiểm tra token, còn trong grace
   │◄─── GAME_SNAPSHOT + MOVE_APPLIED(13..n) ────────│
                  │──── PEER_STATUS(reconnected) ───────────────►│
```

---

# Phần B – RVP (Rules Validation Protocol), server ↔ rules service

Dùng lại **cùng khung** ở A1. `SEQ` đóng vai trò correlation id cho pipelining.

| TYPE | Hướng | Payload |
| --- | --- | --- |
| 0x20 | S→R VALIDATE | JSON `{fen, from, to, promo}` |
| 0x21 | S→R LEGAL_MOVES | JSON `{fen}` |
| 0x22 | S→R PING | rỗng |
| 0xA0 | R→S RULES_OK | JSON `{legal, fenAfter, san, uci, flags, status, halfmove, threefold}` |
| 0xA1 | R→S RULES_ILLEGAL | JSON `{reason}` |
| 0xA2 | R→S LEGAL_MOVES_RESULT | JSON `{moves:["e2e4",...]}` |
| 0xAF | R→S RULES_ERROR | JSON `{code, message}` |

`status` ∈ `ongoing | check | checkmate | stalemate | draw_fifty | draw_threefold | draw_material`.

Rules service **stateless hoàn toàn**: mọi request tự mang FEN, nên thêm/bớt instance không cần đồng bộ gì — nền tảng cho thí nghiệm scaling E7.

---

## C. Quy ước test bắt buộc (SV1)

1. Encode → decode khứ hồi cho tất cả TYPE, so khớp từng trường.
2. Half-packet: cắt một frame thành 3 lần ghi, decoder vẫn ra đúng 1 message.
3. Gộp packet: ghi 5 frame trong 1 lần, decoder ra đúng 5 message.
4. Frame 64 KiB + 1 byte → phải ném lỗi 2003, không OOM.
5. `LEN` âm / TYPE lạ / payload JSON hỏng → lỗi đúng mã, không crash.
6. **Interop**: codec Java encode → codec JS decode và ngược lại, dùng chung một file vector test `common/testvectors.json`. Đây là bằng chứng cho đóng góp N6.

## Changelog

| Version | Ngày | Thay đổi |
| --- | --- | --- |
| 1.0 | **22/09/2026** | Bản đầu tiên, đã đóng băng. Ba bản hiện thực (Java / Node / TypeScript) khớp từng byte trên `source/common-js/testvectors.json`. Mọi thay đổi sau mốc này phải tăng phiên bản và ghi vào bảng này. |
