/**
 * 管理画面の API（/api/admin/*。docs/01「API」）。index.ts の requireAdmin でログイン済みの管理者だけが通る。
 * 管理者アカウントの管理は routes/accounts.ts
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Answer, AvailabilityResponse, BookingListResponse, CalendarSummary, MemberInfo, OneTimeLinkInfo, OutboxItem } from '../../shared/api';
import { calendarUpdateSchema, defaultSettings, LOCATION_LABELS, LOCATION_TYPES } from '../../shared/schema';
import { computeSlots } from '../../shared/slots';
import { isValidTimeZone, zonedParts } from '../../shared/time';
import { type BookingFilter, countUpcomingByCalendar, getBooking, listBookingHosts, listBookings, listOutbox, toBookingDetail, toBookingSummary } from '../db/bookings';
import {
  type CalendarMemberRow,
  type CalendarRow,
  createOneTimeLink,
  deleteCalendar,
  deleteOneTimeLink,
  getCalendar,
  getOneTimeLink,
  insertCalendar,
  isSlugTaken,
  listCalendars,
  listCandidateSlots,
  listMembers as listCalendarMembers,
  listMembersForCalendars,
  listOneTimeLinks,
  parseSettings,
  randomSlug,
  toCalendarDetail,
  updateCalendar,
} from '../db/calendars';
import {
  deleteConnection,
  deleteMember,
  getConnection,
  getMember,
  getMembersByIds,
  insertMember,
  isEmailTaken,
  listAllConnections,
  listConnectionsForMembers,
  listMembers,
  toConnectionInfo,
  toMemberInfo,
  updateConnectionCalendars,
  updateMember,
} from '../db/members';
import type { AppEnv } from '../env';
import { listGoogleCalendars } from '../integrations/google';
import { appUrl, calendarUrl, HttpError, parseJson } from '../lib/util';
import { cancelBooking, findSlots } from '../services/booking';

export const admin = new Hono<AppEnv>();

// ---- メンバー（面接官） ----

const memberInputSchema = z.object({
  name: z.string().trim().min(1, '名前を入力してください').max(100),
  email: z.email('メールアドレスが正しくありません').transform((v) => v.toLowerCase()),
});

admin.get('/members', async (c) => {
  const [members, conns] = await Promise.all([listMembers(c.env.DB), listAllConnections(c.env.DB)]);
  return c.json<MemberInfo[]>(members.map((m) => toMemberInfo(m, conns)));
});

admin.post('/members', async (c) => {
  const input = memberInputSchema.parse(await c.req.json());
  if (await isEmailTaken(c.env.DB, input.email)) throw new HttpError(409, 'このメールアドレスのメンバーはすでに登録されています');
  const id = await insertMember(c.env.DB, input.name, input.email);
  return c.json<MemberInfo>(toMemberInfo((await getMember(c.env.DB, id))!, []), 201);
});

admin.patch('/members/:id', async (c) => {
  const member = await getMember(c.env.DB, c.req.param('id'));
  if (!member) throw new HttpError(404, 'メンバーが見つかりません');
  const input = memberInputSchema.parse(await c.req.json());
  if (await isEmailTaken(c.env.DB, input.email, member.id)) throw new HttpError(409, 'このメールアドレスのメンバーはすでに登録されています');
  await updateMember(c.env.DB, member.id, input.name, input.email);
  return c.json<MemberInfo>(toMemberInfo((await getMember(c.env.DB, member.id))!, await listConnectionsForMembers(c.env.DB, [member.id])));
});

admin.delete('/members/:id', async (c) => {
  const member = await getMember(c.env.DB, c.req.param('id'));
  if (!member) throw new HttpError(404, 'メンバーが見つかりません');
  // 参加メンバーがこの人だけのカレンダーがあると、そのカレンダーが使えなくなるので先に知らせる
  const { results } = await c.env.DB.prepare(
    `SELECT c.name FROM booking_calendars c JOIN calendar_members m ON m.calendar_id = c.id
     WHERE m.member_id = ? AND (SELECT COUNT(*) FROM calendar_members x WHERE x.calendar_id = c.id) = 1`,
  )
    .bind(member.id)
    .all<{ name: string }>();
  if (results.length > 0) {
    throw new HttpError(400, `次のカレンダーの参加メンバーがこの人だけなので削除できません。先に別のメンバーを追加してください: ${results.map((r) => r.name).join('、')}`);
  }
  await deleteMember(c.env.DB, member.id);
  return c.json({ ok: true });
});

// ---- Google カレンダー連携 ----

async function connectionOr404(db: D1Database, id: string) {
  const conn = await getConnection(db, id);
  if (!conn) throw new HttpError(404, '連携が見つかりません');
  return conn;
}

admin.get('/connections/:id/calendars', async (c) => {
  const conn = await connectionOr404(c.env.DB, c.req.param('id'));
  return c.json(await listGoogleCalendars(c.env, conn));
});

admin.patch('/connections/:id', async (c) => {
  const conn = await connectionOr404(c.env.DB, c.req.param('id'));
  const body = z
    .object({ checkCalendarIds: z.array(z.string().min(1)).min(1, '空き確認に使うカレンダーを1つ以上選んでください').max(20), writeCalendarId: z.string().min(1) })
    .parse(await c.req.json());
  await updateConnectionCalendars(c.env.DB, conn.id, body.checkCalendarIds, body.writeCalendarId);
  return c.json(toConnectionInfo((await getConnection(c.env.DB, conn.id))!));
});

admin.delete('/connections/:id', async (c) => {
  const conn = await connectionOr404(c.env.DB, c.req.param('id'));
  await deleteConnection(c.env.DB, conn.id);
  return c.json({ ok: true });
});

// ---- 日程調整カレンダー ----

async function calendarOr404(db: D1Database, id: string): Promise<CalendarRow> {
  const cal = await getCalendar(db, id);
  if (!cal) throw new HttpError(404, '日程調整カレンダーが見つかりません');
  return cal;
}

async function assertMembersExist(db: D1Database, ids: string[]): Promise<void> {
  const found = await getMembersByIds(db, ids);
  if (found.length !== new Set(ids).size) throw new HttpError(400, '登録されていないメンバーが含まれています');
}

admin.get('/calendars', async (c) => {
  const base = appUrl(c.env, c);
  const rows = await listCalendars(c.env.DB);
  const [calMembers, counts] = await Promise.all([listMembersForCalendars(c.env.DB, rows.map((r) => r.id)), countUpcomingByCalendar(c.env.DB)]);
  const members = await getMembersByIds(c.env.DB, [...new Set(calMembers.map((m) => m.member_id))]);
  return c.json<CalendarSummary[]>(
    rows.map((r) => {
      const s = parseSettings(r.settings);
      return {
        id: r.id,
        kind: r.kind,
        slug: r.slug,
        name: r.name,
        internalName: r.internal_name,
        status: r.status,
        url: calendarUrl(base, r.slug),
        durationMin: s.durationMin,
        participation: s.participation,
        locationType: s.location.type,
        members: calMembers
          .filter((m) => m.calendar_id === r.id)
          .map((m) => members.find((u) => u.id === m.member_id))
          .filter((u) => u !== undefined)
          .map((u) => ({ memberId: u.id, name: u.name })),
        upcomingCount: counts.get(r.id) ?? 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    }),
  );
});

/** 新規作成。名前だけ受け取り、ほかは初期値（参加メンバーは最初に登録したメンバー1人） */
admin.post('/calendars', async (c) => {
  const { name } = z.object({ name: z.string().trim().min(1, '日程調整カレンダー名を入力してください').max(100) }).parse(await c.req.json());
  const first = (await listMembers(c.env.DB))[0];
  if (!first) throw new HttpError(400, '先に「メンバー」画面で面接官を登録してください');
  const id = await insertCalendar(c.env.DB, 'standard', {
    name,
    internalName: '',
    slug: randomSlug(),
    status: 'open',
    settings: defaultSettings(),
    members: [{ memberId: first.id, group: 1, priority: 0, bookingLimit: null }],
  });
  return c.json(await toCalendarDetail(c.env.DB, (await getCalendar(c.env.DB, id))!, appUrl(c.env, c)), 201);
});

