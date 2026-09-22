# System Architecture – DCGS

Tài liệu này phục vụ mục 5 (`README.md`) và mục 8.8 (`Instruction.md`) của báo cáo.
Sơ đồ export ra `statics/architecture.png`, `statics/protocol.png`.

## 1. Thành phần

| Thành phần | Ngôn ngữ | State | Trách nhiệm |
| --- | --- | --- | --- |
| **Game Server** | Java 17+ | Có state | Session, matchmaking, quản lý bàn, clock authority, broadcast, persistence |
| **Rules Service** | Node 20 + chess.js | Stateless | Kiểm tra tính hợp lệ nước đi, sinh FEN mới, phát hiện chiếu/chiếu hết/hoà |
| **Web Client** | React 19 + TS (Vite) | Client state | 3 chế độ: **online** (qua CGP), **đấu bot** (Stockfish WASM trong trình duyệt), **hai người cùng máy**. Cập nhật lạc quan + rollback, tự reconnect + RESUME, nhật ký giao thức. Giao diện và engine kế thừa từ Sir-Teo/web-chess — xem `source/web-client/NOTICE.md` |
| **Web Gateway + Spectator** | Node 20 + ws | Không | Cầu WebSocket ↔ TCP (mang nguyên frame CGP), phục vụ cả người chơi lẫn khán giả |
| **Java CLI Client** | Java 17+ | Client state | Client TCP thuần, không UI — dùng để chứng minh giao tiếp socket trực tiếp và cho thí nghiệm E8 (TCP vs WebSocket) |
| **Bot Client** | Node 20 | Không | Sinh tải thực nghiệm, ghi CSV latency |
| **Database** | **PostgreSQL 18** | Bền vững | User, session, game, move, Elo, nhật ký request bị từ chối |
| **Delay Proxy** | Node 20 | Không | Bơm delay/jitter giữa client và server để thí nghiệm E4 |

## 2. Sơ đồ tổng thể

```text
                 ┌──────────────┐        ┌──────────────┐
                 │  Web Client  │        │  Web Client  │
                 │ (React + TS) │        │ (React + TS) │
                 └──────┬───────┘        └──────┬───────┘
                        │ CGP trong WebSocket   │
                        └───────────┬───────────┘
 Java CLI Client                    ▼
      │ CGP/TCP         ┌──────────────────────┐
      │                 │  Web Gateway (Node)  │
      │                 │  WS  <->  TCP        │
      │                 └──────────┬───────────┘
      │                            │ CGP/TCP
      ▼                  ┌─────────▼────────────────────────────┐
                         │           GAME SERVER (Java)         │
 ┌──────────┐            │                                      │
 │Bot Client├───────────►│  ┌────────────────────────────────┐  │
 │  (Node)  │  CGP/TCP   │  │ Network Layer                  │  │
 └──────────┘            │  │  Acceptor + Selector(s)        │  │
                         │  │  FrameCodec / ConnectionMgr    │  │
 ┌──────────┐   CGP/TCP  │  │  HeartbeatMonitor  Backpressure│  │
 │Bot Client├───────────►│  └───────────────┬────────────────┘  │
 │  (Node)  │  (x100..400)│                  │ GameTask          │
 └──────────┘            │  ┌───────────────▼────────────────┐  │
                         │  │ Game Layer                     │  │
                         │  │  SessionManager  Matchmaker    │  │
                         │  │  GameRegistry (N bàn)          │  │
                         │  │  GameActor (serial executor)   │  │
                         │  │  ClockEngine     EventBus      │  │
                         │  └──┬──────────────────────┬──────┘  │
                         │     │ RVP/TCP pool         │ JDBC    │
                         └─────┼──────────────────────┼─────────┘
                               │                      │
              ┌────────────────┴───────┐        ┌─────▼─────┐
              ▼                        ▼        │ Postgres18│
      ┌───────────────┐        ┌───────────────┐└───────────┘
      │ Rules Service │        │ Rules Service │
      │  #1 (Node)    │        │  #2 (Node)    │
      └───────────────┘        └───────────────┘
```

## 3. Mô hình luồng trong Game Server

