# Kế hoạch thực nghiệm – DCGS

Phục vụ `Instruction.md` §9, §8.11–8.13 và `README.md` §13–15.
Người chủ trì: **SV4**. Mọi CSV thô lưu ở `statics/results/<mã>/`, chart xuất cùng thư mục.

## Nguyên tắc chung

1. **Mỗi kịch bản chạy tối thiểu 3 lần**, báo cáo trung vị; nếu độ lệch giữa các lần > 15 % thì ghi rõ và chạy thêm.
2. Mỗi lần chạy có **60 giây warm-up** rồi mới tính số liệu (tránh nhiễu do JIT của JVM).
3. Chuyển kịch bản bằng **cấu hình**, không sửa code (xem `ARCHITECTURE.md` §9) → người khác tái lập được.
4. Chỉ ghi số đo thật. `README.md` §14.3 và `Instruction.md` §8.12 cấm dựng số liệu.
5. Ghi lại môi trường cho mỗi lần đo: CPU, RAM, OS, phiên bản Java/Node, máy chung hay LAN, số máy client.

## Công cụ

| Công cụ | Vị trí | Chức năng |
| --- | --- | --- |
| Bot client | `source/bot` | `node bot.js --games 100 --tc 60+0 --out results/e1.csv` — mỗi bot là 1 kết nối TCP, tự đánh nước hợp lệ bằng `chess.js`, ghi `t_send`, `t_recv`, `bytes_in`, `bytes_out` từng nước |
| Delay proxy | `tools/delay-proxy.js` | `node delay-proxy.js --listen 5556 --target 5555 --delay 150 --jitter 20` — TCP proxy tự viết, bơm độ trễ và jitter |
| Plot | `tools/plot.js` | CSV → PNG chart |
| Đếm byte | trong codec (SV1) | bộ đếm byte vào/ra theo từng kết nối, dump khi kết thúc ván |
| Tài nguyên | `jcmd` / Task Manager / `top` | RAM, CPU, số thread |

Đo thời gian bằng `System.nanoTime()` (Java) và `process.hrtime.bigint()` (Node) — **không dùng** `currentTimeMillis` cho latency.

---

## E1 – Độ trễ và thông lượng theo tải

* **Câu hỏi:** hệ thống chịu được bao nhiêu bàn đồng thời trước khi độ trễ vượt ngưỡng?
* **Thiết lập:** `server.io=nio`, binary, rules remote 2 instance. Bot chạy 10 / 50 / 100 / 200 / 400 bàn, mỗi bàn 2 bot, time control 60+0, mỗi kịch bản 5 phút.
* **Đo:** move round-trip (từ lúc bot gửi MOVE đến lúc nhận MOVE_APPLIED) p50/p95/p99, throughput (nước đi/giây), CPU %, RAM, số thread.

| Số bàn | Kết nối | p50 (ms) | p95 (ms) | p99 (ms) | Nước đi/s | CPU % | RAM (MB) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 20 | | | | | | |
| 50 | 100 | | | | | | |
| 100 | 200 | | | | | | |
| 200 | 400 | | | | | | |
| 400 | 800 | | | | | | |

## E2 – NIO + thread pool vs thread-per-connection (đóng góp N4)

* **Câu hỏi:** mô hình I/O ảnh hưởng thế nào tới khả năng mở rộng?
* **Thiết lập:** lặp lại E1 với `server.io=blocking` rồi `server.io=nio`, cùng phần cứng, cùng tải.
* **Đo:** p95 latency theo số bàn, số bàn tối đa trước khi p95 > 200 ms, RAM, **số thread của tiến trình server**, CPU.

| Số bàn | p95 blocking (ms) | p95 nio (ms) | Thread blocking | Thread nio | RAM blocking (MB) | RAM nio (MB) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | | | | | | |
| 100 | | | | | | |
| 200 | | | | | | |
| 400 | | | | | | |

> Điểm cần thảo luận trong báo cáo: blocking tốn ~2 thread/kết nối nên RAM và chi phí chuyển ngữ cảnh tăng tuyến tính, còn NIO giữ số thread cố định.

## E3 – Binary + delta vs JSON (đóng góp N1)

* **Thiết lập:** cùng 20 ván hoàn chỉnh giống hệt nhau (phát lại từ cùng một file PGN), chạy hai lần với `server.format=binary` và `=json`; lặp với 0 / 10 / 50 spectator mỗi bàn.
* **Đo:** tổng byte/ván, byte trung bình mỗi nước đi cho mỗi chiều, tổng byte gửi tới toàn bộ spectator, thời gian encode+decode trung bình.

| Kịch bản | Byte/nước (S→C) | Byte/ván | Byte/ván + 10 spec | Byte/ván + 50 spec | Tiết kiệm (%) |
| --- | ---: | ---: | ---: | ---: | ---: |
| JSON + FEN (baseline) | | | | | – |
| Binary + delta (đề xuất) | | | | | |

## E4 – Công bằng đồng hồ (đóng góp N2)

* **Câu hỏi:** bù RTT có loại được thiệt hại thời gian do độ trễ không?
* **Thiết lập:** 1 ván, bên Trắng nối trực tiếp, bên Đen đi qua `delay-proxy` với delay 0 / 50 / 150 / 300 ms (jitter 10 %). Chạy với `clock.compensation=false` rồi `=true`. Mỗi ván 40 nước, time control 180+2.
* **Đo:** `clock_drift = |thời gian bị trừ của bên Đen − thời gian suy nghĩ thực tế của bên Đen|`, cộng dồn sau 40 nước; lấy từ cột `clock_b_ms` trong bảng `moves` so với timestamp bot ghi.