admin.get('/calendars/:id', async (c) => {
  const cal = await calendarOr404(c.env.DB, c.req.param('id'));
  return c.json(await toCalendarDetail(c.env.DB, cal, appUrl(c.env, c)));
});

admin.put('/calendars/:id', async (c) => {
  const cal = await calendarOr404(c.env.DB, c.req.param('id'));
  const input = calendarUpdateSchema.parse(await c.req.json());
  if (await isSlugTaken(c.env.DB, input.slug, cal.id)) throw new HttpError(409, 'この URL はすでに使われています', [{ path: 'slug', message: 'この URL はすでに使われています' }]);
  if (new Set(input.members.map((m) => m.memberId)).size !== input.members.length) throw new HttpError(400, '同じメンバーが重複しています');
  await assertMembersExist(c.env.DB, input.members.map((m) => m.memberId));
  const s = input.settings;
  if (s.participation === 'groups' && (!input.members.some((m) => m.group === 1) || !input.members.some((m) => m.group === 2))) {
    throw new HttpError(400, '2つのグループそれぞれに1人以上のメンバーを入れてください', [{ path: 'members', message: '各グループに1人以上必要です' }]);
  }
  if (s.assignment === 'balanced_count' && s.participation !== 'any') {
    throw new HttpError(400, '「均等（担当件数優先）」は「誰か1人が参加」のときだけ選べます', [{ path: 'settings.assignment', message: '誰か1人が参加のときだけ選べます' }]);
  }
  await updateCalendar(c.env.DB, cal.id, input);
  return c.json(await toCalendarDetail(c.env.DB, (await getCalendar(c.env.DB, cal.id))!, appUrl(c.env, c)));
});

