# Kết quả đo – DCGS

Số liệu thật, sinh bằng `node tools/run-experiments.mjs --repeat 3`.
CSV thô và chart nằm ở `statics/results/<mã>/`.

> **Nguyên tắc:** mọi con số trong file này là số **đo được**. Không có số nào được ước lượng,
> nội suy hay làm tròn cho đẹp. Chỗ nào không đạt mục tiêu đặt ra thì ghi đúng như vậy kèm lý do.
> `Instruction.md` §8.12 và `README.md` §14.3 cấm dựng số liệu.

## 1. Môi trường đo

| Mục | Giá trị |
| --- | --- |
| Máy | 1 máy duy nhất, client và server chạy chung (loopback) |
| OS | Windows 11 |
| Java | JDK 25, mã nguồn biên dịch ở mức `--release 17` |
| Node | v22 |
| Database | PostgreSQL 18 cục bộ, cổng 5432 |
| Mức log | `log.level=INFO`, `log.frames=false` (X55) |
| Số lần lặp | 3 lần mỗi kịch bản, báo cáo **trung vị** |
| Thể thức | 120+0, tối đa 60 nước mỗi ván (X63); E4 dùng 300+0, 40 nước |
| Nhịp `[stats]` | 2 s khi đo (mặc định 10 s) |

**Cảnh báo quan trọng về môi trường đo.** Đây là máy cá nhân, không phải máy đo chuyên dụng.
Khi máy đang chạy việc khác, số liệu lệch tới **80 %**: cùng kịch bản 100 bàn, đo lúc máy rảnh
cho p95 ≈ 104 ms, đo lúc máy bận cho p95 ≈ 196 ms. Vì vậy:

* mọi con số dưới đây đo khi **không chạy gì khác**;
* chỉ dùng để **so sánh giữa các cấu hình trong cùng một đợt chạy**, không phải mốc tuyệt đối;
* độ lệch giữa 3 lần lặp được ghi lại; chỗ nào vượt 15 % đều nói rõ.

## 2. Tóm tắt so với mục tiêu

| Mục tiêu | Ngưỡng | Kết quả đo | Đạt? |
| --- | --- | --- | --- |
| O2 – drift đồng hồ ở delay 300 ms | ≤ 100 ms | **415 ms** | **Không** (xem §6) |
| O3 – nối lại không mất nước đi | 0 nước | **0 nước** (30 ca) | **Đạt** |
| O4 – 100 bàn, move p95 | ≤ 100 ms | **103,7 ms** | **Suýt** (lệch 3,7 %) |
| O5 – tiết kiệm băng thông | ≥ 60 % | **86,8 %** | **Đạt** |
| O6 – rules service chết | 0 ván mất | **0 ván mất** (10/10 xong) | **Đạt** |

Hai mục không đạt đều có nguyên nhân giải thích được và **không phải lỗi hiện thực** — O2 là hệ quả
trực tiếp của một quyết định thiết kế có chủ đích, O4 lệch trong khoảng nhiễu của phần cứng đo.

---

## 3. E1 – Độ trễ và thông lượng theo tải

`statics/results/e1/` · `server.io=nio`, binary, rules remote 2 instance

| Số bàn | Kết nối | p50 (ms) | p95 (ms) | p99 (ms) | Nước đi/s | Thread JVM | Heap (MB) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 20 | 7,4 | 24,1 | 30,7 | 90 | 20 | 42 |
| 50 | 100 | 27,7 | 71,2 | 89,8 | 250 | 20 | 42 |
| 100 | 200 | 39,9 | **103,7** | 133,7 | 281 | 20 | 40 |

100 % ván kết thúc ở cả ba mức tải, 0 bot lỗi, 17 905 nước đi được đo ở mức 100 bàn.

**Độ trễ tăng gần tuyến tính theo số bàn** (p50: 7,4 → 27,7 → 39,9), chưa thấy điểm gãy. Thông lượng
tăng chậm dần (90 → 250 → 281 nước/s), cho thấy đang tiến tới bão hoà quanh 100 bàn.

