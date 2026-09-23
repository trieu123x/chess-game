# Kế hoạch thực nghiệm – DCGS

Phục vụ `Instruction.md` §9, §8.11–8.13 và `README.md` §13–15.
Người chủ trì: **SV4**. Mọi CSV thô lưu ở `statics/results/<mã>/`, chart xuất cùng thư mục.

## Nguyên tắc chung

1. **Mỗi kịch bản chạy tối thiểu 3 lần**, báo cáo trung vị; nếu độ lệch giữa các lần > 15 % thì ghi rõ và chạy thêm.
2. Mỗi lần chạy có **60 giây warm-up** rồi mới tính số liệu (tránh nhiễu do JIT của JVM).
3. Chuyển kịch bản bằng **cấu hình**, không sửa code (xem `ARCHITECTURE.md` §9) → người khác tái lập được.
4. Chỉ ghi số đo thật. `README.md` §14.3 và `Instruction.md` §8.12 cấm dựng số liệu.
5. Ghi lại môi trường cho mỗi lần đo: CPU, RAM, OS, phiên bản Java/Node, máy chung hay LAN, số máy client.

## Chạy tất cả bằng một lệnh

```bash
node tools/run-experiments.mjs --repeat 3        # E1..E8
node tools/run-experiments.mjs --only e4,e7      # chỉ vài cái
```

Script tự bật/tắt rules service + game server với **đúng cấu hình của từng kịch bản**
(ghi đè bằng biến môi trường, không sửa `config.properties`), chạy bot, gộp CSV thô
thành `summary.csv` rồi gọi `tools/plot.js` vẽ chart. Đây là cách thoả nguyên tắc 3
ở trên: đổi kịch bản bằng cấu hình, không sửa code, và không có bước nào làm tay.

**Trước khi đo phải đóng hết ứng dụng khác.** Đo trên máy đang chạy việc khác cho ra
số liệu lệch tới 80 % — nhóm đã gặp đúng chuyện này khi vừa đo vừa render hình, xem
phần Limitations trong [RESULTS.md](RESULTS.md).

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
* **Thiết lập đã chạy:** `server.io=nio`, binary, rules remote 2 instance. Bot chạy **10 / 50 / 100 bàn**, mỗi bàn 2 bot, **time control 120+0, tối đa 60 nước/ván**, ramp 2 s, lặp 3 lần.
  *(Kế hoạch ban đầu có thêm 200 và 400 bàn — chưa chạy được, xem mục "Những mục chưa đo được".)*
* **Đo:** move round-trip (từ lúc bot gửi MOVE đến lúc nhận MOVE_APPLIED) p50/p95/p99, throughput (nước đi/giây), CPU %, RAM, số thread.

| Số bàn | Kết nối | p50 (ms) | p95 (ms) | p99 (ms) | Nước đi/s | CPU % | RAM (MB) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 20 | 7,4 | 24,1 | 30,7 | 90 | – | 42 |
| 50 | 100 | 27,7 | 71,2 | 89,8 | 250 | – | 42 |
| 100 | 200 | 39,9 | **103,7** | 133,7 | 281 | – | 40 |
| 200 | 400 | *chưa đo* | | | | | |
| 400 | 800 | *chưa đo* | | | | | |

## E2 – NIO + thread pool vs thread-per-connection (đóng góp N4)

* **Câu hỏi:** mô hình I/O ảnh hưởng thế nào tới khả năng mở rộng?
* **Thiết lập đã chạy:** lặp lại E1 với `server.io=blocking` rồi `server.io=nio`, cùng phần cứng, cùng tải (10 / 50 / 100 bàn). Hai chế độ dùng **chung `ServerCore`**, chỉ khác cách byte vào/ra socket — nên phép so sánh đo đúng mô hình I/O chứ không phải hai bản server khác nhau.
* **Đo:** p95 latency theo số bàn, số bàn tối đa trước khi p95 > 200 ms, RAM, **số thread của tiến trình server**, CPU.

| Số bàn | p95 blocking (ms) | p95 nio (ms) | Thread blocking | Thread nio | RAM blocking (MB) | RAM nio (MB) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 75,1 | 67,6 | 133 | 20 | 73 | 45 |
| 100 | 117,5 | **102,5** | **305** | **20** | 84 | 40 |
| 200 | *chưa đo* | | | | | |
| 400 | *chưa đo* | | | | | |

