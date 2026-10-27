/** booking_calendars / calendar_members / candidate_slots / one_time_links へのアクセス */
import type { CalendarDetail } from '../../shared/api';
import { type CalendarSettings, defaultSettings } from '../../shared/schema';
import { calendarUrl, newId, newToken, nowIso, parseJson } from '../lib/util';

export interface CalendarRow {
  id: string;
  kind: 'standard' | 'candidates';
  slug: string;
  name: string;
  internal_name: string;
  status: 'open' | 'closed';
  settings: string;
  created_at: string;
  updated_at: string;
}

export interface CalendarMemberRow {
  calendar_id: string;
  member_id: string;
  grp: 1 | 2;
  priority: number;
  booking_limit: number | null;
}

/** settings 列を読む。後から増えた項目は初期値で埋める（古い行でも壊れないように） */
export function parseSettings(text: string): CalendarSettings {
  return { ...defaultSettings(), ...parseJson<Partial<CalendarSettings>>(text, {}) };
}

export async function getCalendar(db: D1Database, id: string): Promise<CalendarRow | null> {
  return db.prepare('SELECT * FROM booking_calendars WHERE id = ?').bind(id).first<CalendarRow>();
}

export async function getCalendarBySlug(db: D1Database, slug: string): Promise<CalendarRow | null> {
  return db.prepare('SELECT * FROM booking_calendars WHERE slug = ?').bind(slug).first<CalendarRow>();
}

export async function listCalendars(db: D1Database): Promise<CalendarRow[]> {
  const { results } = await db.prepare('SELECT * FROM booking_calendars ORDER BY created_at DESC').all<CalendarRow>();
  return results;
}

export async function listMembers(db: D1Database, calendarId: string): Promise<CalendarMemberRow[]> {
  const { results } = await db.prepare('SELECT * FROM calendar_members WHERE calendar_id = ? ORDER BY priority, rowid').bind(calendarId).all<CalendarMemberRow>();
  return results;
}

export async function listMembersForCalendars(db: D1Database, calendarIds: string[]): Promise<CalendarMemberRow[]> {
  if (calendarIds.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT * FROM calendar_members WHERE calendar_id IN (${calendarIds.map(() => '?').join(',')}) ORDER BY priority, rowid`)
    .bind(...calendarIds)
    .all<CalendarMemberRow>();
  return results;
}

export async function listCandidateSlots(db: D1Database, calendarId: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT start_at FROM candidate_slots WHERE calendar_id = ? ORDER BY start_at').bind(calendarId).all<{ start_at: string }>();
  return results.map((r) => r.start_at);
}

export async function isSlugTaken(db: D1Database, slug: string, exceptId?: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM booking_calendars WHERE slug = ?').bind(slug).first<{ id: string }>();
  return row !== null && row.id !== exceptId;
}

/** 推測しにくい初期スラッグ（英小文字+数字 10 文字） */
export function randomSlug(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => chars[b % chars.length]).join('');
}

export interface CalendarWrite {
  name: string;
  internalName: string;
  slug: string;
  status: 'open' | 'closed';
  settings: CalendarSettings;
  members: { memberId: string; group: 1 | 2; priority: number; bookingLimit: number | null }[];
}

function memberStatements(db: D1Database, calendarId: string, members: CalendarWrite['members']): D1PreparedStatement[] {
  return members.map((m) =>
    db
      .prepare('INSERT INTO calendar_members (calendar_id, member_id, grp, priority, booking_limit) VALUES (?, ?, ?, ?, ?)')
      .bind(calendarId, m.memberId, m.group, m.priority, m.bookingLimit),
  );
}

export async function insertCalendar(
  db: D1Database,
  kind: CalendarRow['kind'],
  data: CalendarWrite,
  candidateStarts: string[] = [],
): Promise<string> {
  const id = newId();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        'INSERT INTO booking_calendars (id, kind, slug, name, internal_name, status, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, kind, data.slug, data.name, data.internalName, data.status, JSON.stringify(data.settings), now, now),
    ...memberStatements(db, id, data.members),
    ...candidateStarts.map((s) => db.prepare('INSERT INTO candidate_slots (calendar_id, start_at) VALUES (?, ?)').bind(id, s)),
  ]);
  return id;
}

export async function updateCalendar(db: D1Database, id: string, data: CalendarWrite): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE booking_calendars SET slug = ?, name = ?, internal_name = ?, status = ?, settings = ?, updated_at = ? WHERE id = ?')
      .bind(data.slug, data.name, data.internalName, data.status, JSON.stringify(data.settings), nowIso(), id),
    db.prepare('DELETE FROM calendar_members WHERE calendar_id = ?').bind(id),
    ...memberStatements(db, id, data.members),
  ]);
}

export async function deleteCalendar(db: D1Database, id: string): Promise<void> {
  // 予定（bookings）も ON DELETE CASCADE で消える。D1 は外部キーを既定で有効にしている
  await db.prepare('DELETE FROM booking_calendars WHERE id = ?').bind(id).run();
}

export async function toCalendarDetail(db: D1Database, row: CalendarRow, baseUrl: string): Promise<CalendarDetail> {
  const [members, candidateSlots] = await Promise.all([listMembers(db, row.id), row.kind === 'candidates' ? listCandidateSlots(db, row.id) : Promise.resolve([])]);
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    internalName: row.internal_name,
    status: row.status,
    url: calendarUrl(baseUrl, row.slug),
    settings: parseSettings(row.settings),
    members: members.map((m) => ({ memberId: m.member_id, group: m.grp, priority: m.priority, bookingLimit: m.booking_limit })),
    candidateSlots,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---- ワンタイム URL ----

export interface OneTimeLinkRow {
  token: string;
  calendar_id: string;
  created_at: string;
  used_at: string | null;
}

export async function createOneTimeLink(db: D1Database, calendarId: string): Promise<OneTimeLinkRow> {
  const row: OneTimeLinkRow = { token: newToken(16), calendar_id: calendarId, created_at: nowIso(), used_at: null };
  await db.prepare('INSERT INTO one_time_links (token, calendar_id, created_at) VALUES (?, ?, ?)').bind(row.token, calendarId, row.created_at).run();
  return row;
}

/** 未使用のワンタイム URL */
export async function listOneTimeLinks(db: D1Database, calendarId: string): Promise<OneTimeLinkRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM one_time_links WHERE calendar_id = ? AND used_at IS NULL ORDER BY created_at DESC')
    .bind(calendarId)
    .all<OneTimeLinkRow>();
  return results;
}

export async function getOneTimeLink(db: D1Database, token: string): Promise<OneTimeLinkRow | null> {
  return db.prepare('SELECT * FROM one_time_links WHERE token = ?').bind(token).first<OneTimeLinkRow>();
}

export async function deleteOneTimeLink(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM one_time_links WHERE token = ?').bind(token).run();
}
