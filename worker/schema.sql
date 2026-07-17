-- 修仙游戏存档 D1 表结构
-- accounts: 账户鉴权。id 为归一化(小写)后的账户名主键，salt/hash 为 PBKDF2 派生。
-- saves:    存档内容。id 外键对应 accounts，data 为加密存档串，rev 为版本号(防回档)。

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS saves (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
