# Project Proposal – Distributed Chess Game Server

> Bản đề xuất theo đúng 11 mục bắt buộc của `Topics.md` §4.7, dùng để gửi giảng viên xác nhận.
> Chủ đề: **Chủ đề 2 – Phát triển game mạng**. Nhóm 04 sinh viên.

## 0. Project Title

**DCGS – Distributed Chess Game Server: server-authoritative chess platform với custom binary protocol, đồng bộ đồng hồ bù độ trễ và rules validation phân tán**

## 1. Problem

Một hệ thống chơi cờ vua qua mạng nhiều bàn đồng thời phải giải quyết các vấn đề mà bản thân luật cờ không đụng tới:

1. **Tin client là không an toàn** – nếu client tự kiểm tra luật và tự đếm giờ, người chơi có thể sửa client để đi nước không hợp lệ hoặc gian lận thời gian.
2. **Độ trễ mạng làm đồng hồ không công bằng** – thời gian gói tin đi trên đường bị tính vào giờ của người chơi; ván blitz 3+2 với 200 ms mỗi nước × 40 nước = 8 giây, đủ quyết định kết quả.
3. **Mất kết nối tạm thời làm hỏng cả ván** – Wi-Fi rớt 5 giây không được phép làm huỷ ván đang đánh.
4. **Băng thông tăng theo số khán giả** – mỗi bàn có thể có nhiều spectator; gửi nguyên trạng thái bàn cờ dạng JSON cho từng người là lãng phí.
5. **Server có state khó mở rộng** – mỗi bàn cờ là một state sống, không thể xử lý tuỳ tiện trên nhiều luồng.

## 2. Objective

Xây dựng và **đo lường** một chess server đáp ứng:

* O1 – Server là nguồn chân lý duy nhất: mọi nước đi và mọi mốc thời gian đều do server quyết định.
* O2 – Sai lệch đồng hồ giữa hai người chơi ≤ 100 ms ở độ trễ mạng mô phỏng 300 ms.
* O3 – Client mất kết nối < 60 s nối lại được và tiếp tục đúng ván, không mất nước đi nào.
* O4 – Phục vụ ≥ 100 bàn đồng thời với move round-trip p95 ≤ 100 ms trên LAN.
* O5 – Băng thông mỗi ván giảm ≥ 60 % so với baseline JSON.
* O6 – Rules service chết giữa chừng không làm sập server và không mất ván nào.

## 3. Server – làm những gì?

Server (**Java 17**) là thành phần có state, đảm nhiệm:

* Xác thực tài khoản, cấp session token, quản lý phiên và trạng thái online.
* Matchmaking theo Elo và theo time control, quản lý hàng đợi ghép cặp.
* Quản lý N bàn cờ đồng thời, mỗi bàn là một state machine độc lập.
* **Server-authoritative validation**: mọi nước đi từ client đều được kiểm tra trước khi áp dụng (uỷ quyền phần luật cho Rules Service).
* **Clock engine**: giữ đồng hồ của cả hai bên, trừ giờ theo thời điểm server nhận được nước đi, có bù một nửa RTT.
* Broadcast sự kiện tới 2 người chơi + danh sách spectator (publish/subscribe theo `gameId`).
* Heartbeat, phát hiện client mất kết nối, giữ ván ở trạng thái `PAUSED` trong thời gian ân hạn, cho phép RESUME.
* Lưu trữ user, session, ván đấu, từng nước đi kèm mốc thời gian (PostgreSQL qua JDBC); sinh PGN.
* Cập nhật Elo, leaderboard.
* Quản lý concurrency: NIO selector + thread pool; mỗi bàn được xử lý tuần tự hoá để không cần khoá tường minh trên state bàn cờ.
* Connection pool + cache + circuit breaker khi gọi Rules Service.

## 4. Client – làm những gì?

**Client người chơi (Web: React 19 + TypeScript)**

* Đăng nhập/đăng ký, vào hàng đợi ghép cặp.
* Hiển thị bàn cờ, cho phép chọn nước đi, gửi `MOVE`.
* **Cập nhật lạc quan**: áp dụng nước đi ngay trên bàn cờ cục bộ rồi chờ server xác nhận; nhận `MOVE_REJECTED` thì rollback.
* Nhận `MOVE_APPLIED`, cập nhật bàn cờ và đồng hồ; hiển thị thời gian còn lại.
* Đo RTT/offset với server bằng `CLOCK_PING`/`CLOCK_PONG`.
* Hiển thị trạng thái kết nối; tự động reconnect có backoff ngẫu nhiên và RESUME bằng session token.
* Xin hoà, đầu hàng, xem lại lịch sử ván; hiển thị nhật ký message CGP để phục vụ demo.

> Lớp hiển thị (bàn cờ, đồng hồ, CSS) kế thừa từ dự án mã nguồn mở **Sir-Teo/web-chess** (giấy phép MIT) — một ứng dụng cờ vua **chạy offline, không có thành phần mạng**. Toàn bộ phần mạng, giao thức và luồng online do nhóm tự viết. Ranh giới kế thừa/tự viết liệt kê từng file trong `source/web-client/NOTICE.md` theo yêu cầu `Topics.md` §6.