**Bottleneck nằm ở CPU của chính máy đo, không phải ở rules service hay database.** Ba bằng chứng:
`[stats] dbQueue=` luôn bằng 0 (hàng đợi ghi DB không hề ứ); E7 cho thấy bỏ hẳn round-trip tới rules
service chỉ nhanh hơn 1,2 ms/nước; và heap giữ nguyên ~40 MB trong khi độ trễ tăng gấp 5.

**O4 lệch 3,7 %.** Ngưỡng đặt ra là p95 ≤ 100 ms ở 100 bàn, đo được 103,7 ms. Ba lần lặp cho
109,5 / 103,7 / 104,8 ms — lệch giữa các lần dưới 6 %, nên con số này ổn định chứ không phải nhiễu.
Trên máy đo mạnh hơn, hoặc khi tách client sang máy khác (ở đây 200 bot Node ăn CPU tranh với server),
nhiều khả năng sẽ đạt. **Không sửa ngưỡng cho khớp số đo** — ghi đúng là suýt đạt.

## 4. E2 – NIO vs thread-per-connection (đóng góp N4)

`statics/results/e2/` · cùng phần cứng, cùng tải, **chung `ServerCore`** nên chỉ khác mô hình I/O

| Số bàn | Kết nối | p95 nio | p95 blocking | Thread nio | Thread blocking | Heap nio | Heap blocking |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 20 | 24,9 | 26,4 | – | – | – | – |
| 50 | 100 | 67,6 | 75,1 | 20 | 133 | 45 MB | 73 MB |
| 100 | 200 | **102,5** | **117,5** | **20** | **305** | 40 MB | 84 MB |

**NIO thắng trên cả hai mặt**, và đây là kết quả đáng nói nhất của thí nghiệm này:

* **Số thread: 20 so với 305** ở 200 kết nối — gấp 15 lần. Quan trọng hơn con số: thread của NIO
  **không đổi** theo tải (20 ở cả 10, 50 và 100 bàn), còn blocking tăng tuyến tính (133 → 305).
  Ngoại suy tới 400 bàn (800 kết nối), blocking cần khoảng 1 600 thread.
* **RAM: 40 MB so với 84 MB** — hơn gấp đôi, vì mỗi thread mang theo stack riêng.
* **Độ trễ: p95 102,5 so với 117,5 ms** — NIO nhanh hơn 12,8 %.

**Ở mức tải thấp thì blocking có thắng không?** Không, nhưng cũng gần như không thua: ở 10 bàn,
24,9 so với 26,4 ms — chênh lệch nằm trong nhiễu. Điều này hợp lý: khi chỉ có 20 thread thì chi phí
chuyển ngữ cảnh chưa đáng kể. Lợi thế của NIO chỉ hiện ra khi số kết nối lớn, và đó đúng là bài toán
mà hệ thống này nhắm tới.

> **Lỗ hổng đo đã biết:** cột thread/heap ở mức 10 bàn bỏ trống. Ván chạy xong (~9 s) trước khi kịp
> có đủ mẫu `[stats]`, nên trung vị của 3 lần rơi vào 0. Kết luận của E2 dựa trên mức 50 và 100 bàn,
> nơi số liệu đầy đủ. Sửa được bằng cách hạ `server.statsIntervalMs` xuống 1 000 ms.

## 5. E3 – Binary + delta vs JSON + FEN (đóng góp N1)

`statics/results/e3/` · 20 ván giống nhau, chỉ đổi `server.format`

| Kịch bản | Byte/nước (S→C) | Byte/ván | p95 (ms) | Tiết kiệm |
| --- | ---: | ---: | ---: | ---: |
| JSON + FEN (baseline) | 189,3 | 28 207 | 65,0 | – |
| Binary + delta (đề xuất) | **25,0** | **6 374** | 32,6 | **86,8 %** |