| Delay (ms) | Drift không bù (ms) | Drift có bù (ms) | Cải thiện (%) |
| ---: | ---: | ---: | ---: |
| 0 | | | |
| 50 | | | |
| 150 | | | |
| 300 | | | |

## E5 – Mất kết nối và nối lại (đóng góp N5)

* **Thiết lập:** 20 ván đang chạy; với mỗi ván, giết tiến trình client (hoặc cắt qua proxy) ở nước thứ 10, chờ 5 / 20 / 50 s rồi cho RESUME. Thêm 5 ván để quá 60 s grace để kiểm tra xử lý hết hạn.
* **Đo:** recovery time (từ lúc TCP nối lại đến khi nhận xong GAME_SNAPSHOT + replay), số nước đi bị mất (**phải = 0**), trạng thái ván sau khi hết grace, số ván bị sập.

| Thời gian ngắt (s) | Số ca | Recovery time TB (ms) | Nước đi mất | Ván tiếp tục đúng |
| ---: | ---: | ---: | ---: | --- |
| 5 | 20 | | | |
| 20 | 20 | | | |
| 50 | 20 | | | |
| 70 (quá grace) | 5 | – | – | kỳ vọng: xử thua theo luật |

## E6 – Server-authoritative validation

* **Thiết lập:** bot "gian lận" bơm 1000 request gồm: nước đi sai luật, đi khi không phải lượt, `ply` cũ, ăn quân của chính mình, nhập thành khi vua đã đi, gửi `gameId` của ván người khác.
* **Đo:** tỉ lệ từ chối (kỳ vọng 100 %), mã lỗi trả về đúng loại, server có sập hay không, ảnh hưởng tới các bàn khác đang chạy (kỳ vọng: không).

| Loại tấn công | Số request | Bị từ chối | Mã lỗi | Ảnh hưởng bàn khác |
| --- | ---: | ---: | --- | --- |
| Nước sai luật | 300 | | 3002 | |
| Sai lượt | 200 | | 3001 | |
| `ply` cũ/trùng | 200 | | 3005 | |
| Ván không thuộc về mình | 200 | | 3004 | |
| Frame hỏng | 100 | | 2001 | |

## E7 – Rules worker pool (đóng góp N3)

* **Thiết lập:** tải cố định 100 bàn. Chạy lần lượt với 1 / 2 / 4 instance rules service; bật/tắt cache; và một lần `rules.mode=embedded` làm đối chứng. Sau đó kill một instance ở phút thứ 3.
* **Đo:** validation latency p50/p95, cache hit rate, throughput tổng, thời gian phục hồi sau khi kill, số ván bị hỏng (kỳ vọng 0).

| Cấu hình | Validation p50 (ms) | p95 (ms) | Cache hit (%) | Nước đi/s | Move p95 tổng (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| embedded (đối chứng) | | | – | | |
| remote 1, không cache | | | 0 | | |
| remote 1, có cache | | | | | |
| remote 2, có cache | | | | | |
| remote 4, có cache | | | | | |

| Sự kiện | Thời điểm | Recovery time (s) | Ván lỗi | Ván mất |
| --- | --- | ---: | ---: | ---: |
| Kill 1/2 instance | phút 3 | | | kỳ vọng 0 |
| Kill toàn bộ instance | phút 6 | | | kỳ vọng 0 (ván PAUSED) |

## E8 – TCP thuần vs WebSocket (stretch)

* **Thiết lập:** 50 spectator qua TCP và 50 spectator qua WebSocket gateway, cùng một ván.
* **Đo:** byte overhead mỗi message, p95 latency tới spectator, CPU của gateway.

| Transport | Overhead/message (byte) | p95 latency (ms) | CPU gateway (%) |
| --- | ---: | ---: | ---: |
| TCP thuần | | | |
| WebSocket | | | |

---

## Bảng tổng hợp cho mục Results của báo cáo

| Mục tiêu | Ngưỡng đặt ra | Kết quả đo | Đạt? |
| --- | --- | --- | --- |
| O2 – drift đồng hồ ở delay 300 ms | ≤ 100 ms | | |
| O3 – nối lại không mất nước đi | 0 nước | | |
| O4 – 100 bàn, move p95 | ≤ 100 ms | | |
| O5 – tiết kiệm băng thông | ≥ 60 % | | |
| O6 – rules service chết | 0 ván mất | | |

## Những câu phải trả lời trong phần Discussion (`README.md` §15)

1. Khi tăng số bàn thì độ trễ tăng theo dạng nào, và điểm gãy nằm ở đâu?
2. Bottleneck là CPU của server, round-trip tới rules service, hay hàng đợi ghi DB? Chứng minh bằng số nào?
3. Vì sao NIO thắng blocking, và ở mức tải thấp thì blocking có thắng không?
4. Cache theo FEN giúp được bao nhiêu, và vì sao hit rate cao ở khai cuộc nhưng thấp ở tàn cuộc?
5. Bù RTT có tác dụng phụ gì (client báo RTT sai để ăn gian thì sao)?
6. Hạn chế của phép đo: chạy trên một máy, bot đánh ngẫu nhiên nên phân bố nước đi khác người thật.