**Web Gateway + spectator (Node.js)**

* Cầu WebSocket ↔ TCP: trình duyệt không mở được TCP thuần, gateway chuyển nguyên vẹn frame CGP giữa hai lớp vận chuyển.
* Xem trực tiếp ván đang diễn ra, nhận delta nước đi, hiển thị bàn cờ và đồng hồ.

**Java CLI client** – client TCP thuần không giao diện, dùng để chứng minh giao tiếp socket trực tiếp và phục vụ thí nghiệm E8 (TCP vs WebSocket).

**Bot client (Node.js)** – công cụ sinh tải cho thực nghiệm: mở hàng trăm kết nối, tự đánh nước hợp lệ bằng `chess.js`, ghi log latency ra CSV.

## 5. Network Communication

```text
 Web Client ─WS─┐                                  ┌──TCP pool──> Node Rules Service #1
 (React + TS)  ├─> Node Web Gateway ─TCP─┐        │              (stateless, chess.js)
 Web Client ─WS─┘   (WS <-> TCP)         │        │
                                         ├──> Java Game Server ──┼──TCP pool──> Node Rules Service #2
 Java CLI Client ──────────TCP───────────┤       (stateful)      │
 Node Bot (xN) ────────────TCP───────────┘                       └──JDBC──────> PostgreSQL 18
```

* Client ↔ Server: một kết nối TCP persistent cho mỗi phiên, hai chiều bất đồng bộ (server chủ động push).
* Server ↔ Rules Service: pool kết nối TCP persistent, request/response pipelined theo correlation id.
* Server ↔ PostgreSQL: JDBC, ghi bất đồng bộ qua hàng đợi để không chặn luồng game.
* Browser ↔ Web Gateway: WebSocket binary frame mang **cùng một định dạng message**.

## 6. Protocol

Nhóm **tự thiết kế hai protocol nhị phân** trên TCP (chi tiết ở `PROTOCOL.md`):

* **CGP – Chess Game Protocol** (client ↔ server): khung `LEN(4) | TYPE(1) | SEQ(4) | PAYLOAD`.
* **RVP – Rules Validation Protocol** (server ↔ rules service): cùng khung, payload cho validate / legal-moves.

Không dùng thư viện protocol có sẵn cho phần này. WebSocket chỉ đóng vai trò lớp vận chuyển thay thế cho trình duyệt, message bên trong vẫn là CGP.

## 7. Data Format

**Lai, có chủ đích**:

* *Hot path* (MOVE, MOVE_APPLIED, CLOCK_PING/PONG, HEARTBEAT) dùng **binary đóng gói chặt**: một nước đi gửi đi 8 byte, cập nhật trả về 16 byte kèm cả hai đồng hồ.
* *Control path* (LOGIN, MATCH_FOUND, GAME_SNAPSHOT, GAME_OVER, ERROR) dùng **JSON UTF-8** để dễ mở rộng và dễ debug.
* Baseline để so sánh: chế độ `--format=json` gửi toàn bộ message dạng JSON kèm FEN đầy đủ.

## 8. Concurrency

* **NIO selector + thread pool** (chế độ chính) và **thread-per-connection** (chế độ baseline), chọn bằng cấu hình để so sánh trực tiếp.
* Mỗi bàn cờ có một hàng đợi tuần tự trên thread pool dùng chung → trạng thái bàn cờ không bị hai luồng chạm cùng lúc.
* Rules Service **stateless**, chạy nhiều instance song song → server phân phối theo least-outstanding.
* Ghi DB bất đồng bộ qua bounded queue + writer pool.
* Thread định kỳ quét hết giờ và quét heartbeat timeout.
* Xử lý backpressure khi client đọc chậm: hàng đợi gửi có giới hạn, vượt ngưỡng thì ngắt kết nối có kiểm soát.

## 9. Error Handling

| Tình huống | Cách xử lý |
| --- | --- |
| Frame sai định dạng / quá lớn | Trả `ERROR 2001/2003`, đóng kết nối, không ảnh hưởng bàn khác |
| Nước đi không hợp lệ hoặc sai lượt | `MOVE_REJECTED` kèm mã lỗi, state bàn cờ không đổi, ghi log nghi vấn gian lận |
| Nước đi đến muộn/trùng (`ply` cũ) | Loại bỏ theo `ply`, xử lý idempotent, trả mã `3005` |
| Client mất kết nối | Ván chuyển `PAUSED`, đồng hồ bên đó vẫn chạy, ân hạn 60 s, báo `PEER_STATUS` cho đối thủ |
| Client nối lại | `RESUME` bằng token → gửi `GAME_SNAPSHOT` + replay các nước còn thiếu |
| Hết giờ | Timer phía server kết thúc ván, không phụ thuộc client |
| Rules Service chết/timeout | Retry sang instance khác, circuit breaker; hết đường thì ván `PAUSED` + `ERROR 4001`, không mất ván |
| Lỗi DB | Hàng đợi ghi lại, game vẫn chạy trên bộ nhớ, ghi log lỗi |
| Server quá tải | Từ chối kết nối mới bằng `ERROR 4003`, bảo vệ các ván đang chạy |