> Điểm cần thảo luận trong báo cáo: blocking tốn ~2 thread/kết nối nên RAM và chi phí chuyển ngữ cảnh tăng tuyến tính, còn NIO giữ số thread cố định.

## E3 – Binary + delta vs JSON (đóng góp N1)

* **Thiết lập đã chạy:** 20 ván, chạy hai lần với `server.format=binary` rồi `=json`, lặp 3 lần. Bot đổi theo bằng `--format`.
  *(Kế hoạch ban đầu phát lại từ cùng một file PGN và thêm 10 / 50 spectator — chưa làm; ván do bot đánh ngẫu nhiên nên hai lần chạy không cùng chuỗi nước đi. Điều này **không ảnh hưởng kết luận**: byte/nước của bản binary là hằng số 25 byte không phụ thuộc nước đi, và ba lần lặp của bản JSON lệch nhau dưới 0,2 %.)*
* **Đo:** tổng byte/ván, byte trung bình mỗi nước đi cho mỗi chiều, tổng byte gửi tới toàn bộ spectator, thời gian encode+decode trung bình.

| Kịch bản | Byte/nước (S→C) | Byte/ván | Byte/ván + 10 spec | Byte/ván + 50 spec | Tiết kiệm (%) |
| --- | ---: | ---: | ---: | ---: | ---: |
| JSON + FEN (baseline) | 189,3 | 28 207 | *chưa đo* | *chưa đo* | – |
| Binary + delta (đề xuất) | **25,0** | **6 374** | *chưa đo* | *chưa đo* | **86,8** |

## E4 – Công bằng đồng hồ (đóng góp N2)

* **Câu hỏi:** bù RTT có loại được thiệt hại thời gian do độ trễ không?
* **Thiết lập đã chạy:** hai ván song song — một bên nối trực tiếp, một bên đi qua `delay-proxy` với delay 0 / 50 / 150 / 300 ms (jitter 10 %). Chạy với `clock.compensation=false` rồi `=true`. Mỗi ván **40 nước, time control 300+0**, lặp 3 lần.
* **Đo:** `drift = thời gian server TRỪ − thời gian client THỰC SỰ suy nghĩ`, tính cho từng nước rồi lấy trung vị, đồng thời cộng dồn sau 40 nước.
  Giờ bị trừ đọc thẳng từ `clockW`/`clockB` mà server gửi kèm mỗi `MOVE_APPLIED`; thời gian suy nghĩ là khoảng từ lúc client biết đến lượt mình tới lúc nó gửi nước đi.
  **Không đo round-trip của nước đi** — round-trip bị chi phối bởi độ trễ mạng nên gần như không đổi dù bật hay tắt bù, đo nó sẽ kết luận sai rằng bù RTT vô tác dụng. Nhóm đã mắc đúng lỗi này ở lần đo đầu.

| Delay (ms) | Drift không bù (ms) | Drift có bù (ms) | Cải thiện (%) |
| ---: | ---: | ---: | ---: |
| 0 | 26,3 | 21,0 | 20 |
| 50 | 120,6 | **61,1** | **49** |
| 150 | 320,4 | **156,6** | **51** |
| 300 | 614,6 | 415,0 | 33 |

## E5 – Mất kết nối và nối lại (đóng góp N5)

* **Thiết lập đã chạy:** **10 ván** đang chạy; với mỗi ván, **cắt phẳng socket bên Trắng ở nước thứ 8** (`destroy()`, không gửi FIN — mô phỏng rút dây mạng chứ không phải thoát tử tế), chờ 5 / 20 / 50 s rồi `RESUME`. Thêm 3 ván với `reconnect.graceMs=5000` và chờ 12 s để kiểm tra xử lý hết hạn.
  Chỉ cắt **một bên**: cắt cả hai thì ván chuyển `PAUSED` ngay, không ai đi được nước nào, và câu hỏi "có mất nước đi không?" không bao giờ được hỏi tới.
* **Đo:** recovery time (từ lúc TCP nối lại đến khi nhận xong `GAME_SNAPSHOT` + replay), số nước đi bị mất (**phải = 0**), trạng thái ván sau khi hết grace, số ván bị sập.
  Đếm "nước bị mất" bằng tập các `ply` client **thực sự nhận được**, so với số `ply` cuối ván. **Không dùng history của `chess.js`**: `board.load()` lúc nhận snapshot sẽ xoá lịch sử và cho ra con số sai (lần đo đầu ra "33 nước mất" hoàn toàn giả).