```text
[Acceptor thread]  OP_ACCEPT ──► gán channel cho 1 trong N IoWorker (round-robin)

[IoWorker 0..N-1]  mỗi thread giữ 1 Selector
   ├─ đọc byte ──► FrameDecoder (xử lý half-packet / gộp packet)
   ├─ decode ra Message
   └─ submit vào GameActor tương ứng (theo gameId) hoặc SessionExecutor (nếu chưa vào bàn)

[Game thread pool]  size = số core
   └─ GameActor.run(): mỗi gameId có hàng đợi riêng, thực thi TUẦN TỰ
        → không cần synchronized trên bàn cờ
        → gọi RulesClient (bất đồng bộ, callback quay lại chính actor đó)

[Scheduler thread]  ScheduledExecutorService, tick 100 ms
   ├─ quét hết giờ  → GAME_OVER(timeout)
   ├─ quét heartbeat timeout → PEER_STATUS(disconnected)
   └─ quét grace period hết hạn → xử thua / huỷ ván

[DB writer pool]  bounded queue (10k) + 2 thread ghi PostgreSQL
   └─ đầy queue → drop bản ghi metric, KHÔNG drop move (move ghi đồng bộ khi kết thúc ván)
```

**Chế độ baseline** (`server.io=blocking`): mỗi kết nối 1 thread đọc + 1 thread ghi, phần Game Layer giữ nguyên → so sánh công bằng ở E2.

## 4. Vòng đời một nước đi

```text
Client                Server                    RulesService          DB
  │  MOVE(ply,from,to)  │                            │                 │
  ├────────────────────►│ t_recv = now()             │                 │
  │                     │ check: đúng phiên? đúng lượt? ply khớp?      │
  │                     │ cache.get(fen+move) ─ hit ─┐                 │
  │                     │        │ miss              │                 │
  │                     │ RVP VALIDATE(fen,move)     │                 │
  │                     ├───────────────────────────►│                 │
  │                     │◄───────────────────────────┤ legal, fen',    │
  │                     │        RULES_OK             │ san, flags     │
  │                     │ clock: trừ (t_recv - t_sent) - min(rtt/2,200)│
  │                     │ apply state, ply++          │                │
  │  MOVE_APPLIED       │                             │  async insert  │
  │◄────────────────────┤────────────────────────────────────────────► │
  │                     │ broadcast tới đối thủ + spectators           │
```

Nếu `legal = false` → `MOVE_REJECTED(3002)`, state **không đổi**, ghi log nghi vấn gian lận.

## 5. State machine của một bàn

```text
        matchmaker ghép cặp
WAITING ──────────────────► IN_PROGRESS ──── checkmate/stalemate/resign/timeout ──► FINISHED
                               │   ▲
              mất heartbeat    │   │  RESUME trong grace period
                               ▼   │
                             PAUSED ──── hết grace 60s ──► FINISHED (xử thua / abort)
```

Đồng hồ vẫn chạy khi ở `PAUSED` (đúng như lichess) — ghi rõ quyết định thiết kế này trong báo cáo.

## 6. Cơ chế gọi Rules Service

* **Pool**: mặc định 4 kết nối persistent tới mỗi instance, request pipelined theo `SEQ` làm correlation id.
* **Chọn instance**: least-outstanding-requests.
* **Cache**: `LRU<fenKey+move, RulesResult>` 50k entry. Khai cuộc trùng lặp nhiều → hit rate cao, đo ở E7.
* **Timeout**: 200 ms/request → retry instance khác (tối đa 2 lần).
* **Circuit breaker**: 5 lỗi liên tiếp trong 10 s → mở mạch 15 s, không gửi request tới instance đó.
* **Toàn bộ instance chết**: ván chuyển `PAUSED`, client nhận `ERROR 4001`, tự hồi phục khi rules service sống lại.

> Đây là cái giá của việc tách rules sang Node: mỗi nước đi có thêm một round-trip nội bộ. Cache + pool để giảm, và chính số liệu này là nội dung thí nghiệm E7 (so với chế độ `rules.mode=embedded` dùng bảng luật tối giản trong Java làm baseline đối chứng).

## 7. Database schema (PostgreSQL 18)

