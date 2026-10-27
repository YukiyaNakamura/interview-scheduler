/**
 * Google（OAuth・カレンダー）。SDK は使わず fetch で REST API を呼ぶ。
 * - メンバーごとの「カレンダー連携」（ログインではない）。スコープは openid email profile + calendar.readonly（カレンダー一覧・空き確認）+ calendar.events（予定の登録・削除）
 * - アクセストークンは1時間で切れるので、期限の5分前を過ぎていたら refresh_token で取り直す
 */
import type { GoogleCalendarItem } from '../../shared/api';
import type { Interval } from '../../shared/slots';
import { type ConnectionRow, markConnectionError, updateConnectionTokens } from '../db/members';
import type { Bindings } from '../env';
import { decrypt, encrypt } from '../lib/crypto';
import { parseJson } from '../lib/util';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

export const googleEnabled = (env: Bindings) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export function googleAuthUrl(env: Bindings, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // refresh_token を確実にもらうため毎回同意画面を出す
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) throw new Error(`Google トークン取得に失敗: ${json.error_description ?? json.error ?? res.status}`);
  return json;
}

export async function exchangeCode(env: Bindings, code: string, redirectUri: string): Promise<TokenResponse> {
  return tokenRequest({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirectUri, grant_type: 'authorization_code' });
}

export async function fetchGoogleProfile(accessToken: string): Promise<{ email: string; name: string; picture: string | null }> {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google のプロフィール取得に失敗: ${res.status}`);
  const j = (await res.json()) as { email: string; name?: string; picture?: string };
  return { email: j.email, name: j.name ?? j.email, picture: j.picture ?? null };
}

/** 保存用に暗号化したトークンと期限 */
export async function encryptTokens(env: Bindings, t: TokenResponse) {
  return {
    accessTokenEnc: await encrypt(t.access_token, env.TOKEN_ENC_KEY),
    expiresAt: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    refreshTokenEnc: t.refresh_token ? await encrypt(t.refresh_token, env.TOKEN_ENC_KEY) : null,
  };
}

/** 使えるアクセストークン。取れなければ連携をエラーにして例外 */
export async function accessTokenFor(env: Bindings, conn: ConnectionRow): Promise<string> {
  const valid = conn.access_token_enc && conn.access_token_expires_at && new Date(conn.access_token_expires_at).getTime() - Date.now() > 5 * 60_000;
  if (valid) return decrypt(conn.access_token_enc!, env.TOKEN_ENC_KEY);
  if (!conn.refresh_token_enc || !googleEnabled(env)) {
    await markConnectionError(env.DB, conn.id, '再連携が必要です（refresh token がありません）');
    throw new Error('Google の再連携が必要です');
  }
  try {
    const refreshToken = await decrypt(conn.refresh_token_enc, env.TOKEN_ENC_KEY);
    const t = await tokenRequest({ refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, grant_type: 'refresh_token' });
    const enc = await encryptTokens(env, t);
    await updateConnectionTokens(env.DB, conn.id, enc.accessTokenEnc, enc.expiresAt);
    conn.access_token_enc = enc.accessTokenEnc;
    conn.access_token_expires_at = enc.expiresAt;
    return t.access_token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markConnectionError(env.DB, conn.id, message);
    throw err;
  }
}

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Calendar API ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function listGoogleCalendars(env: Bindings, conn: ConnectionRow): Promise<GoogleCalendarItem[]> {
  const token = await accessTokenFor(env, conn);
  const j = await api<{ items: { id: string; summary: string; primary?: boolean; accessRole: string }[] }>(token, '/users/me/calendarList?maxResults=250');
  return j.items.map((i) => ({ id: i.id, summary: i.summary, primary: Boolean(i.primary), accessRole: i.accessRole }));
}

/** 空き確認に使うカレンダーの「予定あり」の時間 */
export async function googleBusy(env: Bindings, conn: ConnectionRow, from: Date, to: Date): Promise<Interval[]> {
  const token = await accessTokenFor(env, conn);
  const ids = parseJson<string[]>(conn.check_calendar_ids, ['primary']);
  const j = await api<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(token, '/freeBusy', {
    method: 'POST',
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: ids.map((id) => ({ id })) }),
  });
  const busy: Interval[] = [];
  for (const cal of Object.values(j.calendars)) {
    for (const b of cal.busy ?? []) busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
  }
  return busy;
}

export interface NewEvent {
  summary: string;
  description: string;
  start: string;
  end: string;
  attendees: string[];
  location?: string;
  private: boolean;
  /** Google Meet の URL を発行する */
  withMeet: boolean;
}

/** 予定を登録する。Google 側から招待メールは送らない（このアプリがメールを送るため） */
export async function insertGoogleEvent(env: Bindings, conn: ConnectionRow, ev: NewEvent): Promise<{ id: string; meetUrl: string | null }> {
  const token = await accessTokenFor(env, conn);
  const body: Record<string, unknown> = {
    summary: ev.summary,
    description: ev.description,
    start: { dateTime: ev.start },
    end: { dateTime: ev.end },
    attendees: ev.attendees.map((email) => ({ email })),
    visibility: ev.private ? 'private' : 'default',
    reminders: { useDefault: true },
  };
  if (ev.location) body.location = ev.location;
  if (ev.withMeet) {
    body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  const calendarId = encodeURIComponent(conn.write_calendar_id || 'primary');
  const j = await api<{ id: string; hangoutLink?: string }>(token, `/calendars/${calendarId}/events?conferenceDataVersion=1&sendUpdates=none`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { id: j.id, meetUrl: j.hangoutLink ?? null };
}

export async function deleteGoogleEvent(env: Bindings, conn: ConnectionRow, calendarId: string, eventId: string): Promise<void> {
  const token = await accessTokenFor(env, conn);
  try {
    await api<void>(token, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'DELETE' });
  } catch (err) {
    // すでに消えている（410/404）なら成功扱い
    if (err instanceof Error && /API (404|410)/.test(err.message)) return;
    throw err;
  }
}
