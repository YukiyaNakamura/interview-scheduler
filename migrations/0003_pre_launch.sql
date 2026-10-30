-- 本番に出す前の修正（docs/01「予約の確定」「メール」）

-- 同じ面接官の、時間が重なる確定予定を DB で止める。
-- アプリでも空き枠を計算し直してから確定するが、同時に確定されると（例: 60分の面接で 10:00 と 10:30）両方通ってしまうため。
-- 前後の確保時間を含めた範囲（block_*）どうしで比べる（src/shared/slots.ts の空き計算と同じ）。
-- bookings を先に INSERT / UPDATE してから booking_hosts を入れる前提（src/worker/services/booking.ts）
CREATE TRIGGER booking_hosts_no_overlap BEFORE INSERT ON booking_hosts
WHEN NEW.active = 1
BEGIN
  SELECT RAISE(ABORT, 'overlap')
  WHERE EXISTS (
    SELECT 1 FROM bookings n, booking_hosts h JOIN bookings o ON o.id = h.booking_id
    WHERE n.id = NEW.booking_id AND h.member_id = NEW.member_id AND h.active = 1 AND h.booking_id != NEW.booking_id
      AND o.status = 'confirmed' AND o.block_start_at < n.block_end_at AND n.block_start_at < o.block_end_at
  );
END;

-- メールの送信待ち。送る前に 'pending' で入れ、送れたら 'sent'、何度か送り直してもだめなら 'failed'（src/worker/integrations/notify.ts）。
-- 本文は送り直しのためだけに持ち、送り終えたら消す（パスワード再設定のリンクなどを残さない）。EMAIL_PROVIDER=log のときは 'logged' で本文を残す
ALTER TABLE email_outbox ADD COLUMN reply_to_enc TEXT;
ALTER TABLE email_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN next_attempt_at TEXT;
CREATE INDEX email_outbox_pending ON email_outbox(status, next_attempt_at);

-- カレンダーの削除はアーカイブにする（予定の記録を残す）。アーカイブしたカレンダーは一覧と応募画面に出ない
ALTER TABLE booking_calendars ADD COLUMN archived_at TEXT;
