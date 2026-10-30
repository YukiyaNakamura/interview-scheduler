/**
 * リマインドメール（docs/00「7. メール」）。10分ごとに動く。
 * - 送信時刻: 予定の前日 H:00（H = 1〜23）。H = 24 は当日 0:00。ゲストのタイムゾーン基準
 * - 送信時刻を過ぎてから確定した予定も、予定当日 0:00 までに確定していれば次の実行で送る。当日 0:01 以降に確定したものには送らない
 */
import { addDays, zonedParts, zonedToUtc } from '../../shared/time';
import { cleanupAuth } from '../db/auth';
import { type BookingDbRow, deleteOldOutbox, listBookingHosts, toBookingRow } from '../db/bookings';
import { parseSettings } from '../db/calendars';
import type { Bindings } from '../env';
import { open } from '../lib/pii';
import { sendMail } from '../integrations/notify';
import { appUrl, manageUrl } from '../lib/util';
import { reminderMail } from '../services/messages';

/** その予定のリマインドの送信時刻と、これより後に確定した予定には送らないという締め切り */
export function reminderTimes(startAt: string, guestTz: string, hour: number): { sendAt: Date; cutoff: Date } {
  const day = zonedParts(new Date(startAt), guestTz).date;
  const sendAt = hour === 24 ? zonedToUtc(day, '00:00', guestTz) : zonedToUtc(addDays(day, -1), `${String(hour).padStart(2, '0')}:00`, guestTz);
  return { sendAt, cutoff: zonedToUtc(day, '00:01', guestTz) };
}

export async function runReminders(env: Bindings, now = new Date()): Promise<number> {
  // 48時間以内に始まる、まだリマインドしていない確定予定
  const { results } = await env.DB.prepare(
    `SELECT b.*, c.name AS c_name, c.settings_enc AS c_settings_enc, c.slug AS c_slug, c.kind AS c_kind FROM bookings b JOIN booking_calendars c ON c.id = b.calendar_id
     WHERE b.status = 'confirmed' AND b.reminder_sent_at IS NULL AND b.start_at > ? AND b.start_at < ?`,
  )
    .bind(now.toISOString(), new Date(now.getTime() + 48 * 3_600_000).toISOString())
    .all<BookingDbRow & { c_name: string; c_settings_enc: string; c_kind: 'standard' | 'candidates' }>();

  let sent = 0;
  const base = appUrl(env);
  for (const row of results) {
    const b = await toBookingRow(row);
    const settings = parseSettings(await open(b.c_settings_enc));
    if (!settings.reminder.enabled) continue;
    const { sendAt, cutoff } = reminderTimes(b.start_at, b.guest_timezone, settings.reminder.hour);
    if (now < sendAt) continue;
    // 送らないと決まったものも「済み」にして、毎回見直さないようにする
    const claimed = await env.DB.prepare('UPDATE bookings SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL').bind(now.toISOString(), b.id).run();
    if (claimed.meta.changes === 0 || new Date(b.created_at) >= cutoff) continue;
    const hosts = await listBookingHosts(env.DB, [b.id]);
    const mail = reminderMail({
      appName: env.APP_NAME,
      calendarName: b.c_name,
      calendarKind: b.c_kind,
      settings,
      booking: b,
      hostNames: hosts.filter((h) => h.active === 1).map((h) => h.name),
      manageUrl: manageUrl(base, b.manage_token),
      icsUrl: `${base}/api/public/bookings/${b.manage_token}/ics`,
    });
    await sendMail(env, { kind: 'reminder', to: b.guest_email, bookingId: b.id, ...mail });
    sent++;
  }
  return sent;
}

/** 送信ログを残す日数（宛先・件名も個人情報なので長く持たない） */
const OUTBOX_RETENTION_DAYS = 30;

/** 期限切れの OAuth state・ログインまわりの記録と、古い送信ログを消す */
export async function runCleanup(env: Bindings): Promise<void> {
  await env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(new Date(Date.now() - 3_600_000).toISOString()).run();
  await cleanupAuth(env.DB);
  await deleteOldOutbox(env.DB, new Date(Date.now() - OUTBOX_RETENTION_DAYS * 86_400_000).toISOString());
}


