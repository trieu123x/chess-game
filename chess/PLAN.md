# Kế hoạch thực hiện – DCGS (nhóm 4 người)

Hôm nay: **22/09/2026** · Deadline nộp: **23:59 ngày 31/10/2026** (`Submission.md` §4) → còn **5 tuần + 5 ngày đệm**.

## 1. Phân công

| SV | Vai trò | Sở hữu thư mục | Sản phẩm phải bàn giao |
| --- | --- | --- | --- |
| **SV1** | Protocol & Common | `source/common-java`, `source/common-js`, `tools/` | `PROTOCOL.md` chốt, codec Java + JS, bộ test khung/half-packet/interop, `statics/protocol.png`, delay-proxy |
| **SV2** | Server – Network layer | `source/server/net`, `source/web-client` | Acceptor + Selector + IoWorker, chế độ blocking baseline, ConnectionManager, heartbeat, reconnect/RESUME, backpressure, RulesClient pool + cache + circuit breaker, web client (React) |
| **SV3** | Server – Game core & data | `source/server/game`, `source/database` | GameActor + state machine, ClockEngine + bù RTT, Matchmaker + Elo, PostgreSQL schema + JDBC DAO, PGN, GAME_OVER detection |
| **SV4** | Node side & Experiments | `source/rules-service`, `source/bot`, `source/web-spectator`, `statics/results` | Rules service (chess.js), bot sinh tải, web spectator, chạy E1–E8, CSV + chart |

Ranh giới giữa SV2 và SV3 là interface `GameActor.submit(Message)` — chốt ngay tuần 1 để hai người làm song song không chặn nhau.

**Cả nhóm**: báo cáo (mỗi người viết phần mình phụ trách theo `REPORT-OUTLINE.md`), và **mọi người phải đọc hiểu `PROTOCOL.md` + `ARCHITECTURE.md`** vì `Instruction.md` §17 cho phép giảng viên hỏi bất kỳ ai về bất kỳ phần nào.

## 2. Lộ trình theo tuần

### Tuần 1 · 22–28/09 — Chốt thiết kế, dựng khung
| Ai | Việc |
| --- | --- |
| Cả nhóm | Gửi `PROPOSAL.md` cho giảng viên; thống nhất `PROTOCOL.md` v1.0; tạo repo Git, nhánh theo người |
| SV1 | Codec Java + JS: framing, encode/decode LOGIN/MOVE/HEARTBEAT; test half-packet |
| SV2 | Server mở cổng, accept nhiều kết nối, echo frame; dựng Maven multi-module |
| SV3 | Chạy `source/database/setup.ps1` (PostgreSQL 18), DAO user + game; sinh dữ liệu mẫu |
| SV4 | Rules service trả lời VALIDATE cho 1 FEN; bot kết nối và gửi LOGIN |

**M1 (28/09):** `PROTOCOL.md` đóng băng · client Java LOGIN thành công · rules service trả `RULES_OK` cho `e2e4`.

### Tuần 2 · 29/09–05/10 — Ván cờ chạy end-to-end
| Ai | Việc |
| --- | --- |
| SV1 | Đủ tất cả TYPE của CGP + RVP, bộ testvectors, interop Java↔JS |
| SV2 | ConnectionManager, SessionManager, định tuyến message tới GameActor |
| SV3 | GameActor, Matchmaker ghép 2 người, áp dụng nước đi, GAME_OVER cơ bản, lưu moves |
| SV4 | Rules service đầy đủ (chiếu, chiếu hết, hoà, nhập thành, phong cấp, bắt tốt qua đường) |

**M2 (05/10):** 2 client Java được ghép cặp, đánh hết một ván, kết quả lưu vào PostgreSQL, xuất PGN.

