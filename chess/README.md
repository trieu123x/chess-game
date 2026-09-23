# DCGS – Distributed Chess Game Server

> **Trạng thái: ĐÃ CHẠY ĐƯỢC ĐẦY ĐỦ.** Server, rules service, gateway, khán đài, bot và bộ thực nghiệm E1–E8 đều chạy được từ dòng lệnh; số liệu thật nằm ở `statics/results/`.
> Chủ đề 2 – Phát triển game mạng (`Topics.md` §3). Nhóm 04 sinh viên. Deadline 31/10/2026.

## Tài liệu trong thư mục này

| File | Nội dung | Dùng cho |
| --- | --- | --- |
| [PROPOSAL.md](docs/PROPOSAL.md) | 11 mục bắt buộc của `Topics.md` §4.7 | Gửi giảng viên xác nhận, tuần 1 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Thành phần, sơ đồ, mô hình luồng, DB schema, cấu hình | Báo cáo §8.8, README §4 |
| [PROTOCOL.md](docs/PROTOCOL.md) | Đặc tả CGP + RVP, framing, bảng message, mã lỗi | Báo cáo §8.9, README §5 — **hợp đồng giữa 4 người** |
| [PLAN.md](docs/PLAN.md) | Phân công, lộ trình 5 tuần, rủi ro, checklist nộp, **§7 bảng 64 ngoại lệ + §8 bộ test T01–T20** | Quản lý tiến độ, báo cáo §8.10 |
| [EXPERIMENTS.md](docs/EXPERIMENTS.md) | 8 thí nghiệm E1–E8, mẫu bảng số liệu | Báo cáo §8.11–8.13, README §13–14 |
| [RESULTS.md](docs/RESULTS.md) | **Số liệu đo được**, kèm cấu hình và môi trường đo | Báo cáo §8.12–8.13 |
| [REPORT-OUTLINE.md](docs/REPORT-OUTLINE.md) | Dàn ý báo cáo theo `Instruction.md` §8, chia việc viết | Tuần 5 |

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

## Tiến độ (cập nhật 19/10/2026)

**M1 (28/09): ĐẠT · M2 (05/10): ĐẠT · M3 (12/10): ĐẠT · M4 (19/10): ĐẠT.**

### Tuần 3–4 đã làm những gì

| Hạng mục | Ai | Bằng chứng |
| --- | --- | --- |
| `tools/delay-proxy.js` — bơm delay + jitter, giữ đúng thứ tự gói | SV1 | dùng trong E4 |
| `statics/protocol.png`, `statics/architecture.png` — sinh từ `tools/diagrams.mjs` | SV1 | hình sinh từ code nên không lệch với đặc tả |
| `server.format=json` — baseline JSON + FEN của E3 | SV1 | `WireFormat.java`, `bot.js --format json` |
| `server.io=blocking` — thread-per-connection, dùng chung `ServerCore` | SV2 | `BlockingServer.java`, E2 |
| RESUME nối vào ván đang dở + replay theo `ply` | SV2 | E5: 0 nước đi bị mất |
| Đóng kết nối có kiểm soát (flush + `shutdownOutput` + nán 500 ms) | SV2 | E6: client nhận đúng mã 4005 thay vì bị RST |
| `rules.mode=embedded` — bảng luật Java làm đối chứng E7 | SV2 | `ChessPosition.java`, **perft tới độ sâu 4 trên 4 thế cờ chuẩn** |
| `DbWriter` — JDBC không bao giờ chạy trên thread GameActor (X51) | SV3 | `[stats] dbQueue=`, `pending-moves.log` (X45) |
| Hết giờ mà đối thủ thiếu quân → **hoà** theo FIDE (X29) | SV3 | RVP `MATERIAL` (0x23), test ở cả hai bản luật |
| Bảng xếp hạng + danh sách ván (`LOBBY_REQ`/`LOBBY_RESULT`) | SV3 | dùng ở khán đài |
| Chống gian lận: log mọi request bị từ chối vào `rejected_moves` | SV3 | dữ liệu thô của E6 |
| Khán giả: `SPECTATE_JOIN/LEAVE`, `SPECTATOR_COUNT`, ưu tiên người chơi (X58) | SV3+SV4 | `GameActor.broadcast` dùng `offer()` cho khán giả |
| Web Gateway WS ↔ TCP **tự viết theo RFC 6455** + trang khán đài | SV4 | `source/web-spectator`, 5/5 test |
| Bot: CSV mỗi nước một dòng, `--format`, `--drop-at`, `--warmup`, `--ramp` | SV4 | công cụ đo của E1–E5 |
| `cheat.js` — bot gian lận 7 nhóm tấn công | SV4 | E6: 100 % request sai bị từ chối |
| `spectate.js` — đo overhead TCP vs WebSocket | SV4 | E8 |
| `tools/run-experiments.mjs` + `tools/plot.js` — chạy E1–E8 bằng một lệnh | SV4 | `statics/results/` |

### Trạng thái các module