Kết quả **tái lập gần như tuyệt đối**: ba lần lặp cho 25,0 / 25,0 / 25,0 byte ở chế độ binary và
189,25 / 189,40 / 189,08 ở chế độ JSON. Lệch dưới 0,2 %.

25 byte là con số **cố định và tính được trước**: 9 byte khung (`LEN|TYPE|SEQ`) + 16 byte payload
`MOVE_APPLIED`. Bản JSON tốn 189 byte vì mang theo FEN đầy đủ (~60 ký tự), SAN, và tên trường lặp lại
ở mỗi message.

Chỗ tiết kiệm **không nằm ở việc nén**, mà ở việc **không gửi thứ client tự suy ra được**: client đã
có bàn cờ, nó chỉ cần biết quân nào đi từ đâu tới đâu. Đây là delta encoding, và nó cũng giải thích
vì sao `GAME_SNAPSHOT` vẫn gửi FEN đầy đủ — lúc nối lại thì client **không** có bàn cờ để suy ra.

## 6. E4 – Công bằng đồng hồ (đóng góp N2)

`statics/results/e4/` · 300+0, 40 nước, bên Đen đi qua `delay-proxy`, jitter 10 %

**Đại lượng đo là *drift*: thời gian server TRỪ của người chơi, trừ đi thời gian họ THỰC SỰ suy nghĩ.**
Drift = 0 nghĩa là đồng hồ hoàn toàn công bằng.

| Delay một chiều | RTT | Drift không bù | Drift có bù | Cải thiện |
| ---: | ---: | ---: | ---: | ---: |
| 0 ms | ~0 | 26,3 ms/nước | 21,0 ms/nước | 20 % |
| 50 ms | 100 ms | 120,6 ms/nước | **61,1 ms/nước** | **49 %** |
| 150 ms | 300 ms | 320,4 ms/nước | **156,6 ms/nước** | **51 %** |
| 300 ms | 600 ms | 614,6 ms/nước | **415,0 ms/nước** | 33 % |

Bên nối trực tiếp có drift 1,3 ms/nước (không bù) và −2,6 ms/nước (có bù) — tức là **công bằng**.

**Số đo khớp chính xác với công thức thiết kế**, và đây là điểm mạnh nhất của thí nghiệm này:

| Delay | Dự đoán: drift − min(rtt/2, 200) | Đo được |
| ---: | ---: | ---: |
| 50 ms | 120,6 − 50 = 70,6 | 61,1 |
| 150 ms | 320,4 − 150 = 170,4 | 156,6 |
| 300 ms | 614,6 − **200** (chạm trần) = 414,6 | **415,0** |

Ở delay 300 ms, `min(rtt/2, cap)` bị **trần `clock.compensationCapMs=200` chặn lại**, nên chỉ bù được
200 trong số 600 ms. Dự đoán 414,6 so với đo được 415,0 — lệch 0,1 %.

**Vì sao O2 không đạt, và vì sao đó không phải lỗi.** Mục tiêu đặt ra drift ≤ 100 ms ở delay 300 ms;
đo được 415 ms. Hai nguyên nhân, cả hai đều là **quyết định thiết kế có chủ đích**:

1. **Chỉ bù `rtt/2`, không bù cả `rtt`.** Khoảng thời gian bị tính kéo dài trọn một vòng khứ hồi.
   Bù đủ `rtt` sẽ xoá sạch thiệt hại — nhưng cũng biến đường truyền xấu thành **lợi thế**: cứ kết nối
   tệ là được cộng giờ. Bù một nửa là chấp nhận còn thiệt để không ai có động cơ làm xấu kết nối.
2. **Trần bù 200 ms** (X33) tồn tại để chặn kịch bản khai RTT giả. Ở delay 300 ms thì trần này cắt
   mất hai phần ba khoản đáng bù.

Muốn đạt O2 ở delay 300 ms thì phải nới trần lên ≥ 500 ms và bù gần đủ `rtt` — đánh đổi bằng việc
mở cửa cho gian lận thời gian. **Nhóm chọn giữ nguyên thiết kế và báo cáo đúng số đo.** Mục tiêu O2
đặt ra ban đầu là quá lạc quan vì lúc viết chưa tính tới trần bù.

