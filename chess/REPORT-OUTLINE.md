# Dàn ý báo cáo – DCGS

Bám đúng `Instruction.md` §8 (cấu trúc technical paper). Ước lượng 25–35 trang.
Nộp Compilatio dạng `.docx`, tên file: `NhomXX_DistributedChessServer_Report.docx` (`Submission.md` §1).

| § | Mục | Nội dung chính | Người viết | Trang |
| --- | --- | --- | --- | ---: |
| 8.1 | Title | Distributed Chess Game Server: Server-Authoritative Chess với Custom Binary Protocol, Latency-Compensated Clock và Distributed Rules Validation | – | – |
| 8.2 | Abstract | Bài toán → cách tiếp cận → hiện thực → 3 con số kết quả nổi bật → đóng góp. 200–250 từ, **viết sau cùng** | SV4 | 0.5 |
| 8.3 | Keywords | network programming; client–server; binary protocol; clock synchronization; non-blocking I/O; fault tolerance | – | – |
| 8.4 | Introduction | Bối cảnh chơi cờ online; 5 vấn đề ở `PROPOSAL.md` §1; mục tiêu O1–O6; phạm vi; liệt kê đóng góp N1–N6 | SV3 | 2–3 |
| 8.5 | Background / Related Work | TCP stream & framing; blocking vs non-blocking I/O (Selector); nguyên lý NTP; kiến trúc server-authoritative trong game; các hệ thống tương tự (lichess, chess.com, Rybka-style client-side validation) và hạn chế của chúng. **Phải trích dẫn** | SV2 | 3–4 |
| 8.6 | Problem Definition | Input/output của hệ thống; ràng buộc (TCP, độ trễ, số client); giả định (LAN, người chơi không thông đồng); mô hình mạng; yêu cầu hệ thống | SV3 | 2 |
| 8.7 | Proposed Approach | 4 quyết định thiết kế: (a) binary + delta encoding, (b) đồng hồ bù RTT, (c) rules validation phân tán stateless, (d) actor tuần tự theo bàn trên NIO. Mỗi cái: ý tưởng → thuật toán/công thức → vì sao chọn | SV1 + SV3 | 5–6 |
| 8.8 | System Architecture | Sơ đồ từ `ARCHITECTURE.md` §2–3; bảng thành phần; mô hình luồng; state machine bàn cờ; schema DB | SV2 | 4 |
| 8.9 | Network Communication Design | CGP framing; bảng message; mã hoá MOVE/MOVE_APPLIED; RVP; chuỗi tương tác; bảng mã lỗi; quản lý kết nối và backpressure | SV1 | 4–5 |
| 8.10 | Implementation | Các lớp then chốt: `FrameCodec`, `IoWorker`, `ConnectionManager`, `GameActor`, `ClockEngine`, `RulesClient`, `RulesService`; cấu trúc dữ liệu; cơ chế concurrency. Chỉ trích đoạn code ngắn, không dán cả file | SV2 + SV3 | 4–5 |
| 8.11 | Experimental Setup | Phần cứng, OS, Java/Node version, PostgreSQL, cấu hình mạng, bot, delay proxy, cách đo, số lần lặp | SV4 | 2 |
| 8.12 | Results | Bảng + chart của E1–E8 (`EXPERIMENTS.md`). **Chỉ số đo thật** | SV4 | 5–6 |
| 8.13 | Discussion | 6 câu hỏi ở cuối `EXPERIMENTS.md`; giải thích vì sao ra kết quả đó, khi nào hệ thống tốt, khi nào không | Cả nhóm | 3 |
| 8.14 | Novelty and Contributions | Bảng N1–N6, mỗi dòng gắn với số liệu cụ thể của thí nghiệm nào | SV1 | 2 |
| 8.15 | Limitations | Đo trên 1–2 máy; bot đánh ngẫu nhiên; chưa có TLS; server chưa phân tán; rules service là phụ thuộc thêm; chưa chống thông đồng giữa người chơi | Cả nhóm | 1 |
| 8.16 | Future Work | TLS; nhiều game server + shared state; engine phân tích thế cờ bằng worker pool; UDP cho spectator; giải đấu | Cả nhóm | 0.5 |
| 8.17 | Conclusion | Tóm tắt bài toán – giải pháp – kết quả – đóng góp | SV3 | 0.5 |
| 8.18 | References | 10–15 nguồn: RFC 793, RFC 5905 (NTP), RFC 6455 (WebSocket), sách Java NIO, tài liệu `chess.js`, bài báo về game server architecture. **Trích dẫn trong bài, không chỉ liệt kê cuối** | SV2 | 1 |
| 8.19 | Appendix | Bảng message đầy đủ, `schema.sql`, file cấu hình, test cases, thêm chart phụ | SV1 | 3–4 |

## Quy tắc viết để giữ Compilatio ≤ 20 %

* Không chép định nghĩa TCP/socket/thread từ giáo trình hay Wikipedia. Phần Background viết theo hướng *"cơ chế này ảnh hưởng thế nào tới thiết kế của chúng tôi"*, không phải chép lý thuyết.
* Mọi bảng số liệu, sơ đồ, đoạn code đều là của nhóm → phần này không tính similarity.
* Trích dẫn trực tiếp phải để trong ngoặc kép và ghi nguồn; diễn giải lại vẫn phải ghi nguồn (`Instruction.md` §10).
* Nộp thử Compilatio ở M5 (26/10) để còn thời gian sửa.

## Hình cần chuẩn bị

| File | Nội dung | Người làm |
| --- | --- | --- |
| `statics/architecture.png` | Sơ đồ tổng thể `ARCHITECTURE.md` §2 | SV2 |
| `statics/protocol.png` | Khung frame + chuỗi tương tác | SV1 |
| `statics/results/e1_latency.png` | p50/p95/p99 theo số bàn | SV4 |
| `statics/results/e2_io_model.png` | NIO vs blocking | SV4 |
| `statics/results/e3_bytes.png` | Binary vs JSON theo số spectator | SV4 |
| `statics/results/e4_clock.png` | Drift theo delay, có/không bù | SV4 |
| `statics/results/e7_rules.png` | Throughput theo số worker + cache hit | SV4 |
| `statics/results/demo.png` | Ảnh chụp 2 client + web spectator đang chạy | SV4 |

## Kịch bản demo (5 phút, `README.md` §21)

1. Khởi động PostgreSQL → 2 rules service → game server (in ra cấu hình đang dùng).
2. 2 client Java đăng nhập, ghép cặp, đánh vài nước — chỉ ra đồng hồ và log server.
3. Mở web spectator xem đúng ván đó theo thời gian thực.
4. Client gửi nước đi bất hợp lệ bằng bot → server từ chối, hiện mã 3002, ván không hỏng.
5. Rút mạng một client 10 giây → đối thủ thấy "disconnected" → nối lại, ván tiếp tục đúng.
6. Kill một rules service → hệ thống vẫn chạy nhờ instance còn lại.
7. Chạy bot 100 bàn, mở bảng thống kê latency đang chạy trực tiếp.