admin.delete('/calendars/:id', async (c) => {
  const cal = await calendarOr404(c.env.DB, c.req.param('id'));
  await deleteCalendar(c.env.DB, cal.id);
  return c.json({ ok: true });
});

admin.post('/calendars/:id/duplicate', async (c) => {
  const cal = await calendarOr404(c.env.DB, c.req.param('id'));
  const members = await listCalendarMembers(c.env.DB, cal.id);
  const id = await insertCalendar(
    c.env.DB,
    cal.kind,
    {
      name: `${cal.name}のコピー`,
      internalName: cal.internal_name,
      slug: randomSlug(),
      status: cal.kind === 'candidates' ? 'open' : cal.status,
      settings: parseSettings(cal.settings),
      members: members.map((m) => ({ memberId: m.member_id, group: m.grp, priority: m.priority, bookingLimit: m.booking_limit })),
    },
    cal.kind === 'candidates' ? await listCandidateSlots(c.env.DB, cal.id) : [],
  );
  return c.json(await toCalendarDetail(c.env.DB, (await getCalendar(c.env.DB, id))!, appUrl(c.env, c)), 201);
});

admin.get('/calendars/:id/one-time-links', async (c) => {
  const cal = await calendarOr404(c.env.DB, c.req.param('id'));
  const base = appUrl(c.env, c);
  const rows = await listOneTimeLinks(c.env.DB, cal.id);
  return c.json<OneTimeLinkInfo[]>(rows.map((r) => ({ token: r.token, url: `${calendarUrl(base, cal.slug)}?ot=${r.token}`, createdAt: r.created_at })));
});

admin.post('/calendars/:id/one-time-links', async (c) => {
  const cal = await calendarOr404(c.env.DB, c.req.param('id'));
  if (cal.kind === 'candidates') throw new HttpError(400, '候補を選んで日程調整の URL はもともと1回限りです');
  const row = await createOneTimeLink(c.env.DB, cal.id);
  return c.json<OneTimeLinkInfo>({ token: row.token, url: `${calendarUrl(appUrl(c.env, c), cal.slug)}?ot=${row.token}`, createdAt: row.created_at }, 201);
});

admin.delete('/one-time-links/:token', async (c) => {
  const link = await getOneTimeLink(c.env.DB, c.req.param('token'));
  if (!link) throw new HttpError(404, 'ワンタイム URL が見つかりません');
  await deleteOneTimeLink(c.env.DB, link.token);
  return c.json({ ok: true });
});

// ---- 候補を選んで日程調整 ----