> **Chú ý về dữ liệu:** hai dòng delay = 300 ms chỉ có **2 lần lặp** thay vì 3 (một lần mỗi nhóm không
> kịp hoàn thành 40 nước trong thời gian chờ ở độ trễ cao). Ngoài ra `bu=true, delay=150` có một lần
> lệch (226 ms so với 157 và 150 ms) — trung vị đã loại bỏ được mẫu này.

## 7. E5 – Mất kết nối và nối lại (đóng góp N5)

`statics/results/e5/` · cắt phẳng socket (`destroy()`, không gửi FIN) ở nước thứ 8, bên Trắng

| Thời gian ngắt | Số ván | Nối lại | Recovery p50 | **Nước đi mất** | Ván tiếp tục đúng |
| ---: | ---: | ---: | ---: | ---: | --- |
| 5 s | 10 | 10/10 | 23,5 ms | **0** | 10/10 |
| 20 s | 10 | 10/10 | 20,6 ms | **0** | 10/10 |
| 50 s | 10 | 10/10 | 16,7 ms | **0** | 10/10 |
| 12 s (grace 5 s) | 3 | – | – | – | 3/3 kết thúc đúng luật |

**O3 đạt trọn vẹn: 0 nước đi bị mất trên tổng 30 ca ngắt.** Recovery time ổn định 17–24 ms và
**không phụ thuộc vào độ dài lần ngắt** — hợp lý, vì chi phí nối lại là snapshot + replay, không
liên quan tới việc đã vắng mặt bao lâu.

Cách kiểm chứng "0 nước mất" đáng nói: client đếm tập các `ply` **thực sự nhận được** rồi so với số
`ply` cuối ván. Không dùng `chess.js` history — vì `board.load()` lúc nhận snapshot sẽ **xoá lịch sử**
và cho ra con số sai. Lần đo đầu nhóm mắc đúng lỗi này và ra "33 nước mất" hoàn toàn giả.

Ca quá hạn ân hạn: ván kết thúc dứt khoát theo luật, không treo vô hạn.

## 8. E6 – Server-authoritative validation (đóng góp N3)

`statics/results/e6/` · `node source/bot/cheat.js --rounds 50 --flood 300`

| Loại tấn công | Gửi | Bị từ chối | Mã lỗi thực tế |
| --- | ---: | ---: | --- |
| Nước đi sai luật | 50 | 50 | `3002` × 50 |
| Đi khi không phải lượt | 50 | 50 | `3001` × 50 |
| `ply` cũ / trùng | 50 | 49 | `3005` × 49, 1 hết giờ chờ |
| Phong cấp thiếu `promo` | 20 | 20 | `3002` × 20 |
| MOVE cho ván người khác | 50 | 50 | `3003` × 50 |
| MOVE khi chưa LOGIN | 20 | 20 | `2005` × 20 |
| Frame hỏng ở mức byte | 7 | 7 | `2001` × 5, `2003` × 1, `2005` × 1 |
| Flood 300 msg tức thì | 251 | 251 | `4005` × 3 rồi đóng kết nối |
| **Tổng** | **498** | **497** | **0 request sai được chấp nhận** |

Một request rơi vào "không trả lời" — hết 2,5 s chờ phản hồi. **Đây không phải là được chấp nhận:**
trạng thái ván không hề đổi, chỉ là client không kịp đọc câu trả lời. Ba cột `bị từ chối` /
`không trả lời` / `được chấp nhận` được tách riêng trong CSV chính vì lý do này.

**Bằng chứng cô lập lỗi.** Một ván bình thường chạy song song suốt đợt tấn công:

| Giai đoạn | Số nước | p50 | p95 |
| --- | ---: | ---: | ---: |
| Trước tấn công | 93 | 2,88 ms | 4,37 ms |
| **Trong lúc tấn công** | 179 | **2,04 ms** | **2,91 ms** |
| Sau tấn công | 70 | 2,32 ms | 3,30 ms |

