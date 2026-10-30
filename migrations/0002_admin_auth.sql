-- 管理画面のログイン（docs/01「ログイン」）。応募者はログインしない
-- パスワード＋2段階認証（TOTP）が必須。最初の管理者は /login の初期設定（ADMIN_SETUP_TOKEN が要る）で作る。
-- 2人目からは「アカウント」画面での追加か、新規登録（メールの確認 → 管理者の承認）

-- 管理者（管理画面にログインできる人）。面接官（members）とは別
CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  email_enc TEXT NOT NULL,
  email_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'pending_email'（新規登録のメール確認待ち）| 'pending_approval'（管理者の承認待ち）| 'active'
  password_hash TEXT NOT NULL, -- 'pbkdf2-sha256$<回数>$<salt base64>$<hash base64>'（src/worker/lib/password.ts）
  must_change_password INTEGER NOT NULL DEFAULT 0, -- 1 = 発行された仮パスワードのまま。変えるまで管理画面を使えない
  totp_secret_enc TEXT, -- 2段階認証の秘密鍵（AES-GCM で暗号化）。NULL = 未登録（次のログインで登録させる）
  totp_last_step INTEGER, -- 最後に通したコードの時刻ステップ。同じコードの使い回しを防ぐ
  password_changed_at TEXT NOT NULL,
  last_login_at TEXT,
  last_login_ip TEXT,
  created_at TEXT NOT NULL
);

-- ログイン中のセッション。Cookie の値そのものは持たず SHA-256 だけを持つ（DB が漏れてもセッションを乗っ取れない）
CREATE TABLE admin_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL, -- 'password'（パスワードだけ通った。2段階認証待ち）| 'full'
  pending_totp_enc TEXT, -- 2段階認証の登録中に見せている秘密鍵（暗号化）
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX admin_sessions_user ON admin_sessions(user_id);
CREATE INDEX admin_sessions_expires ON admin_sessions(expires_at);

-- メールで送るリンクのトークン（新規登録のメール確認・パスワードの再設定）。値そのものは持たず SHA-256 だけを持つ。1回使うと消す
CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL, -- 'verify_email' | 'reset_password'
  user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id, purpose);

-- 試行回数（総当たり・大量送信の対策）。key は src/worker/lib/limits.ts の LIMITS（メールアドレスは目印のハッシュで持つ）。
-- 確かめる前に1回分を数え、成功したら戻す（src/worker/db/auth.ts の reserveAttempt）
CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL, -- window_started_at からの試行回数（成功した分は戻す）
  window_started_at TEXT NOT NULL,
  locked_until TEXT
);

-- ログインまわりの記録（管理画面の「アカウント」に出す）。180日で消す
CREATE TABLE auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, -- src/shared/api.ts の AuthEventKind
  user_id TEXT, -- 本人（失敗のときは分かれば）
  actor_id TEXT, -- 操作した管理者（アカウントの追加・リセットなど）
  email_enc TEXT, -- 暗号化したメールアドレス（存在しないメールアドレスでのログイン失敗も残すため）
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX auth_events_created ON auth_events(created_at);