/** 選んだメンバーが全員参加するとして、8:00〜21:00 を 30 分刻みで「空いているか」を返す（候補を選ぶ画面用） */
admin.post('/availability', async (c) => {
  const body = z
    .object({
      memberIds: z.array(z.string()).min(1).max(3),
      durationMin: z.number().int().min(15).max(480),
      from: z.iso.datetime(),
      to: z.iso.datetime(),
      timezone: z.string().refine(isValidTimeZone),
    })
    .parse(await c.req.json());
  const from = new Date(body.from);
  const to = new Date(body.to);
  if (to.getTime() - from.getTime() > 15 * 86_400_000) throw new HttpError(400, '期間は14日までにしてください');
  await assertMembersExist(c.env.DB, body.memberIds);

  const base = defaultSettings();
  const settings = {
    ...base,
    durationMin: body.durationMin,
    timezone: body.timezone,
    weekly: base.weekly.map(() => [{ start: '08:00', end: '21:00' }]),
    acceptHolidays: true,
    slotIntervalMin: 30,
    window: { mode: 'auto' as const, minNoticeHours: 0, daysAhead: 200 },
  };
  const fakeCal = { id: '', settings: '' } as CalendarRow;
  const memberRows: CalendarMemberRow[] = body.memberIds.map((id) => ({ calendar_id: '', member_id: id, grp: 1, priority: 0, booking_limit: null }));
  const { slots: free } = await findSlots(c.env, fakeCal, settings, memberRows, from, to);
  const freeSet = new Set(free.map((s) => s.start));
  // 時間割として並べる全ての枠（空いていない枠も灰色で出すため）。予定のないメンバー1人として同じ規則で求める
  const allSlots = computeSlots({
    settings,
    members: [{ userId: '', group: 1, priority: 0, busy: [], periodCounts: new Map(), limit: null, totalCount: 0 }],
    now: new Date(),
    from,
    to,
  });
  return c.json<AvailabilityResponse>({ slots: allSlots.map((s) => ({ start: s.start, end: s.end, available: freeSet.has(s.start) })) });
});

/** 候補を選んで日程調整（docs/00「5」）。全員参加・1回限りのカレンダーとして作る */
admin.post('/candidate-calendars', async (c) => {
  const body = z
    .object({
      name: z.string().trim().min(1, '予定名を入力してください').max(100),
      durationMin: z.number().int().min(15).max(480),
      memberIds: z.array(z.string()).min(1, '参加メンバーを選んでください').max(3, '参加メンバーは3人までです'),
      location: z.object({ type: z.enum(LOCATION_TYPES), detail: z.string().max(500) }),
      eventPrivate: z.boolean(),
      slots: z.array(z.iso.datetime()).min(1, '候補を1つ以上選んでください').max(20, '候補は20枠までです'),
    })
    .parse(await c.req.json());
  await assertMembersExist(c.env.DB, body.memberIds);
  const settings = {
    ...defaultSettings(),
    durationMin: body.durationMin,
    participation: 'all' as const,
    location: body.location,
    eventPrivate: body.eventPrivate,
    // 候補の開始直前まで予約できる
    window: { mode: 'auto' as const, minNoticeHours: 0, daysAhead: 200 },
  };
  const starts = [...new Set(body.slots.map((s) => new Date(s).toISOString()))].sort();
  const id = await insertCalendar(
    c.env.DB,
    'candidates',
    { name: body.name, internalName: '', slug: randomSlug(), status: 'open', settings, members: body.memberIds.map((mid, i) => ({ memberId: mid, group: 1, priority: i, bookingLimit: null })) },
    starts,
  );
  return c.json(await toCalendarDetail(c.env.DB, (await getCalendar(c.env.DB, id))!, appUrl(c.env, c)), 201);
});

// ---- 予定 ----

function bookingFilter(q: (key: string) => string | undefined): BookingFilter {
  const scope = q('scope');
  return {
    scope: scope === 'past' || scope === 'cancelled' || scope === 'all' ? scope : 'upcoming',
    calendarId: q('calendarId') || undefined,
    q: q('q')?.trim() || undefined,
  };
}