| Hạng mục | Trạng thái | Bằng chứng |
| --- | --- | --- |
| `PROTOCOL.md` v1.2 | Xong | v1.0 đóng băng 22/09; v1.1 heartbeat hai chiều; v1.2 thêm LOBBY + RVP MATERIAL |
| Codec 3 ngôn ngữ + interop | Xong | Java 20 test, Node 9 test, TS 6/6 vector — chung `testvectors.json` |
| Database + DAO | Xong | PostgreSQL 18, 5 bảng, pool JDBC có timeout |
| Server NIO: accept, LOGIN, RESUME, heartbeat | Xong | 50 bot đăng nhập đồng thời, 50/50 |
| Rules service (RVP) | Xong | 10/10 test, bắt đúng X27 và X29 |
| **RulesClient: pool + cache + circuit breaker** | Xong | Kill 1 instance giữa tải: 10/10 ván vẫn xong |
| **Matchmaking + GameActor + đồng hồ server** | Xong | 20 ván đồng thời, 5767 nước, 0 lỗi |
| **GAME_OVER + Elo + PGN + lưu DB** | Xong | 4 loại kết thúc: chiếu hết, hết nước, hoà thiếu quân, đầu hàng |
| Bot đánh hết ván | Xong | `bot.js --play --games 20` |
| Web client 3 chế độ | Xong | `npm run check:app` |
| **Web Gateway + khán đài** | Xong | 5/5 test, WebSocket tự viết theo RFC 6455 |
| **`server.io=blocking` (baseline E2)** | Xong | dùng chung `ServerCore` với nio |
| **`rules.mode=embedded` (đối chứng E7)** | Xong | perft khớp số liệu chuẩn tới độ sâu 4 |
| **RESUME vào ván đang dở + replay** | Xong | E5: 0 nước đi bị mất |
| **Thực nghiệm E1–E8** | Xong | `statics/results/`, chạy bằng một lệnh |
| Docker | Xong | compose 6 service |

Việc nhóm phải tự làm: điền tên/MSSV/giảng viên vào `PROPOSAL.md` rồi gửi giảng viên xác nhận.

### Chạy thử nhanh

```bash
# 1. Rules service (hai instance để thấy cơ chế chịu lỗi)
cd source/rules-service && npm install && node index.js --port 6001
cd source/rules-service && node index.js --port 6002

# 2. Game server (terminal khác)
cd source/server && java -jar target/dcgs-server.jar --config config.properties

# 3. Client CLI đăng nhập
cd source/client-cli && java -jar target/dcgs-client.jar --user alice --pass chess123

# 4. 20 ván bot đánh hết, ghi CSV mỗi nước một dòng
cd source/bot && node bot.js --play --games 20 --tc 60+0 --out ../../statics/results/thu.csv

# 5. Khán đài: gateway + trang xem  ->  http://localhost:8080
cd source/web-spectator && node gateway.js --ws 8080 --tcp 127.0.0.1:5555
```

### Chạy toàn bộ thực nghiệm

```bash
node tools/run-experiments.mjs --repeat 3      # E1..E8, ghi CSV + chart vào statics/results/
node tools/run-experiments.mjs --only e3,e7    # chỉ vài thí nghiệm
node tools/run-experiments.mjs --quick         # bản rút gọn, chỉ để thử đường chạy
node tools/diagrams.mjs                        # sinh lại statics/protocol.png + architecture.png
```

Script tự bật/tắt rules service và server với **đúng cấu hình của từng kịch bản** (qua biến
môi trường, không sửa file), chạy bot, gộp CSV thô thành `summary.csv` rồi vẽ chart. Không có
bước nào phải làm tay, nên người khác chạy lại ra cùng bộ số liệu.

### Kịch bản lỗi, chạy được ngay

```bash
# E6 - bot gian lận: 7 nhóm tấn công, kỳ vọng 100% bị từ chối
cd source/bot && node cheat.js --rounds 50 --flood 300

# E4 - bơm độ trễ 150 ms để thấy tác dụng của bù RTT
node tools/delay-proxy.js --listen 5566 --target 127.0.0.1:5555 --delay 150 --jitter 15
cd source/bot && node bot.js --play --games 1 --port 5566 --tc 180+0

# E5 - cắt kết nối ở nước thứ 8, nối lại sau 20 s
cd source/bot && node bot.js --play --games 10 --drop-at 8 --resume-after 20 --tc 600+0
```

## Dựng từ đầu trên máy sạch

```bash
# 1. Database
powershell -ExecutionPolicy Bypass -File source/database/setup.ps1

# 2. Rules service (2 instance)
cd source/rules-service && npm install && node index.js --port 6001
cd source/rules-service && node index.js --port 6002

# 3. Game server (mvn package cũng build common-java và client-cli)
cd source && mvn clean package
cd server && java -jar target/dcgs-server.jar --config config.properties

# 4. Web gateway + khán đài (không có dependency ngoài)
cd source/web-spectator && node gateway.js --ws 8080 --tcp 127.0.0.1:5555

# 5. Web client
cd source/web-client && npm install && npm run dev      # http://localhost:5173

# 6. Bot sinh tải
cd source/bot && npm install && node bot.js --play --games 50 --out ../../statics/results/thu.csv
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
