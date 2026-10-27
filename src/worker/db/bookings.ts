/** bookings / booking_hosts / email_outbox へのアクセス */
import type { Answer, BookingDetail, BookingSummary } from '../../shared/api';
import type { LocationType } from '../../shared/schema';
import { manageUrl, parseJson } from '../lib/util';

export interface BookingRow {
  id: string;
  calendar_id: string;
  status: 'confirmed' | 'cancelled';
  start_at: string;
  end_at: string;
  block_start_at: string;
  block_end_at: string;
  guest_name: string;
  guest_email: string;
  guest_company: string;
  guest_comment: string;
  guest_timezone: string;
  answers: string;
  url_params: string;
  location_type: LocationType;
  location_text: string;
  meeting_url: string | null;
  manage_token: string;
  one_time_token: string | null;
  reschedule_count: number;
  cancelled_at: string | null;
  cancelled_by: 'guest' | 'host' | null;
  cancel_reason: string | null;
  reminder_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 連携カレンダーに登録した予定の控え（booking_hosts.external_event） */
export interface ExternalEvent {
  connectionId: string;
  calendarId: string;
  /** 本体の予定（担当者のうち代表の1人だけが持つ） */
  eventId: string | null;
  /** 前後の確保時間の予定 */
  bufferEventIds: string[];
}

export interface BookingHostRow {
  booking_id: string;
  member_id: string;
  member_name: string;
  member_email: string;
  start_at: string;
  active: number;
  external_event: string | null;
}

export async function getBooking(db: D1Database, id: string): Promise<BookingRow | null> {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first<BookingRow>();
}

export async function getBookingByToken(db: D1Database, token: string): Promise<BookingRow | null> {
  return db.prepare('SELECT * FROM bookings WHERE manage_token = ?').bind(token).first<BookingRow>();
}

/** 予定の担当メンバー。名前・メールは今のメンバー情報を優先し、削除済みなら予定を作ったときの控えを使う */
export async function listBookingHosts(db: D1Database, bookingIds: string[]): Promise<(BookingHostRow & { name: string; email: string })[]> {
  if (bookingIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT h.*, COALESCE(m.name, h.member_name) AS name, COALESCE(m.email, h.member_email) AS email
       FROM booking_hosts h LEFT JOIN members m ON m.id = h.member_id
       WHERE h.booking_id IN (${bookingIds.map(() => '?').join(',')}) ORDER BY h.rowid`,
    )
    .bind(...bookingIds)
    .all<BookingHostRow & { name: string; email: string }>();
  return results;
}

/**
 * 指定メンバーが埋まっている範囲（このアプリで確定した予定。確保時間込み）。
 * excludeBookingId はリスケのとき自分自身を除くため
 */
export async function listInternalBusy(
  db: D1Database,
  memberIds: string[],
  from: string,
  to: string,
  excludeBookingId: string | null,
): Promise<{ member_id: string; block_start_at: string; block_end_at: string }[]> {
  if (memberIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT h.member_id, b.block_start_at, b.block_end_at FROM booking_hosts h JOIN bookings b ON b.id = h.booking_id
       WHERE h.active = 1 AND h.member_id IN (${memberIds.map(() => '?').join(',')})
         AND b.block_end_at > ? AND b.block_start_at < ? AND b.id != ?`,
    )
    .bind(...memberIds, from, to, excludeBookingId ?? '')
    .all<{ member_id: string; block_start_at: string; block_end_at: string }>();
  return results;
}

/** このカレンダーで各メンバーが担当している確定予定の開始時刻（上限・均等割り当ての計算用） */
export async function listCalendarAssignments(db: D1Database, calendarId: string, excludeBookingId: string | null): Promise<{ member_id: string; start_at: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT h.member_id, b.start_at FROM booking_hosts h JOIN bookings b ON b.id = h.booking_id
       WHERE b.calendar_id = ? AND b.status = 'confirmed' AND h.active = 1 AND b.id != ?`,
    )
    .bind(calendarId, excludeBookingId ?? '')
    .all<{ member_id: string; start_at: string }>();
  return results;
}

export interface BookingFilter {
  scope: 'upcoming' | 'past' | 'cancelled' | 'all';
  calendarId?: string;
  q?: string;
}

export async function listBookings(db: D1Database, f: BookingFilter, limit = 500): Promise<(BookingRow & { calendar_name: string })[]> {
  const where = ['1 = 1'];
  const values: unknown[] = [];
  const now = new Date().toISOString();
  if (f.scope === 'upcoming') (where.push("b.status = 'confirmed' AND b.end_at > ?"), values.push(now));
  if (f.scope === 'past') (where.push("b.status = 'confirmed' AND b.end_at <= ?"), values.push(now));
  if (f.scope === 'cancelled') where.push("b.status = 'cancelled'");
  if (f.calendarId) (where.push('b.calendar_id = ?'), values.push(f.calendarId));
  if (f.q) {
    where.push('(b.guest_name LIKE ? OR b.guest_email LIKE ? OR b.guest_company LIKE ?)');
    const like = `%${f.q.replace(/[%_]/g, '')}%`;
    values.push(like, like, like);
  }
  const order = f.scope === 'upcoming' ? 'b.start_at ASC' : 'b.start_at DESC';
  const { results } = await db
    .prepare(`SELECT b.*, c.name AS calendar_name FROM bookings b JOIN booking_calendars c ON c.id = b.calendar_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
    .bind(...values, limit)
    .all<BookingRow & { calendar_name: string }>();
  return results;
}

export async function countUpcomingByCalendar(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT calendar_id, COUNT(*) AS n FROM bookings WHERE status = 'confirmed' AND end_at > ? GROUP BY calendar_id")
    .bind(new Date().toISOString())
    .all<{ calendar_id: string; n: number }>();
  return new Map(results.map((r) => [r.calendar_id, r.n]));
}

export function toBookingSummary(b: BookingRow, calendarName: string, hosts: { member_id: string; name: string }[]): BookingSummary {
  return {
    id: b.id,
    calendarId: b.calendar_id,
    calendarName,
    status: b.status,
    startAt: b.start_at,
    endAt: b.end_at,
    guestName: b.guest_name,
    guestEmail: b.guest_email,
    guestCompany: b.guest_company,
    // キャンセル済みの予定は担当者の active が 0 になっているが、誰の予定だったかは表示する
    hosts: hosts.map((h) => ({ memberId: h.member_id, name: h.name })),
    locationType: b.location_type,
    locationText: b.location_text,
    meetingUrl: b.meeting_url,
    createdAt: b.created_at,
    cancelledAt: b.cancelled_at,
    cancelledBy: b.cancelled_by,
  };
}

export function toBookingDetail(b: BookingRow, calendarName: string, hosts: { member_id: string; name: string }[], baseUrl: string): BookingDetail {
  return {
    ...toBookingSummary(b, calendarName, hosts),
    guestComment: b.guest_comment,
    guestTimezone: b.guest_timezone,
    answers: parseJson<Answer[]>(b.answers, []),
    urlParams: parseJson<Record<string, string>>(b.url_params, {}),
    manageUrl: manageUrl(baseUrl, b.manage_token),
    cancelReason: b.cancel_reason,
    rescheduleCount: b.reschedule_count,
  };
}

// ---- 送信ログ ----

export interface OutboxRow {
  id: string;
  kind: string;
  to_addr: string;
  subject: string;
  body: string;
  booking_id: string | null;
  status: 'logged' | 'sent' | 'failed';
  error: string | null;
  created_at: string;
}

/** 送信ログ（新しい順） */
export async function listOutbox(db: D1Database, limit = 200): Promise<OutboxRow[]> {
  const { results } = await db.prepare('SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT ?').bind(limit).all<OutboxRow>();
  return results;
}