### Tuần 3 · 06–12/10 — Nhiều bàn, đồng hồ, chịu lỗi
| Ai | Việc |
| --- | --- |
| SV1 | `tools/delay-proxy.js` (delay + jitter cấu hình được), `statics/protocol.png` |
| SV2 | Chế độ `nio` và `blocking`, heartbeat, phát hiện rớt kết nối, RESUME + replay, backpressure |
| SV3 | ClockEngine + bù RTT + cờ `clock.compensation`, hết giờ, Elo, leaderboard |
| SV4 | Bot tự chơi ván hoàn chỉnh, chạy N bot song song, ghi CSV latency; web spectator |

**M3 (12/10):** 50 bàn bot chạy đồng thời ổn định 10 phút · rút cáp mạng client → nối lại tiếp tục đúng ván.

### Tuần 4 · 13–19/10 — Rules pool, đo số liệu
| Ai | Việc |
| --- | --- |
| SV1 | Hỗ trợ đo kích thước message; chế độ `server.format=json` để làm baseline E3 |
| SV2 | RulesClient pool, cache theo FEN, circuit breaker, `rules.mode=embedded` làm đối chứng |
| SV3 | Chống gian lận (log nước đi bất hợp lệ), hoàn thiện xử lý lỗi theo bảng A6 |
| SV4 | **Chạy E1–E8**, thu CSV, vẽ chart, lặp lại mỗi kịch bản ≥ 3 lần |

**M4 (19/10):** đủ số liệu của 8 thí nghiệm nằm trong `statics/results/`.

### Tuần 5 · 20–26/10 — Báo cáo
| Ai | Việc |
| --- | --- |
| Cả nhóm | Viết báo cáo theo `REPORT-OUTLINE.md`; SV1 mục Protocol, SV2 mục Architecture/Network, SV3 mục Implementation/Data, SV4 mục Experiment/Results |
| SV4 | Hoàn thiện chart, screenshot demo |
| SV2 | Viết `README.md` cuối cùng theo 24 mục của template |

**M5 (26/10):** bản báo cáo đầy đủ + nộp Compilatio lần 1.

### 27–31/10 — Đệm và nộp
Sửa similarity về ≤ 20 %, đóng gói `NhomXX_DistributedChessServer_Source/` + `Report/`, chạy thử trên **máy sạch** (chưa cài gì) theo đúng README, tập demo 3 lần, kiểm tra checklist §5 bên dưới.

## 3. Definition of Done cho mỗi hạng mục

Một hạng mục chỉ được coi là xong khi: có unit test hoặc kịch bản kiểm thử tay ghi lại được · chạy được từ dòng lệnh theo README · lỗi được xử lý theo bảng mã A6 chứ không ném stack trace ra ngoài · người khác trong nhóm chạy lại được trên máy của họ.

## 4. Rủi ro và cách xử lý

| Rủi ro | Mức | Xử lý |
| --- | --- | --- |
| Sa đà vào UI bàn cờ | **Cao** | UI chỉ làm mức đủ dùng; `Instruction.md` §7 nói thẳng UI không tính là novelty. Chốt UI trong 3 ngày của SV2, không quay lại trau chuốt |
| Tự viết luật cờ | Cao | **Không tự viết.** Dùng `chess.js`, khai báo trong README như §4 cho phép |
| Round-trip tới rules service làm chậm | Trung bình | Cache + pool; có sẵn `rules.mode=embedded` để so sánh và để dự phòng khi demo |
| Đo trên cùng một máy (loopback) làm số liệu đẹp giả | Trung bình | Dùng `delay-proxy` mô phỏng delay; nếu có 2 máy LAN thì đo thêm và ghi rõ môi trường trong §13 báo cáo |
| Thiếu thời gian tuần 4–5 | Trung bình | E7, E8 là *stretch*; nếu thiếu thời gian bỏ E8 trước, giữ E1–E6 |
| Compilatio > 20 % | Trung bình | Không copy định nghĩa từ giáo trình; viết bằng số liệu và hình của nhóm; trích dẫn đầy đủ. Nộp thử sớm ở M5 |
| Một thành viên không theo kịp | Trung bình | Họp 15 phút/ngày; ranh giới module rõ nên có thể chuyển việc; mọi người đọc chung protocol |