Schema đầy đủ, chạy được và **chạy lại được**: [source/database/schema.sql](source/database/schema.sql).
Áp dụng bằng `source/database/setup.ps1`. Tóm tắt:

| Bảng | Vai trò | Điểm đáng chú ý |
| --- | --- | --- |
| `users` | tài khoản, Elo | `CHECK` định dạng username (X17); hash = `sha256(username || ':' || password)` |
| `sessions` | token để RESUME | `expires_at` tự gia hạn khi còn ván `IN_PROGRESS` (X12) |
| `games` | ván đấu | `CHECK` trạng thái/kết quả; `white_id <> black_id` chặn tự ghép với chính mình (X21) |
| `moves` | từng nước đi + hai đồng hồ + `server_ts` | khoá chính `(game_id, ply)` nên ghi lại không sinh bản ghi trùng (X46); nguồn **replay khi RESUME** và để xuất PGN |
| `rejected_moves` | nhật ký request bị từ chối | dữ liệu thô cho thí nghiệm E6 |

Dữ liệu mẫu: 6 tài khoản người + 400 tài khoản `bot_*` cho sinh tải, mật khẩu `chess123`.

## 8. Cấu trúc thư mục

```text
chess/
├── PROPOSAL.md  PLAN.md  ARCHITECTURE.md  PROTOCOL.md
├── EXPERIMENTS.md  REPORT-OUTLINE.md  README.md
├── report/                      # report.docx / report.pdf
├── statics/
│   ├── architecture.png  protocol.png
│   └── results/                 # CSV + chart của E1..E8
├── tools/
│   ├── delay-proxy.js           # bơm delay/jitter
│   └── plot.js                  # CSV -> chart
└── source/
    ├── common-java/             # codec CGP/RVP (Java)   – SV1
    ├── common-js/               # codec CGP/RVP (JS)     – SV1
    ├── server/                  # Game Server            – SV2 + SV3
    ├── web-client/              # React + TS (UI kế thừa)  – SV2
    ├── client-cli/              # Java TCP thuần, cho E8   – SV2
    ├── rules-service/           # Node + chess.js        – SV4
    ├── bot/                     # bot sinh tải           – SV4
    ├── web-spectator/           # gateway + UI xem       – SV4
    └── database/schema.sql
```

## 9. Cấu hình (`server/config.properties`)

```properties
server.port=5555
server.bind=0.0.0.0           # X11: bind localhost sẽ chặn máy khác trong LAN
server.io=nio                 # nio | blocking   (E2)
server.format=binary          # binary | json    (E3)
server.ioWorkers=4
server.gamePoolSize=8
server.maxConnections=1000    # vượt -> ERROR 4003 (X08)
conn.preLoginTimeoutMs=10000  # X02: kết nối im lặng bị đóng
conn.maxMsgPerSec=50          # X03: rate limit -> ERROR 4005
conn.sendQueueMax=256         # X04: backpressure
game.actorQueueMax=1000       # X53: hàng đợi mỗi bàn
draw.offerCooldownPlies=10    # X30: chống spam xin hoà
session.ttlMs=3600000         # X12: tự gia hạn khi còn ván IN_PROGRESS
clock.compensation=true       # true | false     (E4)
clock.compensationCapMs=200   # X33: trần bù, chống khai RTT giả
heartbeat.intervalMs=5000
heartbeat.timeoutMs=15000
reconnect.graceMs=60000
rules.mode=remote             # remote | embedded (E7)
rules.endpoints=127.0.0.1:6001,127.0.0.1:6002
rules.poolPerEndpoint=4
rules.timeoutMs=200
rules.cacheSize=50000
db.url=jdbc:postgresql://127.0.0.1:5432/dcgs
db.queueMax=10000             # X45: đầy -> ghi tạm ra pending-moves.log
db.connectionTimeoutMs=2000   # X47: cạn pool -> ERROR 4002
log.level=INFO                # X55: PHẢI để INFO khi chạy thực nghiệm
```

Mọi thí nghiệm bật/tắt bằng cấu hình, **không sửa code** — điều kiện để kết quả tái lập được theo yêu cầu §14 của `README.md`.