admin.get('/bookings', async (c) => {
  const rows = await listBookings(c.env.DB, bookingFilter((k) => c.req.query(k)));
  const hosts = await listBookingHosts(c.env.DB, rows.map((r) => r.id));
  return c.json<BookingListResponse>({ bookings: rows.map((r) => toBookingSummary(r, r.calendar_name, hosts.filter((h) => h.booking_id === r.id))) });
});

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** 予定の CSV（Excel で文字化けしないよう UTF-8 の BOM を付ける）。日時は日本時間 */
admin.get('/bookings.csv', async (c) => {
  const tz = 'Asia/Tokyo';
  const rows = await listBookings(c.env.DB, bookingFilter((k) => c.req.query(k)), 10_000);
  const hosts = await listBookingHosts(c.env.DB, rows.map((r) => r.id));
  const dt = (iso: string | null) => {
    if (!iso) return '';
    const p = zonedParts(new Date(iso), tz);
    return `${p.date.replaceAll('-', '/')} ${p.time}`;
  };
  const header = ['予定ID', 'ステータス', '開始日時', '終了日時', '日程調整カレンダー', '担当者', '応募者名', 'メールアドレス', '会社名', 'コメント', '場所', 'Web会議URL', 'その他の回答', 'URLパラメータ', '確定日時', 'キャンセル日時', 'キャンセルした人', 'キャンセル理由'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const answers = parseJson<Answer[]>(r.answers, [])
      .filter((a) => !['name', 'email', 'company', 'comment'].includes(a.questionId))
      .map((a) => `${a.label}: ${a.value}`)
      .join(' / ');
    const params = Object.entries(parseJson<Record<string, string>>(r.url_params, {}))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    lines.push(
      [
        r.id,
        r.status === 'confirmed' ? '確定' : 'キャンセル',
        dt(r.start_at),
        dt(r.end_at),
        r.calendar_name,
        hosts
          .filter((h) => h.booking_id === r.id)
          .map((h) => h.name)
          .join('、'),
        r.guest_name,
        r.guest_email,
        r.guest_company,
        r.guest_comment,
        LOCATION_LABELS[r.location_type] + (r.location_type !== 'google_meet' && r.location_text ? ` ${r.location_text}` : ''),
        r.meeting_url ?? '',
        answers,
        params,
        dt(r.created_at),
        dt(r.cancelled_at),
        r.cancelled_by === 'host' ? '管理者' : r.cancelled_by === 'guest' ? '応募者' : '',
        r.cancel_reason ?? '',
      ]
        .map((v) => csvCell(String(v)))
        .join(','),
    );
  }
  const filename = `bookings_${zonedParts(new Date(), tz).date}.csv`;
  return new Response('﻿' + lines.join('\r\n') + '\r\n', {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` },
  });
});

admin.get('/bookings/:id', async (c) => {
  const b = await getBooking(c.env.DB, c.req.param('id'));
  if (!b) throw new HttpError(404, '予定が見つかりません');
  const cal = await calendarOr404(c.env.DB, b.calendar_id);
  return c.json(toBookingDetail(b, cal.name, await listBookingHosts(c.env.DB, [b.id]), appUrl(c.env, c)));
});

admin.post('/bookings/:id/cancel', async (c) => {
  const b = await getBooking(c.env.DB, c.req.param('id'));
  if (!b) throw new HttpError(404, '予定が見つかりません');
  const cal = await calendarOr404(c.env.DB, b.calendar_id);
  const { reason } = z.object({ reason: z.string().max(1000).default('') }).parse(await c.req.json().catch(() => ({})));
  if (b.status === 'cancelled') throw new HttpError(400, 'この予定はすでにキャンセルされています');
  if (new Date(b.end_at).getTime() < Date.now()) throw new HttpError(400, '終了した予定はキャンセルできません');
  const base = appUrl(c.env, c);
  const updated = await cancelBooking(c.env, (p) => c.executionCtx.waitUntil(p), base, cal, b, 'host', reason);
  return c.json(toBookingDetail(updated, cal.name, await listBookingHosts(c.env.DB, [b.id]), base));
});

// ---- 送信ログ ----

admin.get('/outbox', async (c) => {
  const rows = await listOutbox(c.env.DB);
  return c.json<OutboxItem[]>(
    rows.map((r) => ({ id: r.id, kind: r.kind, toAddr: r.to_addr, subject: r.subject, body: r.body, status: r.status, error: r.error, createdAt: r.created_at })),
  );
});