## 5. Ngoài phạm vi (ghi vào §2.4 README và §8.15 báo cáo)

Không làm: engine chơi cờ tự viết, tournament/giải đấu nhiều vòng, chat trong ván, mobile app, mã hoá TLS, phân tán server thành nhiều node (chỉ rules service là nhiều instance), phòng chống DDoS.

## 6. Checklist nộp bài

Từ `Instruction.md` §18, `README.md` §23, `Submission.md`:

```text
[ ] Đã gửi proposal và được giảng viên xác nhận chủ đề
[ ] Server chạy được, client kết nối được
[ ] Đã test với nhiều client đồng thời (ít nhất 100 bàn bot)
[ ] Protocol có tài liệu + statics/protocol.png
[ ] Có architecture diagram statics/architecture.png
[ ] Concurrency được giải thích rõ (NIO vs blocking)
[ ] Error handling đã test theo bảng mã A6
[ ] Đủ 8 thí nghiệm (tối thiểu E1–E6), số liệu thực, tái lập được
[ ] Novelty N1..N6 mỗi cái có bằng chứng thực nghiệm
[ ] README đủ 24 mục của template
[ ] Báo cáo đúng cấu trúc paper (Instruction §8)
[ ] References được trích dẫn trong nội dung
[ ] Compilatio <= 20%
[ ] File báo cáo đặt tên NhomXX_DistributedChessServer_Report.docx
[ ] Thư mục nguồn NhomXX_DistributedChessServer_Source/
[ ] Chạy thử trên máy sạch theo đúng README
[ ] Cả 4 thành viên giải thích được protocol, thread model và kết quả đo
[ ] Đã chạy đủ bộ test ngoại lệ T01–T20 ở §8
```

---

# 7. Ngoại lệ và phương án xử lý

Bảng ở `PROPOSAL.md` §9 là bản rút gọn để nộp đề xuất. Đây là bản đầy đủ dùng khi code — mỗi dòng là một tình huống phải xử lý có chủ đích, không phải để `try { } catch (Exception e) { e.printStackTrace(); }`.

**Nguyên tắc xuyên suốt:** lỗi của một client không bao giờ được ảnh hưởng tới client khác hoặc ván khác · mọi lỗi đều trả về mã trong bảng `PROTOCOL.md` §A6 · mọi lỗi đều ghi log kèm `connId`/`gameId` · trạng thái ván chỉ thay đổi khi thao tác thành công trọn vẹn.

## 7.1. Kết nối & transport (SV2, tuần 3)

| # | Tình huống | Phát hiện bằng | Xử lý |
| --- | --- | --- | --- |
| X01 | **Half-open**: máy client tắt nguồn/rút dây, TCP không gửi FIN, server tưởng vẫn sống | Heartbeat timeout 15 s + `SO_KEEPALIVE` | Đóng kết nối, ván → `PAUSED`, báo `PEER_STATUS` cho đối thủ |
| X02 | Kết nối rồi **không gửi gì** (chiếm tài nguyên kiểu slowloris) | Idle timeout 10 s trước khi LOGIN | Đóng kết nối, không cấp session |
| X03 | Client **gửi flood** hàng nghìn message/giây | Bộ đếm token bucket 50 msg/s mỗi kết nối | `ERROR 4005`, vượt tiếp 3 lần → đóng kết nối |
| X04 | **Client đọc chậm**, send buffer đầy | `SocketChannel.write()` trả về < số byte cần ghi | Xếp vào send queue tối đa 256 message, bật `OP_WRITE`; queue đầy → đóng kết nối có kiểm soát (không để server phình RAM) |
| X05 | **TCP RST** giữa lúc server đang ghi | `IOException` khi write | Dọn ConnectionManager, không để lại session mồ côi; không ném exception lên game thread |
| X06 | `LEN` = 0, `LEN` âm (u32 rất lớn), TYPE không tồn tại | Kiểm tra trong `FrameCodec` | `ERROR 2001/2002/2003`, đóng kết nối, **không** cấp phát buffer theo LEN trước khi kiểm tra |
| X07 | Message cần phiên nhưng **chưa LOGIN** (gửi thẳng MOVE) | ConnectionState ≠ AUTHENTICATED | `ERROR 2005`, không đóng kết nối |
| X08 | **Bão reconnect**: server restart, 800 bot nối lại cùng lúc | Số accept/giây | Backlog accept 512 + client backoff ngẫu nhiên 1–5 s (chống đồng pha); vượt ngưỡng → `ERROR 4003` |
| X09 | Nhiều client sau cùng một NAT/IP | – | **Không dùng IP làm định danh**; định danh là `sessionToken` |
| X10 | Cổng đã bị chiếm khi khởi động | `BindException` | Thoát ngay với thông báo rõ ràng, không chạy nửa vời |
| X11 | Server bind `localhost` nên máy khác trong LAN không kết nối được (bẫy lúc demo) | – | Mặc định bind `0.0.0.0`, ghi vào README; kiểm tra Firewall Windows trước buổi demo |