| Thời gian ngắt (s) | Số ca | Recovery time TB (ms) | Nước đi mất | Ván tiếp tục đúng |
| ---: | ---: | ---: | ---: | --- |
| 5 | 10 | 23,5 | **0** | 10/10 |
| 20 | 10 | 20,6 | **0** | 10/10 |
| 50 | 10 | 16,7 | **0** | 10/10 |
| 70 (quá grace) | 5 | – | – | kỳ vọng: xử thua theo luật |

## E6 – Server-authoritative validation

* **Thiết lập đã chạy:** `node source/bot/cheat.js --rounds 50 --flood 300` — **498 request sai** thuộc 8 nhóm, giãn cách 30 ms để không chạm rate limit (nhóm "flood" đo rate limit riêng). Một ván bình thường chạy song song suốt đợt tấn công làm nhân chứng.
* **Đo:** tỉ lệ từ chối (kỳ vọng 100 %), mã lỗi trả về đúng loại, server có sập hay không, ảnh hưởng tới các bàn khác đang chạy (kỳ vọng: không).

| Loại tấn công | Số request | Bị từ chối | Mã lỗi | Ảnh hưởng bàn khác |
| --- | ---: | ---: | --- | --- |
| Nước sai luật | 50 | 50 | 3002 | không |
| Sai lượt | 50 | 50 | 3001 | không |
| `ply` cũ/trùng | 50 | 49 (1 hết giờ chờ) | 3005 | không |
| Phong cấp thiếu `promo` | 20 | 20 | 3002 | không |
| Ván không thuộc về mình | 50 | 50 | **3003** (xem ghi chú) | không |
| Chưa LOGIN đã đi | 20 | 20 | 2005 | không |
| Frame hỏng | 7 | 7 | 2001 / 2003 | không |
| Flood 300 msg | 251 | 251 | 4005 | không |

> **Ghi chú về mã lỗi của dòng "ván không thuộc về mình":** kỳ vọng ban đầu là `3004`
> (không phải người chơi của ván này), nhưng thực tế server trả `3003`. Lý do là `MOVE`
> **không mang `gameId`** — server định tuyến theo phiên đã xác thực, nên kẻ tấn công không
> có cách nào trỏ nước đi vào ván người khác. Đây là kết quả **mạnh hơn** kỳ vọng: trường hợp
> đó không thể xảy ra theo thiết kế, chứ không phải bị một phép kiểm tra chặn lại.
>
> **Đo được:** 498 request sai → 497 bị từ chối đúng mã, 1 hết giờ chờ phản hồi (trạng thái ván
> không đổi), **0 được chấp nhận**. Ván khác chạy song song: p50 2,88 ms trước → 2,04 ms trong
> lúc bị tấn công → 2,32 ms sau. Không hề bị ảnh hưởng.

## E7 – Rules worker pool (đóng góp N3)

* **Thiết lập đã chạy:** tải cố định **20 bàn**. Chạy lần lượt `rules.mode=embedded` (đối chứng), rồi `remote` với 1 instance không cache / 1 instance có cache / 2 instance có cache, lặp 3 lần. Kịch bản chịu lỗi chạy riêng: **giết 1 trong 2 instance ở giây thứ 4, bật lại sau 3 s**, với 10 bàn.
* **Đo:** validation latency p50/p95, cache hit rate, throughput tổng, thời gian phục hồi sau khi kill, số ván bị hỏng (kỳ vọng 0).

