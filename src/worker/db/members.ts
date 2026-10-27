/** members（面接官）/ oauth_states / calendar_connections へのアクセス */
import type { ConnectionInfo, MemberInfo } from '../../shared/api';
import { newId, newToken, nowIso, parseJson } from '../lib/util';

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

export interface ConnectionRow {
  id: string;
  member_id: string;
  provider: 'google';
  account_email: string;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  access_token_expires_at: string | null;
  check_calendar_ids: string;
  write_calendar_id: string;
  status: 'active' | 'error';
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function toConnectionInfo(c: ConnectionRow): ConnectionInfo {
  return {
    id: c.id,
    provider: c.provider,
    accountEmail: c.account_email,
    checkCalendarIds: parseJson<string[]>(c.check_calendar_ids, ['primary']),
    writeCalendarId: c.write_calendar_id,
    status: c.status,
    lastError: c.last_error,
  };
}

export function toMemberInfo(m: MemberRow, conns: ConnectionRow[]): MemberInfo {
  return { id: m.id, name: m.name, email: m.email, connections: conns.filter((c) => c.member_id === m.id).map(toConnectionInfo) };
}

export async function listMembers(db: D1Database): Promise<MemberRow[]> {
  const { results } = await db.prepare('SELECT * FROM members ORDER BY created_at').all<MemberRow>();
  return results;
}

export async function getMember(db: D1Database, id: string): Promise<MemberRow | null> {
  return db.prepare('SELECT * FROM members WHERE id = ?').bind(id).first<MemberRow>();
}

export async function getMembersByIds(db: D1Database, ids: string[]): Promise<MemberRow[]> {
  if (ids.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT * FROM members WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids)
    .all<MemberRow>();
  return results;
}

export async function isEmailTaken(db: D1Database, email: string, exceptId?: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM members WHERE email = ?').bind(email).first<{ id: string }>();
  return row !== null && row.id !== exceptId;
}

export async function insertMember(db: D1Database, name: string, email: string): Promise<string> {
  const id = newId();
  await db.prepare('INSERT INTO members (id, name, email, created_at) VALUES (?, ?, ?, ?)').bind(id, name, email, nowIso()).run();
  return id;
}

export async function updateMember(db: D1Database, id: string, name: string, email: string): Promise<void> {
  await db.prepare('UPDATE members SET name = ?, email = ? WHERE id = ?').bind(name, email, id).run();
}

/** メンバーを消す。参加メンバー・連携は外部キーで一緒に消える。担当した予定（booking_hosts）は名前の控えつきで残る */
export async function deleteMember(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM members WHERE id = ?').bind(id).run();
}

// ---- OAuth state ----

export async function createOAuthState(db: D1Database, memberId: string, redirectTo: string): Promise<string> {
  const state = newToken();
  await db.prepare('INSERT INTO oauth_states (state, member_id, redirect_to, created_at) VALUES (?, ?, ?, ?)').bind(state, memberId, redirectTo, nowIso()).run();
  return state;
}

/** state を1回だけ使う（取り出したら消す）。10分を過ぎていたら null */
export async function consumeOAuthState(db: D1Database, state: string): Promise<{ memberId: string; redirectTo: string } | null> {
  const row = await db
    .prepare('DELETE FROM oauth_states WHERE state = ? RETURNING member_id, redirect_to, created_at')
    .bind(state)
    .first<{ member_id: string; redirect_to: string; created_at: string }>();
  if (!row || Date.now() - new Date(row.created_at).getTime() > 10 * 60_000) return null;
  return { memberId: row.member_id, redirectTo: row.redirect_to };
}

// ---- 連携カレンダー ----

export async function listAllConnections(db: D1Database): Promise<ConnectionRow[]> {
  const { results } = await db.prepare('SELECT * FROM calendar_connections ORDER BY created_at').all<ConnectionRow>();
  return results;
}

export async function listConnectionsForMembers(db: D1Database, memberIds: string[]): Promise<ConnectionRow[]> {
  if (memberIds.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT * FROM calendar_connections WHERE member_id IN (${memberIds.map(() => '?').join(',')}) ORDER BY created_at`)
    .bind(...memberIds)
    .all<ConnectionRow>();
  return results;
}

export async function getConnection(db: D1Database, id: string): Promise<ConnectionRow | null> {
  return db.prepare('SELECT * FROM calendar_connections WHERE id = ?').bind(id).first<ConnectionRow>();
}

export async function upsertGoogleConnection(
  db: D1Database,
  memberId: string,
  accountEmail: string,
  tokens: { accessTokenEnc: string; expiresAt: string; refreshTokenEnc: string | null },
): Promise<void> {
  const now = nowIso();
  // refresh_token は再同意のときしか返らないことがあるので、来なかったら前の値を残す
  await db
    .prepare(
      `INSERT INTO calendar_connections (id, member_id, provider, account_email, refresh_token_enc, access_token_enc, access_token_expires_at, status, created_at, updated_at)
       VALUES (?, ?, 'google', ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT (member_id, provider, account_email) DO UPDATE SET
         refresh_token_enc = COALESCE(excluded.refresh_token_enc, calendar_connections.refresh_token_enc),
         access_token_enc = excluded.access_token_enc,
         access_token_expires_at = excluded.access_token_expires_at,
         status = 'active', last_error = NULL, updated_at = excluded.updated_at`,
    )
    .bind(newId(), memberId, accountEmail.toLowerCase(), tokens.refreshTokenEnc, tokens.accessTokenEnc, tokens.expiresAt, now, now)
    .run();
}

export async function updateConnectionTokens(db: D1Database, id: string, accessTokenEnc: string, expiresAt: string): Promise<void> {
  await db
    .prepare("UPDATE calendar_connections SET access_token_enc = ?, access_token_expires_at = ?, status = 'active', last_error = NULL, updated_at = ? WHERE id = ?")
    .bind(accessTokenEnc, expiresAt, nowIso(), id)
    .run();
}

export async function markConnectionError(db: D1Database, id: string, message: string): Promise<void> {
  await db.prepare("UPDATE calendar_connections SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?").bind(message.slice(0, 500), nowIso(), id).run();
}

export async function updateConnectionCalendars(db: D1Database, id: string, checkCalendarIds: string[], writeCalendarId: string): Promise<void> {
  await db
    .prepare('UPDATE calendar_connections SET check_calendar_ids = ?, write_calendar_id = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(checkCalendarIds), writeCalendarId, nowIso(), id)
    .run();
}

export async function deleteConnection(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM calendar_connections WHERE id = ?').bind(id).run();
}