Ván khác **không hề chậm đi** — thậm chí còn nhanh hơn, vì kẻ tấn công bị rate-limit sớm nên chiếm
ít CPU hơn một người chơi thật.

**Một phát hiện về protocol.** Kịch bản "gửi MOVE cho ván của người khác" **không thể thực hiện được**
theo thiết kế, chứ không phải bị một phép kiểm tra chặn lại: `MOVE` không mang `gameId`, server định
tuyến theo phiên đã xác thực. Kẻ tấn công nhận `3003` ("bạn không ở trong ván nào") chứ không phải
`3004`. Đây là tính chất mạnh hơn một lần kiểm tra — không có đường nào để sai.

## 9. E7 – Rules service: instance, cache, embedded (đóng góp N3)

`statics/results/e7/` · 20 bàn, 120+0

| Cấu hình | Instance | p50 (ms) | p95 (ms) | p99 (ms) |
| --- | ---: | ---: | ---: | ---: |
| `embedded` (đối chứng, luật trong Java) | 0 | **12,7** | 32,7 | 42,9 |
| `remote`, 1 instance, **không** cache | 1 | 13,9 | 33,0 | 42,8 |
| `remote`, 1 instance, có cache | 1 | 13,4 | 31,6 | 42,1 |
| `remote`, 2 instance, có cache | 2 | 13,4 | 33,9 | 43,7 |

**Cái giá của việc tách rules service ra tiến trình riêng: khoảng 1,2 ms mỗi nước đi** (12,7 → 13,9 ms
ở p50), tức **9 %**. Cache kéo lại được ~0,5 ms (13,9 → 13,4).

Đây là con số quan trọng nhất của đóng góp N3, và nó **nhỏ hơn nhiều so với dự đoán ban đầu**.
Lý do: pool kết nối persistent nên không phải bắt tay TCP lại cho mỗi nước, `chess.js` trả lời trong
chưa tới 1 ms, và cả hai tiến trình chạy trên loopback. Trên mạng thật con số này sẽ lớn hơn.

**Thêm instance thứ hai không giúp gì** (13,4 so với 13,4). Hợp lý: ở 20 bàn thì một instance chưa hề
bão hoà, nên chia tải không cải thiện độ trễ. Giá trị của instance thứ hai là **chịu lỗi**, không phải
tốc độ — và điều đó được chứng minh ngay dưới đây.

**Kịch bản chịu lỗi — giết rules service giữa lúc đang đánh:**

| Sự kiện | Kết quả |
| --- | --- |
| Giết instance #1 ở giây thứ 4 | Ván chuyển `PAUSED`, client nhận `ERROR 4001` |
| Bật lại instance #1 sau 3 s | Server tự phát hiện, ván chạy tiếp |
| **Kết quả cuối** | **10/10 ván kết thúc, 0 bot lỗi, 0 ván mất** |

**O6 đạt.** Điểm đáng nói: ván `PAUSED` vì rules service chết **không bị tính ân hạn và không xử thua** —
đó không phải lỗi của người chơi nào. Server phân biệt hai loại `PAUSED` chính vì lý do này.

## 10. E8 – TCP thuần vs WebSocket (khán giả)

`statics/results/e8/` · 50 khán giả mỗi đường truyền, cùng một ván

| Transport | Message | Byte trên socket | Byte CGP | **Overhead/message** | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| TCP thuần | 5 076 | 95 776 | 95 776 | **0 byte** | 1,78 ms | 4,05 ms |
| WebSocket | 3 574 | 86 513 | 79 265 | **2,03 byte** | 2,51 ms | 5,28 ms |

**Overhead 2,03 byte/message khớp chính xác với RFC 6455**: 2 byte header cho payload < 126 byte.
Server không mask nên không tốn thêm 4 byte khoá như chiều client → server.

