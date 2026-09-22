# Database - PostgreSQL 18

Hệ thống dùng **PostgreSQL 18** (đang chạy sẵn ở `127.0.0.1:5432`).

## Tạo database và bảng

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

Hoặc chạy tay:

```bash
"/c/Program Files/PostgreSQL/18/bin/psql.exe" -U postgres -h 127.0.0.1 -f schema.sql
```

Script tạo:

| Đối tượng | Nội dung |
| --- | --- |
| Database `dcgs` | UTF-8 |
| Role `dcgs_app` | tài khoản ứng dụng, mật khẩu mặc định `dcgs_app_pw` — **đổi trong `schema.sql` và `config.properties` trước khi nộp** |
| `users` | tài khoản, Elo; ràng buộc định dạng username (X17) |
| `sessions` | session token để RESUME (X12) |
| `games` | ván đấu, trạng thái, kết quả, PGN |
| `moves` | từng nước đi + đồng hồ + mốc thời gian server; khoá chính `(game_id, ply)` nên ghi lại không sinh bản ghi trùng (X46) |
| `rejected_moves` | nhật ký request bị từ chối — số liệu cho thí nghiệm E6 |
| Dữ liệu mẫu | 6 tài khoản người (`alice`, `bob`, `carol`, `dave`, `bot1`, `bot2`) + 400 tài khoản `bot_1..bot_400` cho sinh tải |

Mật khẩu của mọi tài khoản mẫu: **`chess123`**.
Công thức băm: `sha256(username || ':' || password)`, hex thường — server Java phải dùng đúng công thức này.

## Kiểm tra nhanh

```sql
\connect dcgs
SELECT username, elo FROM users ORDER BY id LIMIT 10;
SELECT count(*) FROM users WHERE username LIKE 'bot\_%';
```

## Script chạy lại được

Mọi lệnh đều `IF NOT EXISTS` hoặc `ON CONFLICT DO NOTHING`, nên chạy `setup.ps1` nhiều lần không hỏng dữ liệu.
