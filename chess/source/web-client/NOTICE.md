# Nguồn gốc mã nguồn — web-client

Tài liệu này là bằng chứng phân định **Existing/Baseline** và **Student's Development** theo `Topics.md` §6 và `Instruction.md` §7. Phải trích dẫn lại trong báo cáo (README §7.1 và báo cáo §8.14).

## 1. Phần kế thừa

**Nguồn:** https://github.com/Sir-Teo/web-chess — giấy phép **MIT**, bản sao tại `LICENSE.upstream`.
Upstream là ứng dụng phân tích cờ vua **chạy hoàn toàn cục bộ trong trình duyệt**: không có server, không có protocol, không có nhiều người chơi.

### 1.1. Giao diện

| File | Dòng | Vai trò |
| --- | ---: | --- |
| `src/components/BoardCanvas.tsx` | 120 | Bọc `react-chessboard`, tô sáng ô, gợi ý nước đi |
| `src/components/ChessClock.tsx` + `ChessClock.css` | 123 | Hai mặt đồng hồ tự đếm trên màn hình |
| `src/components/icons.tsx` | – | Bộ icon SVG |
| `src/engine/boardThemes.ts` | 189 | 5 bảng màu bàn cờ, kiểm tra tương phản WCAG |
| `src/engine/boardMarks.ts`, `premove.ts`, `boardInput.ts` | – | Kiểu tô ô, premove, khoá input, nhận biết phong cấp |
| `src/engine/chessClock.ts` | 297 | Kiểu `ClockState`, định dạng thời gian, preset thể thức |
| `src/engine/gameEnd.ts`, `material.ts`, `sideChoice.ts` | – | Diễn giải kết thúc ván, chênh lệch quân, chọn màu |
| `src/engine/moveSound.ts` + `src/hooks/useMoveSound.ts` | 140+ | Âm thanh nước đi tổng hợp bằng WebAudio |
| `src/hooks/useModalFocus.ts` | – | Bẫy focus cho hộp thoại |
| `src/App.css`, `src/index.css` | 7115 | Toàn bộ hệ thống màu, typography, layout |

### 1.2. Engine cờ (bot)

| File | Dòng | Vai trò |
| --- | ---: | --- |
| `src/engine/stockfishWorker.ts` | 112 | Nạp Stockfish WASM trong Web Worker, bắt lỗi khởi động |
| `src/engine/profiles.ts` | 188 | Hồ sơ engine, dò khả năng máy, đường dẫn asset |
| `src/engine/uci.ts` | 298 | Dựng lệnh UCI (`position`, `go`), đọc dòng `bestmove` |
| `src/engine/engineStartup.ts` | 6 | Thời gian chờ khởi động |
| `public/engine/stockfish-18-lite-single.{js,wasm}` | 7,3 MB | **Stockfish 18 lite, một luồng** |

> **Giấy phép của Stockfish là GPL-3.0**, khác với phần còn lại (MIT). Bản quyền đầy đủ nằm tại `public/engine/Copying.txt`. Nhóm chỉ **dùng lại engine đã biên dịch ở dạng asset tĩnh**, không sửa mã nguồn engine, và phải ghi rõ điều này trong README mục Technology Stack (`Instruction.md` §4 yêu cầu khai báo mọi thư viện ngoài).
>
> Nhóm chọn bản **lite một luồng** thay vì bản đa luồng vì bản đa luồng đòi header `Cross-Origin-Opener-Policy`/`Embedder-Policy`; bản một luồng chạy giống nhau khi `npm run dev`, khi phục vụ qua nginx trong Docker, và khi giảng viên mở trực tiếp — bớt một nguồn hỏng lúc demo.

Tổng cộng khoảng **9.900 dòng mã kế thừa + 7,3 MB asset engine**, tất cả là giao diện, hàm thuần và engine — **không có một dòng nào liên quan tới mạng**.

### 1.3. Phần của upstream nhóm KHÔNG dùng

`App.tsx` gốc (9.150 dòng), `hooks/useAiPlayer.ts`, toàn bộ tầng phân tích (`analysis`, `cloudEval`, `tablebase`, `reviewPool`, `openingExplorer`, `gameLibrary`, `batchReview`, `savedReviews`…), bản engine đa luồng, `docs/`, và bộ test của upstream. Lý do: những phần đó phục vụ bài toán *phân tích ván cờ offline*, không phải bài toán *hệ thống mạng nhiều người chơi* của đồ án này.