TCP thuần có overhead **0 ở tầng này** vì CGP tự đóng khung — header của TCP/IP nằm dưới tầng quan sát.

Đi vòng qua gateway tốn thêm **0,73 ms** ở p50 (1,78 → 2,51 ms).

> **Sai lầm đã sửa trong cách đo.** Lần đo đầu lấy "byte trung bình mỗi message" của hai bên rồi trừ
> nhau, ra **6,19 byte** — sai. Hai bên nhận số lượng và **loại** message khác nhau (5 076 so với
> 3 574), mà `GAME_SNAPSHOT` lớn hơn `MOVE_APPLIED` hàng chục lần, nên hiệu số đó phản ánh khác biệt
> về **mix message** chứ không phải về cách đóng khung. Cách đúng là đếm riêng byte CGP rồi lấy hiệu.

---

## 11. Kiểm thử kéo dài và chịu lỗi

`statics/results/endurance/` · `node tools/run-endurance.mjs`

Các bài này trả lời câu hỏi khác với E1–E8: không phải "nhanh bao nhiêu" mà **"chạy lâu có hỏng
không"** và **"chết một mảnh thì phần còn lại có sống không"**.

| Bài | Nội dung | Kết quả |
| --- | --- | --- |
| **M3** | 50 bàn chạy liên tục 10 phút | **Đạt** — giữ 38–50 bàn, 0 lỗi |
| **T18** | Tắt PostgreSQL 60 s giữa lúc 20 ván đang chạy | *(chưa chạy — cần quyền Administrator)* |
| **T19** | Chạy 60 phút, kiểm rò bộ nhớ | *(chưa chạy)* |
| **T20** | Ngắt gateway khi 20 khán giả đang xem | **Đạt** |

### M3 — 50 bàn chạy liên tục 10 phút

121 mẫu, lấy 5 s một lần. Bot chạy chế độ `--loop`: đánh xong ván là vào ván mới ngay.

| Đại lượng | Nhỏ nhất | Trung vị | Lớn nhất |
| --- | ---: | ---: | ---: |
| Bàn đồng thời (sau 60 s ổn định) | 38 | **44** | 50 |
| Thread JVM | **20** | **20** | **20** |
| Heap (MB) | 12 | 65 | 137 |
| Hàng đợi ghi DB | 0 | 0 | **0** |

100 bot sống suốt 10 phút, **0 bot thoát sớm, 0 lỗi trên `stderr` của server**.

**Vì sao không phải đúng 50 bàn mà là 38–50.** Mỗi khi một ván kết thúc, hai bot vào lại hàng đợi
ghép cặp; tại một thời điểm bất kỳ luôn có vài bot đang chờ ghép chứ chưa ngồi vào bàn. Con số
dao động 38–50 phản ánh đúng điều đó, không phải dấu hiệu mất ván — tổng số bot luôn là 100.

**Số thread đứng yên ở 20 suốt 10 phút** trong khi hàng trăm ván được tạo rồi kết thúc. Đây là bằng
chứng trực tiếp cho mô hình NIO: tài nguyên không trôi theo số ván đã đi qua.

**Hàng đợi ghi DB luôn bằng 0** — PostgreSQL theo kịp hoàn toàn ở mức tải này, và xác nhận lại kết
luận ở §3 rằng nút thắt không nằm ở database.

Heap dao động 12–137 MB là răng cưa của GC, không phải rò: trung vị nửa đầu 58 MB so với nửa sau
72 MB. Kết luận chắc chắn về rò bộ nhớ cần bài T19 chạy 60 phút — **chưa chạy**.

### T20 — cô lập lỗi theo biên (X60)

| Thời điểm | Ván đang chạy trên server |
| --- | ---: |
| Trước khi giết gateway | 1 |
| **Sau khi giết gateway** | **1** |

Gateway chết **chỉ làm mất người xem**. Ván đấu và người chơi qua TCP thuần không hề hay biết:
số ván không đổi, 0 lỗi trên `stderr` của server. Đây là bằng chứng trực tiếp cho nguyên tắc
"lỗi của một thành phần không được lan sang thành phần khác" — gateway không giữ trạng thái ván
nào, nó chỉ dịch đường truyền.