## 7.2. Phiên & xác thực (SV2 + SV3, tuần 2–3)

| # | Tình huống | Xử lý |
| --- | --- | --- |
| X12 | Session **hết hạn giữa ván đang đánh** | Token được gia hạn tự động khi còn ván `IN_PROGRESS`; chỉ hết hạn khi không còn ván |
| X13 | `RESUME` nhưng **ván đã kết thúc** | Trả `GAME_SNAPSHOT` trạng thái `FINISHED` + `GAME_OVER`, không trả lỗi khó hiểu |
| X14 | `RESUME` với `lastPly` **lớn hơn** số nước server có (client lỗi hoặc giả mạo) | Bỏ qua `lastPly` của client, gửi full snapshot. Server không bao giờ tin số liệu client |
| X15 | **Hai kết nối cùng RESUME một session** đồng thời | Serialize theo session; kết nối mới thắng, kết nối cũ nhận `ERROR 1003` rồi đóng |
| X16 | Đăng nhập cùng tài khoản ở 2 máy | Đóng phiên cũ (`ERROR 1003`), phiên mới tiếp quản ván đang chạy |
| X17 | Username trùng khi đăng ký; username/password rỗng, quá dài, ký tự lạ | `ERROR 1004` / `1005`; giới hạn 3–32 ký tự, `[A-Za-z0-9_]`; DB dùng `utf8mb4` |
| X18 | Map session/outstanding request **không được dọn** → rò bộ nhớ sau nhiều giờ | TTL + thread quét định kỳ 60 s; đo RAM trong E1 để phát hiện rò |

## 7.3. Matchmaking (SV3, tuần 2)

| # | Tình huống | Xử lý |
| --- | --- | --- |
| X19 | Người chơi **thoát khi đang trong hàng đợi** | Gỡ khỏi queue ngay khi mất kết nối, nếu không sẽ ghép ra "ván ma" không ai đánh |
| X20 | Đúng lúc ghép cặp thì một bên rớt | Huỷ ghép, trả bên còn lại về đầu hàng đợi, không tạo ván |
| X21 | Một người mở 2 client và **tự ghép với chính mình** | Chặn theo `userId`, `ERROR 3008` |
| X22 | `QUEUE_JOIN` gửi nhiều lần | Idempotent: đã ở trong queue thì bỏ qua |
| X23 | Chờ ghép quá lâu (không có đối thủ) | Sau 60 s gửi thông báo nới điều kiện Elo, không im lặng treo |

## 7.4. Luật cờ & trạng thái ván (SV3 + SV4, tuần 2–4)

