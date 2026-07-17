-- 修仙游戏存档 D1 表结构
-- accounts: 账户鉴权。id 为归一化(小写)后的账户名主键，salt/hash 为 PBKDF2 派生。
-- saves:    存档内容。id 外键对应 accounts，data 为加密存档串，rev 为版本号(防回档)。

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0   -- 0 普通用户,1 管理员(手动 SQL 置 1);仅管理员显示修改器入口
);

CREATE TABLE IF NOT EXISTS saves (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