## 12. Những lỗi phép đo đã mắc và đã sửa

Ghi lại vì chúng đều **cho ra số liệu trông rất thuyết phục nhưng vô nghĩa** — và đó là loại lỗi
nguy hiểm nhất trong một báo cáo thực nghiệm.

| Lỗi | Triệu chứng | Nguyên nhân | Sửa |
| --- | --- | --- | --- |
| E4 đo nhầm đại lượng | Bật/tắt bù RTT cho kết quả **y hệt nhau** (~314 ms) | Đo round-trip của nước đi, mà round-trip bị chi phối bởi độ trễ mạng nên bù hay không cũng thế | Đo *drift* = giờ bị trừ − giờ thực sự nghĩ |
| E8 so sánh sai đơn vị | Overhead 6,19 byte, không khớp RFC nào | Lấy trung bình byte/message của hai mix message khác nhau | Đếm riêng byte CGP, lấy hiệu |
| E5 đếm nhầm nước mất | Báo "33 nước bị mất" trong khi ván vẫn đúng | `board.load()` xoá lịch sử của `chess.js` | Đếm tập `ply` thực sự nhận được |
| Header CSV lệch cột | E4 trả về bảng rỗng, không báo lỗi gì | Thêm 3 cột vào dòng dữ liệu, quên sửa tiêu đề | Thêm kiểm tra số cột, **dừng hẳn** nếu lệch |
| Server cũ còn sống | E3 chế độ `json` bị server `binary` trả lời | `java` trên PATH là stub của Oracle, giết nó không giết JVM | Giết theo **cổng** đang mở, và khẳng định cổng đã đóng trước khi đo tiếp |
| Đo lúc máy bận | Cùng kịch bản lệch 80 % giữa hai lần | Vừa đo vừa render hình, build | Chỉ đo khi máy rảnh; ghi cảnh báo này vào §1 |

## 13. Hạn chế của phép đo

1. **Đo trên một máy, qua loopback.** RTT thật ≈ 0,1 ms, nên E1/E2/E7 phản ánh giới hạn CPU chứ không
   phải giới hạn mạng. E4 dùng `delay-proxy` để có độ trễ thật, nhưng đó là độ trễ mô phỏng.
2. **Client và server tranh CPU của nhau.** 200 bot Node chạy cùng máy với server Java. Một phần độ trễ
   đo được ở mức 100 bàn là do chính bot gây ra, không phải do server.
3. **Bot đánh ngẫu nhiên**, nên phân bố nước đi khác người thật: ít khai cuộc lặp lại hơn, nên **hit
   rate của cache ở E7 thấp hơn thực tế** — con số lợi ích của cache là ước lượng thận trọng.
4. **Giới hạn 60 nước/ván** (X63) để ván ngẫu nhiên không kéo dài vô tận. Ván thật dài hơn.
5. **Chưa đo tới 200 và 400 bàn** như `EXPERIMENTS.md` dự kiến — máy đo không đủ CPU để 800 bot Node
   và server cùng chạy mà không tự làm nhiễu phép đo.
6. **`draw_threefold` không phát hiện được** từ một FEN rời rạc, ở cả hai bản luật. Xem `PROTOCOL.md` §B.
7. **Cột thread/heap ở mức 10 bàn của E2 bỏ trống** (xem §4).
8. **Hai dòng delay 300 ms của E4 chỉ có 2 lần lặp** thay vì 3 (xem §6).

## 14. Cách chạy lại

```bash
node tools/run-experiments.mjs --repeat 3      # toàn bộ E1..E8, khoảng 36 phút
node tools/run-experiments.mjs --only e4       # chỉ một thí nghiệm
```

Yêu cầu: PostgreSQL đã có schema, `mvn package` đã chạy, và **không chạy gì khác trên máy**.