| # | Tình huống | Xử lý |
| --- | --- | --- |
| X24 | Nước đi hợp lệ nhưng **đến sau khi ván đã kết thúc** (chạy đua với hết giờ) | `ERROR 3007`, trạng thái ván không đổi |
| X25 | **Hết giờ đúng lúc nước đi đang được validate** | Mốc quyết định là `t_server_recv` của nước đi, **không** phải lúc validate xong → kết quả xác định, giải thích được khi bảo vệ |
| X26 | Cả hai bên gửi message cùng lúc | GameActor xử lý tuần tự theo hàng đợi từng bàn → không cần khoá, không có race |
| X27 | **Phong cấp mà thiếu trường `promo`** | Không tự mặc định thành Hậu (có người muốn phong Mã để chiếu hết). Trả `ERROR 3006` yêu cầu client chọn |
| X28 | Hoà theo 50 nước / lặp 3 lần / **không đủ quân chiếu hết** | Rules service trả `status` tương ứng, server tự kết thúc ván; không chờ người chơi bấm |
| X29 | **Hết giờ nhưng đối thủ không đủ quân để chiếu hết** | Theo luật FIDE: hoà, không phải thắng. Rules service phải trả cờ `insufficient_material` |
| X30 | Spam lời mời hoà | Giới hạn 1 lời mời / 10 nước, `ERROR 4005` |
| X31 | `RESIGN` hoặc `DRAW_REPLY` gửi sau khi ván kết thúc | Bỏ qua, trả `ERROR 3007` |
| X32 | Bot/khách gửi `MOVE` cho **ván của người khác** | `ERROR 3004` + ghi log nghi vấn (kịch bản E6) |

## 7.5. Đồng hồ (SV3, tuần 3)

| # | Tình huống | Xử lý |
| --- | --- | --- |
| X33 | Client **khai RTT rất lớn** để ăn gian thời gian | Server tự đo RTT từ chu trình heartbeat của chính mình, không tin số client gửi; thêm trần bù `clock.compensationCapMs=200` |
| X34 | Người dùng **chỉnh đồng hồ hệ thống** giữa ván | Client và server đều dùng đồng hồ đơn điệu (`System.nanoTime` / `process.hrtime.bigint`), không dùng wall clock cho phép trừ giờ |
| X35 | NTP kéo giờ trên máy server | Như X34; wall clock chỉ dùng để ghi log |
| X36 | Đồng hồ bị âm do trừ quá tay | Kẹp về 0 và kết thúc ván bằng `timeout`, không gửi số âm cho client |
| X37 | **GC pause dài** làm người chơi bị trừ oan giờ | Bật log GC khi benchmark; nếu pause > 200 ms thì bỏ mẫu đó khỏi E4 và **ghi vào Limitations** — không giấu |

## 7.6. Rules service (SV2 + SV4, tuần 4)

| # | Tình huống | Xử lý |
| --- | --- | --- |
| X38 | **Response đến sau khi đã timeout** (late response) | Đối chiếu `SEQ`; request đã bị huỷ thì bỏ qua. Áp dụng nước đi là idempotent theo `ply` → không bao giờ áp dụng hai lần |
| X39 | Rules service **chậm dần chứ không chết** | Circuit breaker mở theo **cả latency p95** chứ không chỉ theo số lỗi |
| X40 | Rules service khởi động lại | Pool tự nối lại với backoff 1/2/4/8 s, tối đa 30 s |
| X41 | `SEQ` tràn u32 hoặc trùng | Bộ đếm tăng dần, xoá khỏi map outstanding khi xong/timeout; kiểm tra trùng trước khi gửi |
| X42 | **Cache trả kết quả sai** do khoá thiếu thông tin | Khoá cache = **FEN đầy đủ** (gồm quyền nhập thành, ô bắt tốt qua đường, halfmove) + nước đi UCI. Tuyệt đối không rút gọn FEN để tiết kiệm bộ nhớ |
| X43 | Hai instance trả kết quả khác nhau cho cùng input | Log cảnh báo, lấy kết quả instance trả trước; bất thường này phải được nêu nếu xảy ra khi đo |
| X44 | Toàn bộ instance chết | Ván → `PAUSED`, client nhận `ERROR 4001`, tự chạy lại khi service sống lại (kịch bản E7) |

## 7.7. Dữ liệu & database (SV3, tuần 3–4)