Danh sách đầy đủ 64 tình huống ngoại lệ (half-open connection, backpressure, late response, race giữa hết giờ và nước đi, khai RTT giả, PostgreSQL chết giữa ván, rò bộ nhớ…) cùng phương án xử lý và 20 test case tương ứng: xem `PLAN.md` §7–§8.

## 10. Novelty & Contributions

| # | Đóng góp | Baseline so sánh | Bằng chứng |
| --- | --- | --- | --- |
| N1 | CGP – protocol nhị phân tự thiết kế, delta encoding nước đi 8/16 byte | Toàn bộ message JSON kèm FEN | Byte/ván, byte/nước đi, thời gian encode–decode (E3) |
| N2 | Đồng hồ server-authoritative có bù RTT kiểu NTP | Đồng hồ đếm ngược tại client | Sai lệch đồng hồ (ms) ở delay 0/50/150/300 ms (E4) |
| N3 | Rules validation phân tán: worker stateless + connection pool + cache theo FEN + circuit breaker | Gọi trực tiếp, không pool, không cache | Validation latency, cache hit rate, scaling 1→4 worker, recovery khi kill worker (E6, E7) |
| N4 | Concurrency: NIO selector + hàng đợi tuần tự theo bàn | Thread-per-connection | Số bàn đồng thời tối đa, p95 latency, RAM/CPU (E2) |
| N5 | Session resume: replay theo `ply`, ván không huỷ khi rớt mạng | Ngắt kết nối = xử thua/huỷ ván | Recovery time, số nước đi mất = 0 (E5) |
| N6 | Protocol độc lập ngôn ngữ: server Java giao tiếp với client/bot/rules Node bằng cùng một đặc tả | – | Interop test Java ↔ Node trong bộ test |

Nhóm không coi giao diện bàn cờ là đóng góp kỹ thuật.

## 11. Evaluation

Tám nhóm thực nghiệm (chi tiết và mẫu bảng ở `EXPERIMENTS.md`):

| Mã | Nội dung | Metric chính |
| --- | --- | --- |
| E1 | Tải theo số bàn đồng thời 10→400 | Move round-trip p50/p95/p99, throughput |
| E2 | NIO vs thread-per-connection | Số bàn tối đa, p95, RAM, CPU |
| E3 | Binary vs JSON, 0/10/50 spectator | Byte/ván, byte/nước, % tiết kiệm |
| E4 | Công bằng đồng hồ ở delay 0/50/150/300 ms | Sai lệch đồng hồ (ms) |
| E5 | Ngắt kết nối giữa ván | Recovery time, số nước mất |
| E6 | Bơm 1000 nước đi bất hợp lệ | Tỉ lệ từ chối (kỳ vọng 100 %) |
| E7 | Rules worker pool 1→4, kill 1 worker | Throughput, cache hit rate, recovery time |
| E8 | TCP thuần vs WebSocket | Overhead byte, p95 latency |

Công cụ đo: bot client Node sinh tải, `tools/delay-proxy.js` (proxy TCP tự viết để bơm delay/jitter), log CSV + script vẽ chart.

## 12. Technology

| Hạng mục | Công nghệ |
| --- | --- |
| Server | Java 17, `java.nio` (Selector, SocketChannel, ByteBuffer), `ExecutorService`, JDBC |
| Web client | React 19 + TypeScript + Vite (giao diện kế thừa Sir-Teo/web-chess, MIT) |
| Bot cờ (chế độ ngoại tuyến) | Stockfish 18 lite WASM một luồng (GPL-3.0, asset kế thừa), điều khiển bằng UCI |
| CLI client | Java 17+ (TCP thuần, cho E8) |
| Rules Service | Node.js 20 + `chess.js` (thư viện luật cờ, khai báo trong README) |
| Bot / Web spectator / Tools | Node.js 20, `ws`, `chess.js` |
| Database | PostgreSQL 18 |
| Build | Maven (Java), npm (Node) |
| OS thử nghiệm | Windows 11 / Ubuntu 22.04 |

## 13. Phân công (4 sinh viên)

| SV | Mảng phụ trách |
| --- | --- |
| SV1 | Protocol CGP/RVP + codec Java + codec JS + interop test + delay-proxy |
| SV2 | Server network layer: NIO/blocking, session, heartbeat, reconnect, rules-client pool, backpressure |
| SV3 | Game core: state machine, clock engine, matchmaking/Elo, PostgreSQL + JDBC, PGN |
| SV4 | Node side: rules service, bot client, web spectator; toàn bộ thực nghiệm và chart |

Chi tiết công việc theo tuần: xem `PLAN.md`.
