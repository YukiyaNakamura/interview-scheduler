/** 応募者用の公開 API（ログイン不要。docs/01「API」応募者用） */
import { Hono } from 'hono';
import { z } from 'zod';
import type { BookingCreateResponse, PublicCalendar, SlotsResponse } from '../../shared/api';
import { type CalendarSettings, LOCATION_LABELS } from '../../shared/schema';
import { windowOf } from '../../shared/slots';
import { getBookingByToken } from '../db/bookings';
import { type CalendarRow, getCalendar, getCalendarBySlug, getOneTimeLink, listCandidateSlots, listMembers, parseSettings } from '../db/calendars';
import { getMembersByIds } from '../db/members';
import type { AppEnv } from '../env';
import { noSlotMail } from '../services/messages';
import { sendMails } from '../integrations/notify';
import { buildIcs } from '../lib/ics';
import { appUrl, HttpError, manageUrl } from '../lib/util';
import { cancelBooking, confirmBooking, findSlots, rescheduleBooking, toPublicBooking } from '../services/booking';

export const publicApi = new Hono<AppEnv>();

async function calendarBySlug(db: D1Database, slug: string): Promise<{ cal: CalendarRow; settings: CalendarSettings }> {
  const cal = await getCalendarBySlug(db, slug);
  if (!cal) throw new HttpError(404, '日程調整カレンダーが見つかりません');
  return { cal, settings: parseSettings(cal.settings) };
}

/** 閲覧パスワードの確認（ヘッダー x-calendar-password） */
function passwordOk(settings: CalendarSettings, given: string | undefined): boolean {
  return settings.password === '' || given === settings.password;
}

/** 受け付けられない理由。受け付けられるなら null */
async function closedReasonOf(db: D1Database, cal: CalendarRow, settings: CalendarSettings, ot: string | undefined): Promise<string | null> {
  if (cal.kind === 'candidates' && cal.status === 'closed') return 'この日程調整はすでに完了しています';
  if (cal.status !== 'open') return '現在、日程調整を受け付けていません';
  if (ot) {
    const link = await getOneTimeLink(db, ot);
    if (!link || link.calendar_id !== cal.id) return 'この URL は無効です';
    if (link.used_at) return 'この URL はすでに使用済みです';
  }
  if (cal.kind === 'standard' && windowOf(settings, new Date()).expired) return 'ただいま受付期間外です';
  return null;
}

publicApi.get('/c/:slug', async (c) => {
  const { cal, settings } = await calendarBySlug(c.env.DB, c.req.param('slug'));
  const locked = !passwordOk(settings, c.req.header('x-calendar-password'));
  const base: PublicCalendar = {
    slug: cal.slug,
    kind: cal.kind,
    name: cal.name,
    displayName: '',
    status: cal.status,
    closedReason: await closedReasonOf(c.env.DB, cal, settings, c.req.query('ot')),
    locked,
    description: '',
    durationMin: settings.durationMin,
    timezone: settings.timezone,
    locationType: settings.location.type,
    locationLabel: LOCATION_LABELS[settings.location.type],
    hosts: [],
    questions: [],
    notifyNoSlot: false,
    window: null,
  };
  if (locked) return c.json(base);

  const members = await listMembers(c.env.DB, cal.id);
  const users = await getMembersByIds(c.env.DB, members.map((m) => m.member_id));
  const hosts = members.map((m) => users.find((u) => u.id === m.member_id)).filter((u) => u !== undefined);
  let window: PublicCalendar['window'];
  if (cal.kind === 'candidates') {
    const starts = await listCandidateSlots(c.env.DB, cal.id);
    window = starts.length ? { start: starts[0]!.slice(0, 10), end: starts.at(-1)!.slice(0, 10) } : null;
  } else {
    const w = windowOf(settings, new Date());
    window = { start: w.startDate, end: w.endDate };
  }
  return c.json<PublicCalendar>({
    ...base,
    displayName: settings.displayName || hosts.map((u) => u.name).join('、'),
    description: settings.description,
    hosts: hosts.map((u) => ({ name: u.name, avatarUrl: null })),
    questions: settings.questions,
    notifyNoSlot: settings.notifyNoSlot,
    window,
  });
});

publicApi.get('/c/:slug/slots', async (c) => {
  const { cal, settings } = await calendarBySlug(c.env.DB, c.req.param('slug'));
  const q = z
    .object({ from: z.iso.datetime(), to: z.iso.datetime(), ot: z.string().optional(), reschedule: z.string().optional() })
    .parse({ from: c.req.query('from'), to: c.req.query('to'), ot: c.req.query('ot') || undefined, reschedule: c.req.query('reschedule') || undefined });
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (to <= from || to.getTime() - from.getTime() > 32 * 86_400_000) throw new HttpError(400, '期間が正しくありません（最大31日）');

  // リスケ中のゲストは予定確認ページから来るのでパスワードを知らない。正しい予定のトークンがあればパスワードの代わりにする
  let exclude = null;
  if (q.reschedule) {
    exclude = await getBookingByToken(c.env.DB, q.reschedule);
    if (!exclude || exclude.calendar_id !== cal.id || exclude.status !== 'confirmed') throw new HttpError(404, '予定が見つかりません');
  } else if (!passwordOk(settings, c.req.header('x-calendar-password'))) {
    throw new HttpError(403, 'パスワードが違います');
  } else if (await closedReasonOf(c.env.DB, cal, settings, q.ot)) {
    return c.json<SlotsResponse>({ slots: [] });
  }
  const memberRows = await listMembers(c.env.DB, cal.id);
  const candidateStarts = cal.kind === 'candidates' ? await listCandidateSlots(c.env.DB, cal.id) : undefined;
  const { slots } = await findSlots(c.env, cal, settings, memberRows, from, to, { candidateStarts, exclude });
  return c.json<SlotsResponse>({ slots: slots.map((s) => ({ start: s.start, end: s.end })) });
});

