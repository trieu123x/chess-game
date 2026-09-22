# source/ – phân chia module và chủ sở hữu

Mỗi module có một người chịu trách nhiệm chính. Không sửa module của người khác mà không báo — trừ `common-*` (phải thống nhất với SV1).

| Thư mục | Ngôn ngữ | Chủ sở hữu | Nội dung |
| --- | --- | --- | --- |
| `common-java/` | Java | SV1 | `FrameCodec`, `Message`, enum `MsgType`, `ErrorCode`, encode/decode MOVE & MOVE_APPLIED, test half-packet/gộp packet, `testvectors.json` |
| `common-js/` | Node | SV1 | Bản JS của cùng codec; đọc chung `testvectors.json` để chứng minh interop (đóng góp N6) |
| `server/` | Java | SV2 (net) + SV3 (game) | `net/`: Acceptor, IoWorker, ConnectionManager, HeartbeatMonitor, RulesClient, BlockingServer (baseline). `game/`: GameActor, GameRegistry, Matchmaker, ClockEngine, EloService. `data/`: DAO JDBC, PgnWriter. Cấu hình: `config.properties` |
| `web-client/` | React 19 + TS | SV2 | **Đã dựng xong**: UI bàn cờ + đồng hồ + âm thanh + engine Stockfish kế thừa từ Sir-Teo/web-chess (xem `NOTICE.md`); `src/net/` (codec CGP, WebSocket, reconnect + RESUME, cập nhật lạc quan) và `src/bot/` (vòng đời engine, 4 mức độ khó, ván ngoại tuyến) do nhóm viết. 3 chế độ: online, đấu bot, hai người cùng máy |
| `client-cli/` | Java | SV2 | Client TCP thuần không giao diện: chứng minh giao tiếp socket trực tiếp, phục vụ thí nghiệm E8 |
| `rules-service/` | Node + chess.js | SV4 | Server TCP stateless trả RULES_OK/RULES_ILLEGAL, nhiều instance theo `--port` |
| `bot/` | Node | SV4 | Sinh tải: N kết nối, tự đánh, ghi CSV latency + byte |
| `web-spectator/` | Node + ws | SV4 | Gateway WebSocket↔TCP + trang xem trực tiếp |
| `database/` | SQL | SV3 | **Đã dựng xong**: `schema.sql` (PostgreSQL 18, chạy lại được), `setup.ps1`, 6 tài khoản người + 400 tài khoản bot |

## Quy ước chung

* Java: package gốc `dcgs`, build bằng Maven multi-module, Java 17.
* Node: CommonJS, Node 20, mỗi module có `package.json` riêng.
* Không hardcode host/port — đọc từ `config.properties` (Java) hoặc tham số dòng lệnh (Node).
* Log: mỗi message vào/ra ghi ở mức DEBUG kèm `connId`, `gameId`, `type`, `seq` — cần cho việc giải thích khi bảo vệ.
* Mọi ngoại lệ phải được bắt tại biên kết nối và chuyển thành `ERROR` theo bảng mã ở `PROTOCOL.md` §A6; không để một client làm chết luồng chung.