| Cấu hình | Validation p50 (ms) | p95 (ms) | Cache hit (%) | Nước đi/s | Move p95 tổng (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| embedded (đối chứng) | **12,7** | 32,7 | – | – | 32,7 |
| remote 1, không cache | 13,9 | 33,0 | 0 | – | 33,0 |
| remote 1, có cache | 13,4 | 31,6 | *chưa đo* | – | 31,6 |
| remote 2, có cache | 13,4 | 33,9 | *chưa đo* | – | 33,9 |
| remote 4, có cache | *chưa đo* | | | | |

| Sự kiện | Thời điểm | Recovery time (s) | Ván lỗi | Ván mất |
| --- | --- | ---: | ---: | ---: |
| Kill 1/2 instance | giây 4 | ~3 (tự hồi phục khi bật lại) | 0 | **0** — 10/10 ván xong |
| Kill toàn bộ instance | – | *chưa đo riêng* | | kỳ vọng 0 (ván PAUSED) |

## E8 – TCP thuần vs WebSocket (stretch)

* **Thiết lập đã chạy:** 50 khán giả qua TCP thuần và 50 khán giả qua WebSocket gateway, **cùng một ván**, đo trong 20 s.
* **Đo:** `overhead = (byte đọc trên socket − byte của frame CGP) / số message`, và độ trễ tới khán giả lấy mốc là thời điểm **người chơi** nhận `MOVE_APPLIED` (cùng tiến trình nên không cần đồng hồ chung).
  **Không** lấy "byte trung bình mỗi message" của hai bên rồi trừ nhau: hai bên nhận số lượng và loại message khác nhau, mà `GAME_SNAPSHOT` lớn hơn `MOVE_APPLIED` hàng chục lần — hiệu số đó phản ánh khác biệt về *mix* message chứ không phải về cách đóng khung. Lần đo đầu mắc lỗi này và ra 6,19 byte thay vì 2,03.

| Transport | Overhead/message (byte) | p95 latency (ms) | CPU gateway (%) |
| --- | ---: | ---: | ---: |
| TCP thuần | **0** (CGP tự đóng khung) | 4,05 | *chưa đo* |
| WebSocket | **2,03** | 5,28 | *chưa đo* |

---

## Những mục chưa đo được và vì sao

| Mục | Lý do |
| --- | --- |
| E1/E2 ở 200 và 400 bàn | Máy đo không đủ CPU để 400–800 bot Node và server Java cùng chạy mà không tự làm nhiễu phép đo. Cần tách client sang máy thứ hai. |
| E3 với 10 / 50 spectator | Kênh khán giả đã chạy được (xem E8) nhưng chưa ghép vào kịch bản đo byte của E3. |
| E7 với 4 instance | Ở 20 bàn, instance thứ hai đã không cải thiện gì (13,4 so với 13,4 ms), nên thêm instance thứ tư không trả lời thêm câu hỏi nào. Cần tải lớn hơn mới có ý nghĩa. |
| E7 cache hit rate | Chưa xuất số liệu hit/miss của `RulesClient` ra CSV; hiện chỉ in ở dòng tổng kết lúc tắt server. |
| E8 CPU của gateway | Chưa đo riêng CPU theo tiến trình. |
| Kill **toàn bộ** rules instance | Mới đo kịch bản giết 1 trong 2 instance. |

Tất cả đều là thiếu **dữ liệu**, không phải thiếu **chức năng** — cơ chế tương ứng đều đã chạy được.

## Bảng tổng hợp cho mục Results của báo cáo

| Mục tiêu | Ngưỡng đặt ra | Kết quả đo | Đạt? |
| --- | --- | --- | --- |
| O2 – drift đồng hồ ở delay 300 ms | ≤ 100 ms | **415 ms** | **Không** — trần bù 200 ms chặn, xem RESULTS §6 |
| O3 – nối lại không mất nước đi | 0 nước | **0 nước** (30 ca) | **Đạt** |
| O4 – 100 bàn, move p95 | ≤ 100 ms | **103,7 ms** | **Suýt** — lệch 3,7 % |
| O5 – tiết kiệm băng thông | ≥ 60 % | **86,8 %** | **Đạt** |
| O6 – rules service chết | 0 ván mất | **0 ván mất** | **Đạt** |

## Những câu phải trả lời trong phần Discussion (`README.md` §15)

1. Khi tăng số bàn thì độ trễ tăng theo dạng nào, và điểm gãy nằm ở đâu?
2. Bottleneck là CPU của server, round-trip tới rules service, hay hàng đợi ghi DB? Chứng minh bằng số nào?
3. Vì sao NIO thắng blocking, và ở mức tải thấp thì blocking có thắng không?
4. Cache theo FEN giúp được bao nhiêu, và vì sao hit rate cao ở khai cuộc nhưng thấp ở tàn cuộc?
5. Bù RTT có tác dụng phụ gì (client báo RTT sai để ăn gian thì sao)?
6. Hạn chế của phép đo: chạy trên một máy, bot đánh ngẫu nhiên nên phân bố nước đi khác người thật.