const bookingInputSchema = z.object({
  start: z.iso.datetime(),
  timezone: z.string().max(64),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  oneTimeToken: z.string().max(100).optional(),
  urlParams: z.record(z.string(), z.string()).optional(),
});

publicApi.post('/c/:slug/bookings', async (c) => {
  const { cal, settings } = await calendarBySlug(c.env.DB, c.req.param('slug'));
  if (!passwordOk(settings, c.req.header('x-calendar-password'))) throw new HttpError(403, 'パスワードが違います');
  const input = bookingInputSchema.parse(await c.req.json());
  const b = await confirmBooking(c.env, (p) => c.executionCtx.waitUntil(p), appUrl(c.env, c), cal, input);
  return c.json<BookingCreateResponse>({ booking: await toPublicBooking(c.env, b, cal), redirectUrl: settings.redirectUrl || null }, 201);
});

publicApi.post('/c/:slug/no-slot', async (c) => {
  const { cal, settings } = await calendarBySlug(c.env.DB, c.req.param('slug'));
  if (!settings.notifyNoSlot || !passwordOk(settings, c.req.header('x-calendar-password'))) throw new HttpError(404, 'Not Found');
  const input = z.object({ name: z.string().trim().min(1, '名前を入力してください').max(100), email: z.email('メールアドレスが正しくありません'), message: z.string().max(2000) }).parse(await c.req.json());
  const members = await listMembers(c.env.DB, cal.id);
  const users = await getMembersByIds(c.env.DB, members.map((m) => m.member_id));
  const mail = noSlotMail(c.env.APP_NAME, cal.name, input);
  const to = [...users.map((u) => u.email), ...settings.notifyEmails];
  c.executionCtx.waitUntil(sendMails(c.env, to.map((addr) => ({ kind: 'no_slot' as const, to: addr, replyTo: input.email, ...mail }))));
  return c.json({ ok: true });
});

// ---- 予定（ゲスト） ----

async function bookingByToken(db: D1Database, token: string) {
  const b = await getBookingByToken(db, token);
  if (!b) throw new HttpError(404, '予定が見つかりません');
  const cal = (await getCalendar(db, b.calendar_id))!;
  return { b, cal };
}

publicApi.get('/bookings/:token', async (c) => {
  const { b, cal } = await bookingByToken(c.env.DB, c.req.param('token'));
  return c.json(await toPublicBooking(c.env, b, cal));
});

publicApi.post('/bookings/:token/cancel', async (c) => {
  const { b, cal } = await bookingByToken(c.env.DB, c.req.param('token'));
  const pub = await toPublicBooking(c.env, b, cal);
  if (!pub.canCancel) throw new HttpError(400, b.status === 'cancelled' ? 'この予定はすでにキャンセルされています' : 'キャンセルの受付期限を過ぎています');
  const { reason } = z.object({ reason: z.string().max(1000).default('') }).parse(await c.req.json().catch(() => ({})));
  const updated = await cancelBooking(c.env, (p) => c.executionCtx.waitUntil(p), appUrl(c.env, c), cal, b, 'guest', reason);
  return c.json(await toPublicBooking(c.env, updated, cal));
});

publicApi.post('/bookings/:token/reschedule', async (c) => {
  const { b, cal } = await bookingByToken(c.env.DB, c.req.param('token'));
  const pub = await toPublicBooking(c.env, b, cal);
  if (!pub.canReschedule) throw new HttpError(400, '日程変更の受付期限を過ぎているか、この予定は日程変更できません');
  const { start } = z.object({ start: z.iso.datetime() }).parse(await c.req.json());
  const updated = await rescheduleBooking(c.env, (p) => c.executionCtx.waitUntil(p), appUrl(c.env, c), cal, b, start);
  return c.json(await toPublicBooking(c.env, updated, cal));
});

publicApi.get('/bookings/:token/ics', async (c) => {
  const { b, cal } = await bookingByToken(c.env.DB, c.req.param('token'));
  const pub = await toPublicBooking(c.env, b, cal);
  const location = pub.meetingUrl ?? pub.locationText;
  const ics = buildIcs({
    uid: `${b.id}@aiteru`,
    start: b.start_at,
    end: b.end_at,
    summary: cal.name,
    description: [pub.displayName && `担当: ${pub.displayName}`, location && `場所: ${pub.locationLabel} ${location}`, `予定の確認・変更: ${manageUrl(appUrl(c.env, c), b.manage_token)}`]
      .filter(Boolean)
      .join('\n'),
    location,
    url: manageUrl(appUrl(c.env, c), b.manage_token),
    cancelled: b.status === 'cancelled',
    sequence: b.reschedule_count,
  });
  return new Response(ics, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="invite.ics"' } });
});
