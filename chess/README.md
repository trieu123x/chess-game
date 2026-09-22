# DCGS – Distributed Chess Game Server

> **Trạng thái: PLANNING.** Thư mục này hiện chứa bộ tài liệu thiết kế; source code sẽ được điền vào `source/` theo `PLAN.md`.
> Chủ đề 2 – Phát triển game mạng (`Topics.md` §3). Nhóm 04 sinh viên. Deadline 31/10/2026.

## Tài liệu trong thư mục này

| File | Nội dung | Dùng cho |
| --- | --- | --- |
| [PROPOSAL.md](PROPOSAL.md) | 11 mục bắt buộc của `Topics.md` §4.7 | Gửi giảng viên xác nhận, tuần 1 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Thành phần, sơ đồ, mô hình luồng, DB schema, cấu hình | Báo cáo §8.8, README §4 |
| [PROTOCOL.md](PROTOCOL.md) | Đặc tả CGP + RVP, framing, bảng message, mã lỗi | Báo cáo §8.9, README §5 — **hợp đồng giữa 4 người** |
| [PLAN.md](PLAN.md) | Phân công, lộ trình 5 tuần, rủi ro, checklist nộp, **§7 bảng 64 ngoại lệ + §8 bộ test T01–T20** | Quản lý tiến độ, báo cáo §8.10 |
| [EXPERIMENTS.md](EXPERIMENTS.md) | 8 thí nghiệm E1–E8, mẫu bảng số liệu | Báo cáo §8.11–8.13, README §13–14 |
| [REPORT-OUTLINE.md](REPORT-OUTLINE.md) | Dàn ý báo cáo theo `Instruction.md` §8, chia việc viết | Tuần 5 |

## Tóm tắt project

Hệ thống chơi cờ vua qua mạng nhiều bàn đồng thời, trong đó **server là nguồn chân lý duy nhất** về nước đi và thời gian. Ba tiến trình:

* **Game Server (Java 17)** – có state: session, matchmaking, N bàn cờ, đồng hồ, broadcast, PostgreSQL. NIO selector + thread pool, mỗi bàn xử lý tuần tự.
* **Rules Service (Node 20 + chess.js)** – stateless, nhiều instance: kiểm tra luật, sinh FEN, phát hiện chiếu hết/hoà.
* **Client** – Web client React 19 + TS (giao diện kế thừa từ Sir-Teo/web-chess, MIT) nói CGP qua WebSocket gateway; thêm Java CLI client dùng TCP thuần và bot Node sinh tải.

Hai protocol nhị phân tự thiết kế: **CGP** (client↔server) và **RVP** (server↔rules service), cùng khung `LEN|TYPE|SEQ|PAYLOAD`.

## Đóng góp kỹ thuật

| # | Đóng góp | Baseline đối chứng | Thí nghiệm |
| --- | --- | --- | --- |
| N1 | Binary protocol + delta encoding nước đi | JSON + FEN đầy đủ | E3 |
| N2 | Đồng hồ server-authoritative bù RTT | Đồng hồ đếm tại client | E4 |
| N3 | Rules validation phân tán + pool + cache + circuit breaker | Gọi trực tiếp không cache | E6, E7 |
| N4 | NIO selector + actor tuần tự theo bàn | Thread-per-connection | E2 |
| N5 | Session resume, replay theo `ply` | Rớt mạng = mất ván | E5 |
| N6 | Protocol độc lập ngôn ngữ (Java ↔ Node) | – | Interop test |

## Tiến độ (cập nhật 22/09/2026)

**Mốc M1 (hạn 28/09): ĐẠT.**

| Hạng mục | Trạng thái | Bằng chứng |
| --- | --- | --- |
| `PROTOCOL.md` v1.0 đóng băng | Xong | Changelog ghi ngày 22/09/2026 |
| Codec 3 ngôn ngữ + interop | Xong | Java 20 test, Node 9 test, TS 6/6 vector — chung `source/common-js/testvectors.json` |
| Database + dữ liệu mẫu | Xong | PostgreSQL 18, 5 bảng, 406 tài khoản |
| Maven multi-module | Xong | 3 module, build ra `dcgs-server.jar`, `dcgs-client.jar` |
| Server accept nhiều kết nối | Xong | 50 bot đăng nhập đồng thời, 50/50 thành công |
| Client Java LOGIN | Xong | `dcgs-client.jar` → LOGIN_OK, RTT 2 ms |
| Rules service trả RULES_OK cho e2e4 | Xong | 10/10 test RVP |
| Bot sinh tải | Xong | `bot.js --bots 50`, ghi CSV |
| DAO user/session/game/move | Xong | `Database.java` |
| Web client 3 chế độ | Xong (vượt kế hoạch) | `npm run check:app` |
| Docker | Xong (vượt kế hoạch) | compose 6 service |

Chưa làm (tuần 2 theo `PLAN.md`): matchmaking, GameActor, đồng hồ server, gateway WebSocket, chế độ `server.io=blocking` làm baseline cho E2.

Việc nhóm phải tự làm: điền tên/MSSV/giảng viên vào `PROPOSAL.md` rồi gửi giảng viên xác nhận.

### Chạy thử nhanh

```bash
# 1. Rules service
cd source/rules-service && npm install && node index.js --port 6001

# 2. Game server (terminal khác)
cd source/server && java -jar target/dcgs-server.jar --config config.properties

# 3. Client CLI đăng nhập
cd source/client-cli && java -jar target/dcgs-client.jar --user alice --pass chess123

# 4. 50 bot đăng nhập đồng thời
cd source/bot && node bot.js --bots 50
```

## Chạy (điền khi có code)

```bash
# 1. Database
powershell -ExecutionPolicy Bypass -File source/database/setup.ps1

# 2. Rules service (2 instance)
cd source/rules-service && npm install && node index.js --port 6001
cd source/rules-service && node index.js --port 6002

# 3. Game server
cd source/server && mvn clean package && java -jar target/dcgs-server.jar --config config.properties

# 4. Web gateway
cd source/web-spectator && npm install && node gateway.js --ws 8080 --tcp 127.0.0.1:5555

# 5. Web client  (ĐÃ CHẠY ĐƯỢC)
cd source/web-client && npm install && npm run dev      # http://localhost:5173

# 6. Bot sinh tải
cd source/bot && npm install && node bot.js --games 100 --out ../../statics/results/e1.csv
```

Web client có **3 chế độ**, chạy được ngay cả khi server Java chưa xong:

| Chế độ | Mô tả | Cần server? |
| --- | --- | --- |
| Online | Ghép cặp qua Game Server bằng protocol CGP; server quyết định nước đi và thời gian | Có |
| Đấu bot | Stockfish 18 lite (WASM) chạy trong trình duyệt, 4 mức độ khó | Không |
| Hai người cùng máy | Hot-seat trên một bàn cờ | Không |

Kiểm thử web client bằng trình duyệt thật (cần `npm run dev` ở terminal khác):

```bash
cd source/web-client
npm run check:engine   # engine chơi 6 nước, tách khỏi giao diện
npm run check:app      # 3 chế độ trong giao diện, chụp ảnh tools/last-run.png
```

> README nộp cuối cùng phải viết lại theo đủ **24 mục** của template `../README.md` (`Instruction.md` §13). File này là bản rút gọn phục vụ giai đoạn phát triển.