| # | Tình huống | Xử lý |
| --- | --- | --- |
| X45 | **PostgreSQL chết giữa lúc đang có 100 ván** | Ván vẫn chạy trên RAM; hàng đợi ghi giữ lại; queue đầy → ghi tạm ra file `pending-moves.log`, drop metric trước, **không drop nước đi** |
| X46 | Ghi trùng `(game_id, ply)` khi retry | `INSERT ... ON CONFLICT (game_id, ply) DO NOTHING` → idempotent |
| X47 | Cạn JDBC connection pool | Timeout lấy connection 2 s → `ERROR 4002`, không chặn game thread |
| X48 | Deadlock khi cập nhật Elo cho 2 user trong 1 transaction | Luôn update theo thứ tự `user_id` tăng dần; bắt deadlock và retry 1 lần |
| X49 | **Server restart khi còn ván đang chạy** | Khi khởi động: mọi ván `IN_PROGRESS` trong DB được đánh dấu `ABORTED` và ghi lý do. Khôi phục ván từ bảng `moves` là Future Work — nêu rõ ở Limitations |
| X50 | Username/PGN tiếng Việt bị lỗi font | `utf8mb4` cho DB, UTF-8 cho toàn bộ payload JSON, test bằng một tài khoản có dấu |
| X51 | Gọi JDBC **ngay trong game thread** làm nghẽn cả pool | Cấm blocking trong `GameActor`; mọi thao tác DB đẩy sang DB writer pool. Đây là lỗi hay gặp nhất và khó thấy nhất |

## 7.8. Tài nguyên & vận hành (SV2 + SV4, tuần 4)

| # | Tình huống | Xử lý |
| --- | --- | --- |
| X52 | Vượt giới hạn file descriptor ở 800 kết nối (Linux) | `ulimit -n 65535`, ghi vào phần Requirements của README |
| X53 | Hàng đợi của GameActor đầy do một client flood | Bounded queue 1000; đầy → drop message của chính client đó + `ERROR 4003`, các bàn khác không bị ảnh hưởng |
| X54 | RAM tăng dần suốt phiên chạy dài | Theo dõi RAM trong E1; nghi rò thì kiểm tra các map: session, outstanding request, cache, spectator |
| X55 | **Log DEBUG làm chậm chính phép đo** | Khi chạy E1–E8 phải hạ về INFO, ghi rõ mức log trong Experimental Setup. Không hạ log là nguyên nhân số liệu sai kinh điển |
| X56 | JVM heap mặc định quá nhỏ ở 400 bàn | Đặt `-Xmx` tường minh, ghi vào README và Experimental Setup |

## 7.9. Spectator & web gateway (SV4, tuần 3)

| # | Tình huống | Xử lý |
| --- | --- | --- |
| X57 | Spectator xin xem **ván đã kết thúc** | Trả snapshot `FINISHED` + PGN, không lỗi |
| X58 | 50 spectator đọc chậm làm **chậm broadcast tới 2 người chơi** | Thứ tự ưu tiên: gửi cho người chơi trước, spectator sau; spectator quá chậm bị drop khỏi danh sách (`SPECTATOR_COUNT` giảm) |
| X59 | Người xem đóng tab đột ngột | Gateway phát hiện WS close → đóng kết nối TCP tương ứng, gỡ khỏi danh sách spectator |
| X60 | Gateway chết | Chỉ mất người xem; ván và người chơi không bị ảnh hưởng — nêu như một bằng chứng cô lập lỗi |

## 7.10. Rủi ro lúc demo (cả nhóm, tuần đệm)

| # | Tình huống | Xử lý |
| --- | --- | --- |
| X61 | Máy demo thiếu JDK 17+ / Node 20 / PostgreSQL 18 | Mang bản portable + máy dự phòng; **đã chạy thử trên máy sạch** theo đúng README |
| X62 | Windows Defender/Firewall chặn Java mở cổng | Cho phép trước buổi demo, có ảnh chụp bước này trong README |
| X63 | Bot đánh ngẫu nhiên tạo toàn ván hoà 50 nước, số liệu lệch | Giới hạn 60 nước/ván trong kịch bản đo, ghi rõ trong Experimental Setup |
| X64 | Không có mạng LAN lúc demo | Kịch bản dự phòng chạy tất cả trên một máy + `delay-proxy` để mô phỏng độ trễ |