## 2. Phần nhóm tự viết

### 2.1. Lớp mạng

| File | Nội dung |
| --- | --- |
| `src/net/cgp.ts` | **Codec CGP v1.0**: khung `LEN\|TYPE\|SEQ\|PAYLOAD`, nước đi 8 byte, `MOVE_APPLIED` 16 byte, `FrameAccumulator` xử lý half-packet, công thức bù RTT |
| `src/net/useGameConnection.ts` | Vòng đời WebSocket, đăng nhập/RESUME, ghép cặp, **cập nhật lạc quan + rollback** khi `MOVE_REJECTED`, heartbeat, đo RTT, reconnect có backoff ngẫu nhiên |
| `src/net/timeControl.ts` | Chuyển số liệu đồng hồ do server gửi sang `ClockState` của component kế thừa |

### 2.2. Bot cờ

| File | Nội dung |
| --- | --- |
| `src/bot/useChessBot.ts` | Vòng đời engine viết lại theo hướng "đối thủ" thay vì "công cụ phân tích": handshake UCI, một hàm `bestMove()` có tương quan yêu cầu–phản hồi, có timeout và có đường thoát khi engine hỏng — cùng khuôn mẫu với `RulesClient` phía server |
| `src/bot/difficulty.ts` | 4 mức độ khó do nhóm định nghĩa: (Skill Level, thời gian nghĩ, trần độ sâu, Elo ước lượng) |
| `src/bot/useBotGame.ts` | Ván ngoại tuyến: luật qua `chess.js`, đồng hồ tính tại client, đấu bot hoặc hai người cùng máy |
| `src/bot/diagnose.ts` + `bot-test.html` | Trang chẩn đoán engine tách khỏi React — vai trò giống `--check` của Game Server |
| `tools/check-engine.mjs`, `tools/check-app.mjs` | Kiểm thử bằng trình duyệt thật (Playwright): engine chơi 6 nước, và cả 3 chế độ chơi trong giao diện |

### 2.3. Giao diện của nhóm

| File | Nội dung |
| --- | --- |
| `src/App.tsx` | Vỏ ba chế độ (online / đấu bot / hai người cùng máy), menu chọn thể thức và độ khó, bảng thông tin ván, **nhật ký message CGP hiển thị trực tiếp** |
| `src/online.css` | Sảnh chờ, thẻ thông tin, chip chọn tuỳ chọn, thanh công cụ bàn cờ, nhật ký giao thức |
| `index.html`, `vite.config.ts`, `tsconfig*.json`, `package.json`, `Dockerfile`, `nginx.conf` | Cấu hình dự án mới |

Ngoài thư mục này, **toàn bộ** `source/server` (Java), `source/common-java`, `source/common-js`, `source/rules-service`, `source/bot`, `source/web-spectator`, `source/database`, `docker-compose.yml` và `tools/` là do nhóm viết.

## 3. Điểm đối chiếu quan trọng cho báo cáo

Chế độ **đấu bot** và chế độ **online** dùng chung đúng một giao diện nhưng ngược nhau về nơi ra quyết định:

| | Đấu bot (ngoại tuyến) | Online (qua server) |
| --- | --- | --- |
| Kiểm tra luật | `chess.js` tại client | Rules Service, server quyết định |
| Đồng hồ | Client tự trừ giờ | Server trừ, có bù RTT |
| Gian lận | Không chặn được | Chặn được, ghi vào `rejected_moves` |
| Mất kết nối | Không liên quan | `PAUSED` + RESUME theo `ply` |

Đây chính là lập luận cho đóng góp N2 và N3: cùng một trải nghiệm người dùng, nhưng chỉ kiến trúc server-authoritative mới cho kết quả tin cậy được.

## 4. Câu trả lời khi bảo vệ

> Nhóm kế thừa phần **hiển thị** và **engine cờ đã biên dịch** của một ứng dụng chơi offline, rồi tự xây dựng toàn bộ phần **hệ thống mạng**: protocol nhị phân, server có state, rules service phân tán, quản lý phiên, đồng bộ đồng hồ và cơ chế nối lại. Phần kế thừa không chứa mã mạng nào; phần đóng góp của nhóm không dùng lại mã nào của upstream.
