-- ============================================================
-- DCGS - Distributed Chess Game Server
-- Schema cho PostgreSQL 18
--
-- Chay:  psql -U postgres -h 127.0.0.1 -f schema.sql
-- Script nay CHAY LAI DUOC (idempotent): moi doi tuong deu IF NOT EXISTS
-- hoac ON CONFLICT DO NOTHING.
--
-- Quy uoc bam mat khau (server Java dung dung cong thuc nay):
--   password_hash = lower(hex(sha256(username || ':' || password)))
-- ============================================================

-- ---------- 1. Database va role ----------
-- Chay phan nay bang superuser (postgres). Neu database da ton tai, psql bao
-- loi va bo qua dong do - khong anh huong cac lenh sau.
SELECT 'CREATE DATABASE dcgs ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'dcgs')\gexec

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dcgs_app') THEN
    CREATE ROLE dcgs_app LOGIN PASSWORD 'dcgs_app_pw';
  END IF;
END $$;

\connect dcgs

-- ---------- 2. Bang ----------

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      VARCHAR(32)  NOT NULL UNIQUE,
  password_hash CHAR(64)     NOT NULL,
  elo           INTEGER      NOT NULL DEFAULT 1200,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username ~ '^[A-Za-z0-9_]{3,32}$'),  -- X17
  CONSTRAINT users_elo_range       CHECK (elo BETWEEN 100 AND 4000)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      UUID        PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id    BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL           -- X12: server tu gia han khi con van dang danh
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS games (
  id           BIGSERIAL PRIMARY KEY,
  white_id     BIGINT      NOT NULL REFERENCES users(id),
  black_id     BIGINT      NOT NULL REFERENCES users(id),
  time_control VARCHAR(16) NOT NULL,        -- "300+2"
  status       VARCHAR(12) NOT NULL DEFAULT 'WAITING',
  result       VARCHAR(8),                  -- 1-0 | 0-1 | 1/2-1/2
  reason       VARCHAR(32),                 -- checkmate | timeout | resign | stalemate | ...
  pgn          TEXT,
  started_at   TIMESTAMPTZ,
  ended_at     TIMESTAMPTZ,
  CONSTRAINT games_status_valid CHECK (status IN ('WAITING','IN_PROGRESS','PAUSED','FINISHED','ABORTED')),
  CONSTRAINT games_result_valid CHECK (result IS NULL OR result IN ('1-0','0-1','1/2-1/2')),
  CONSTRAINT games_distinct_players CHECK (white_id <> black_id)   -- X21
);
CREATE INDEX IF NOT EXISTS games_status_idx ON games(status);
CREATE INDEX IF NOT EXISTS games_white_idx  ON games(white_id);
CREATE INDEX IF NOT EXISTS games_black_idx  ON games(black_id);

-- Nguon du lieu de REPLAY khi RESUME (X14) va de xuat PGN.
CREATE TABLE IF NOT EXISTS moves (
  game_id    BIGINT      NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply        INTEGER     NOT NULL,
  uci        VARCHAR(5)  NOT NULL,          -- e2e4, e7e8q
  san        VARCHAR(8)  NOT NULL,
  fen_after  VARCHAR(90) NOT NULL,
  clock_w_ms INTEGER     NOT NULL,
  clock_b_ms INTEGER     NOT NULL,
  server_ts  BIGINT      NOT NULL,          -- moc thoi gian server nhan nuoc di (X25)
  PRIMARY KEY (game_id, ply)                -- X46: ghi lai lan nua khong tao ban ghi trung
);

-- Nhat ky cac request bi tu choi: bang chung cho thi nghiem E6.
CREATE TABLE IF NOT EXISTS rejected_moves (
  id         BIGSERIAL PRIMARY KEY,
  game_id    BIGINT,
  user_id    BIGINT,
  error_code INTEGER     NOT NULL,
  detail     VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rejected_code_idx ON rejected_moves(error_code);

-- ---------- 3. Quyen ----------
GRANT CONNECT ON DATABASE dcgs TO dcgs_app;
GRANT USAGE ON SCHEMA public TO dcgs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dcgs_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dcgs_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dcgs_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dcgs_app;

-- ---------- 4. Tai khoan mau ----------
-- Mat khau cua ca 6 tai khoan: chess123
-- hash = sha256(username || ':' || 'chess123')
INSERT INTO users (username, password_hash, elo) VALUES
  ('alice', '6eff4393474dd47aff6ddfc90fe67460bbb439cff453399637b2fe044c34b039', 1200),
  ('bob',   '0c6de9b4b54c19efb9df850c2f951d2390f5efcc89cabe1b410b9a012d4ee0a4', 1200),
  ('carol', '2ad8493e52a236f1b1756eea58606368ddc7cb84d82f87f59a30bdd257f20c17', 1350),
  ('dave',  '26a1da3e7ead15d46855b8f20e173b0f88950a3aac053729d38c2550bce1b666', 1050),
  ('bot1',  '53cb1a1c22f352b88227cbb68103ca5b07bfbac720594610ca17da01a942060c', 1200),
  ('bot2',  '2bef060ca5095e9cc2730f5f04b23a43b906795978fa21b324392f1781fb4ecc', 1200)
ON CONFLICT (username) DO NOTHING;

-- Bot sinh tai cho thuc nghiem dung tien to bot_, tao san 400 tai khoan.
INSERT INTO users (username, password_hash, elo)
SELECT 'bot_' || generation.n,
       encode(sha256(('bot_' || generation.n || ':chess123')::bytea), 'hex'),
       1200
FROM generate_series(1, 400) AS generation(n)
ON CONFLICT (username) DO NOTHING;

-- ---------- 5. Kiem tra ----------
SELECT 'users' AS table_name, count(*) AS rows FROM users
UNION ALL SELECT 'games', count(*) FROM games
UNION ALL SELECT 'moves', count(*) FROM moves;
