-- 初期スキーマ。日時はすべて UTC の ISO 文字列（Date#toISOString() の形）で持つ。文字列の大小比較がそのまま時刻の前後になる
-- このアプリにログインはない（docs/01「ログイン」）。面接官は members として管理画面で登録する

-- メンバー（面接官）
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Google 連携の OAuth state（CSRF 対策）。10分で無効
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  redirect_to TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 連携カレンダー（Google）。トークンは AES-GCM で暗号化して持つ
CREATE TABLE calendar_connections (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- 'google'
  account_email TEXT NOT NULL,
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  access_token_expires_at TEXT,
  check_calendar_ids TEXT NOT NULL DEFAULT '["primary"]', -- 空き確認に使うカレンダー（JSON 配列）
  write_calendar_id TEXT NOT NULL DEFAULT 'primary', -- 予定を登録するカレンダー
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'error'
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (member_id, provider, account_email)
);

-- 日程調整カレンダー。設定項目は settings（JSON: src/shared/schema.ts の CalendarSettings）にまとめて持つ
CREATE TABLE booking_calendars (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'standard', -- 'standard'（通常）| 'candidates'（候補を選んで日程調整）
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  internal_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'closed'
  settings TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 参加メンバー。grp は 2 グループ方式のグループ（1 or 2）、priority は小さいほど優先、booking_limit はメンバー毎の上限
CREATE TABLE calendar_members (
  calendar_id TEXT NOT NULL REFERENCES booking_calendars(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  grp INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  booking_limit INTEGER,
  PRIMARY KEY (calendar_id, member_id)
);

-- 候補を選んで日程調整の候補枠
CREATE TABLE candidate_slots (
  calendar_id TEXT NOT NULL REFERENCES booking_calendars(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL,
  PRIMARY KEY (calendar_id, start_at)
);

-- ワンタイム URL。used_at が入ったら無効
CREATE TABLE one_time_links (
  token TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES booking_calendars(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX one_time_links_calendar ON one_time_links(calendar_id);

-- 確定した予定
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES booking_calendars(id) ON DELETE CASCADE,
  status TEXT NOT NULL, -- 'confirmed' | 'cancelled'
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  -- 前後の確保時間を含めた「面接官が埋まる」範囲。空き計算ではこちらを使う
  block_start_at TEXT NOT NULL,
  block_end_at TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  guest_company TEXT NOT NULL DEFAULT '',
  guest_comment TEXT NOT NULL DEFAULT '',
  guest_timezone TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '[]', -- JSON: [{ questionId, label, value }]
  url_params TEXT NOT NULL DEFAULT '{}', -- JSON: 流入元などのクエリ
  location_type TEXT NOT NULL,
  location_text TEXT NOT NULL DEFAULT '',
  meeting_url TEXT,
  manage_token TEXT NOT NULL UNIQUE, -- 応募者の予定確認ページ /r/<token>
  one_time_token TEXT,
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  cancelled_at TEXT,
  cancelled_by TEXT, -- 'guest' | 'host'
  cancel_reason TEXT,
  reminder_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX bookings_start ON bookings(start_at);
CREATE INDEX bookings_calendar_start ON bookings(calendar_id, start_at);
CREATE INDEX bookings_reminder ON bookings(status, reminder_sent_at, start_at);

-- 予定の担当メンバー。active=1 の間は (member_id, start_at) が重複できない（同じ人の同時刻のダブルブッキングを DB で防ぐ）。
-- メンバーを削除しても予定の記録は残すため、member_id に外部キーは付けず、名前を控えておく
CREATE TABLE booking_hosts (
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  member_email TEXT NOT NULL,
  start_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  -- 連携カレンダーに登録した予定（JSON: { connectionId, calendarId, eventId, bufferEventIds[] }）
  external_event TEXT,
  PRIMARY KEY (booking_id, member_id)
);
CREATE UNIQUE INDEX booking_hosts_no_double ON booking_hosts(member_id, start_at) WHERE active = 1;
CREATE INDEX booking_hosts_member ON booking_hosts(member_id, active);

-- 送信したメールの記録。EMAIL_PROVIDER=log のときは送らずにここへ残すだけ
CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- 'guest_confirmed' | 'host_confirmed' | 'cancelled' | 'rescheduled' | 'reminder' | 'no_slot'
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  booking_id TEXT,
  status TEXT NOT NULL, -- 'logged' | 'sent' | 'failed'
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX email_outbox_created ON email_outbox(created_at);