## 7.11. Thay đổi kéo theo từ rà soát này

* **Mã lỗi mới** thêm vào `PROTOCOL.md` §A6: `1004`, `1005`, `2005`, `3006`, `3007`, `3008`, `4005`.
* **Tham số cấu hình mới** thêm vào `ARCHITECTURE.md` §9: `conn.preLoginTimeoutMs`, `conn.maxMsgPerSec`, `conn.sendQueueMax`, `game.actorQueueMax`, `draw.offerCooldownPlies`, `session.ttlMs`, `db.queueMax`.
* Rules service phải trả thêm cờ `insufficient_material` (X29).
* Server **tự đo RTT** thay vì nhận từ client (X33) — sửa mô tả ở `PROTOCOL.md` §A5.
* Khôi phục ván sau khi server restart (X49) nằm ngoài phạm vi → ghi vào Limitations và Future Work.

---

# 8. Bộ test ngoại lệ bắt buộc

Chạy trước khi nộp, kết quả ghi vào phụ lục báo cáo (§8.19) và bảng §12 của README.

| ID | Kịch bản | Kỳ vọng | Ngoại lệ phủ |
| --- | --- | --- | --- |
| T01 | Gửi frame `LEN` = 0, `LEN` = 2^31, TYPE = 0x7F | Lỗi 2001/2002/2003, server sống | X06 |
| T02 | Cắt một frame thành 3 lần ghi; ghi 5 frame trong 1 lần | Decode đúng 1 và đúng 5 message | – |
| T03 | Gửi MOVE khi chưa LOGIN | `ERROR 2005` | X07 |
| T04 | 1 client gửi 1000 msg/s | Rate limit, `ERROR 4005`, bàn khác không chậm | X03, X53 |
| T05 | Kill tiến trình client (không đóng socket) | Sau ≤ 15 s đối thủ nhận `PEER_STATUS` | X01 |
| T06 | Reconnect + RESUME ở giây thứ 5/20/50 | Tiếp tục đúng ván, 0 nước đi mất | E5 |
| T07 | RESUME sau khi hết 60 s grace | Ván kết thúc đúng luật, có lý do rõ ràng | X13 |
| T08 | RESUME với `lastPly` = 9999 | Server gửi full snapshot, không crash | X14 |
| T09 | Đăng nhập cùng tài khoản trên 2 máy | Phiên cũ bị đóng với 1003, ván không mất | X16 |
| T10 | Thoát khi đang trong hàng đợi, rồi có người khác join | Không tạo ván ma | X19 |
| T11 | Hai client cùng một tài khoản cùng vào queue | Bị chặn 3008 | X21 |
| T12 | Gửi nước phong cấp thiếu `promo` | `ERROR 3006` | X27 |
| T13 | Dựng thế cờ hoà 50 nước / lặp 3 lần / vua-vs-vua | Server tự kết thúc đúng loại hoà | X28 |
| T14 | Hết giờ khi đối thủ chỉ còn vua | Kết quả **hoà**, không phải thắng | X29 |
| T15 | Gửi MOVE cho `gameId` của ván người khác | `ERROR 3004` + log | X32 |
| T16 | Client khai RTT = 5000 ms | Bù không vượt 200 ms | X33 |
| T17 | Kill 1 rules service rồi kill toàn bộ | Ván chuyển PAUSED, không mất ván, tự hồi phục | X44 |
| T18 | Tắt PostgreSQL 60 s giữa lúc 20 ván đang chạy | Ván vẫn chạy, nước đi được ghi bù sau | X45 |
| T19 | Chạy liên tục 60 phút với 50 bàn | RAM không tăng tuyến tính, không rò | X18, X54 |
| T20 | Ngắt web gateway khi 20 spectator đang xem | Người chơi không bị ảnh hưởng | X60 |
