/**
 * 予約の確定・キャンセル・リスケジュール。DB・Google カレンダー・メール・Webhook をここでまとめて扱う。
 * 流れ（確定）: 空き枠を計算し直して選ばれた枠が空いているか確かめる → 担当者を決める → DB に保存
 *            → 連携カレンダーに予定を登録（Meet 発行）→ メール・Webhook（レスポンスを返した後に送る）
 */
import type { Answer, BookingCreateInput, PublicBooking } from '../../shared/api';
import { type CalendarSettings, LOCATION_LABELS, type Question } from '../../shared/schema';
import { computeSlots, type Interval, type MemberInput, periodKey, pickHosts, type Slot } from '../../shared/slots';
import { isValidTimeZone, zonedParts } from '../../shared/time';
import { type CalendarMemberRow, type CalendarRow, getOneTimeLink, listCandidateSlots, listMembers, parseSettings } from '../db/calendars';
import {
  type BookingRow,
  type ExternalEvent,
  getBooking,
  listBookingHosts,
  listCalendarAssignments,
  listInternalBusy,
  sealBookingPii,
} from '../db/bookings';
import { type ConnectionRow, getMembersByIds, listConnectionsForMembers } from '../db/members';
import type { Bindings } from '../env';
import { deleteGoogleEvent, googleBusy, insertGoogleEvent } from '../integrations/google';
import { type Mail, postSlack, postWebhook, sendMails } from '../integrations/notify';
import { seal } from '../lib/pii';
import { HttpError, manageUrl, newId, newToken, nowIso, parseJson } from '../lib/util';
import { cancelledMail, guestConfirmedMail, hostConfirmedMail, type MessageContext, rescheduledMail } from './messages';

/** レスポンスを返した後に続ける処理を登録する関数（c.executionCtx.waitUntil） */
export type Defer = (p: Promise<unknown>) => void;

// ---- 空き枠 ----

/** busy から区間 cut を取り除く（リスケのとき、自分の予定が Google 側で「予定あり」になっている分を空ける） */
function subtract(busy: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const b of busy) {
    if (b.end <= cut.start || b.start >= cut.end) out.push(b);
    else {
      if (b.start < cut.start) out.push({ start: b.start, end: cut.start });
      if (b.end > cut.end) out.push({ start: cut.end, end: b.end });
    }
  }
  return out;
}

/** 1人分の連携カレンダーの busy。連携がエラーなら、ダブルブッキングを避けるため「全部埋まっている」扱いにする */
async function externalBusy(env: Bindings, conns: ConnectionRow[], from: Date, to: Date): Promise<Interval[]> {
  const all: Interval[] = [];
  for (const conn of conns) {
    if (conn.status === 'error') return [{ start: from.getTime(), end: to.getTime() }];
    try {
      all.push(...(await googleBusy(env, conn, from, to)));
    } catch (err) {
      console.log(`[busy] 連携 ${conn.id} の空き確認に失敗: ${err instanceof Error ? err.message : String(err)}`);
      return [{ start: from.getTime(), end: to.getTime() }];
    }
  }
  return all;
}

export interface SlotQuery {
  candidateStarts?: string[];
  /** リスケ中の予定（自分自身を busy から外す） */
  exclude?: BookingRow | null;
}

/** カレンダーの [from, to) の空き枠と、計算に使ったメンバーの情報 */
export async function findSlots(
  env: Bindings,
  cal: CalendarRow,
  settings: CalendarSettings,
  memberRows: CalendarMemberRow[],
  from: Date,
  to: Date,
  q: SlotQuery = {},
): Promise<{ slots: Slot[]; members: MemberInput[] }> {
  const memberIds = memberRows.map((m) => m.member_id);
  const pad = (settings.durationMin + settings.bufferBeforeMin + settings.bufferAfterMin) * 60_000;
  const rangeFrom = new Date(from.getTime() - pad);
  const rangeTo = new Date(to.getTime() + pad);
  const excludeId = q.exclude?.id ?? null;

  const [internal, assignments, conns, excludeHosts] = await Promise.all([
    listInternalBusy(env.DB, memberIds, rangeFrom.toISOString(), rangeTo.toISOString(), excludeId),
    listCalendarAssignments(env.DB, cal.id, excludeId),
    listConnectionsForMembers(env.DB, memberIds),
    q.exclude ? listBookingHosts(env.DB, [q.exclude.id]) : Promise.resolve([]),
  ]);
  const external = await Promise.all(memberRows.map((m) => externalBusy(env, conns.filter((c) => c.member_id === m.member_id), rangeFrom, rangeTo)));

  const members: MemberInput[] = memberRows.map((m, i) => {
    let busy: Interval[] = external[i] ?? [];
    if (q.exclude && excludeHosts.some((h) => h.member_id === m.member_id)) {
      busy = subtract(busy, { start: new Date(q.exclude.block_start_at).getTime(), end: new Date(q.exclude.block_end_at).getTime() });
    }
    for (const b of internal) {
      if (b.member_id === m.member_id) busy.push({ start: new Date(b.block_start_at).getTime(), end: new Date(b.block_end_at).getTime() });
    }
    const mine = assignments.filter((a) => a.member_id === m.member_id);
    const periodCounts = new Map<string, number>();
    if (settings.limit) {
      for (const a of mine) {
        const key = periodKey(zonedParts(new Date(a.start_at), settings.timezone).date, settings.limit.period);
        periodCounts.set(key, (periodCounts.get(key) ?? 0) + 1);
      }
    }
    return {
      userId: m.member_id,
      group: m.grp,
      priority: m.priority,
      busy,
      periodCounts,
      limit: settings.limit ? (settings.limit.mode === 'uniform' ? settings.limit.count : m.booking_limit) : null,
      totalCount: mine.length,
    };
  });

  const slots = computeSlots({ settings, members, now: new Date(), from, to, candidateStarts: q.candidateStarts });
  return { slots, members };
}

// ---- 回答の検証 ----

interface GuestInfo {
  name: string;
  email: string;
  company: string;
  comment: string;
  answers: Answer[];
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function validateAnswers(questions: Question[], raw: Record<string, string | string[]>): GuestInfo {
  const issues: { path: string; message: string }[] = [];
  const answers: Answer[] = [];
  const bySystem: Partial<Record<NonNullable<Question['system']>, string>> = {};
  for (const q of questions) {
    const v = raw[q.id];
    let value: string;
    if (q.type === 'checkbox') {
      const arr = (Array.isArray(v) ? v : v ? [v] : []).filter((x) => q.options.includes(x));
      if (q.required && arr.length === 0) issues.push({ path: q.id, message: `「${q.label}」を1つ以上選んでください` });
      value = arr.join('、');
    } else {
      value = (Array.isArray(v) ? v.join(',') : (v ?? '')).trim();
      if (q.required && value === '') issues.push({ path: q.id, message: `「${q.label}」を入力してください` });
      if (value.length > 5000) issues.push({ path: q.id, message: `「${q.label}」が長すぎます` });
      if (value !== '') {
        if (q.system === 'email' && !EMAIL_RE.test(value)) issues.push({ path: q.id, message: 'メールアドレスは半角英数字で「username@domain」の形で入力してください' });
        if (q.type === 'number' && !/^[0-9]+$/.test(value)) issues.push({ path: q.id, message: `「${q.label}」は半角数字で入力してください` });
        if (q.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) issues.push({ path: q.id, message: `「${q.label}」は日付を選んでください` });
        if ((q.type === 'radio' || q.type === 'select') && !q.options.includes(value)) issues.push({ path: q.id, message: `「${q.label}」は選択肢から選んでください` });
      }
    }
    if (q.system) bySystem[q.system] = value;
    answers.push({ questionId: q.id, label: q.label, value });
  }
  if (issues.length > 0) throw new HttpError(400, issues[0]!.message, issues);
  return { name: bySystem.name ?? '', email: (bySystem.email ?? '').toLowerCase(), company: bySystem.company ?? '', comment: bySystem.comment ?? '', answers };
}

// ---- 表示用 ----

/** キャンセル・リスケの期限。未設定なら終了時刻まで、設定があれば開始の N 時間前まで */
export function deadlineOf(b: BookingRow, cal: CalendarRow, settings: CalendarSettings): Date {
  if (cal.kind === 'candidates' || settings.cancelDeadlineHours === null) return new Date(b.end_at);
  return new Date(new Date(b.start_at).getTime() - settings.cancelDeadlineHours * 3_600_000);
}

export async function toPublicBooking(env: Bindings, b: BookingRow, cal: CalendarRow): Promise<PublicBooking> {
  const settings = parseSettings(cal.settings);
  const hosts = await listBookingHosts(env.DB, [b.id]);
  const hostNames = hosts.map((h) => h.name);
  const deadline = deadlineOf(b, cal, settings);
  const open = b.status === 'confirmed' && Date.now() < deadline.getTime();
  return {
    calendarSlug: cal.slug,
    calendarName: cal.name,
    calendarKind: cal.kind,
    displayName: settings.displayName || hostNames.join('、'),
    status: b.status,
    startAt: b.start_at,
    endAt: b.end_at,
    guestName: b.guest_name,
    guestEmail: b.guest_email,
    guestTimezone: b.guest_timezone,
    locationType: b.location_type,
    locationLabel: LOCATION_LABELS[b.location_type],
    locationText: b.location_type === 'google_meet' ? '' : b.location_text,
    meetingUrl: settings.hideMeetingUrl ? null : b.meeting_url,
    hostNames,
    completeMessage: settings.completeMessage,
    manageToken: b.manage_token,
    canCancel: open && settings.allowGuestCancel,
    canReschedule: open && settings.allowGuestReschedule && cal.kind === 'standard' && cal.status === 'open',
    deadlineAt: deadline.toISOString(),
    cancelledBy: b.cancelled_by,
  };
}

// ---- 連携カレンダーへの登録・削除 ----

function eventTitle(settings: CalendarSettings, cal: CalendarRow, b: BookingRow): string {
  return settings.eventTitle.replaceAll('{calendar}', cal.name).replaceAll('{guest}', b.guest_name).replaceAll('{company}', b.guest_company);
}

function eventDescription(appName: string, b: BookingRow): string {
  const answers = parseJson<Answer[]>(b.answers, []).filter((a) => a.value !== '');
  return [`${appName} で日程調整された予定です。`, '', ...answers.map((a) => `${a.label}: ${a.value}`)].join('\n');
}

/**
 * 担当者の連携カレンダーに予定を登録する。本体の予定は「連携している担当者のうち先頭の人」のカレンダーに作り、
 * ほかの担当者とゲストを参加者に入れる（各自のカレンダーにも入る）。確保時間の予定は担当者それぞれに作る。
 * 失敗しても予約自体は確定のまま（ログに残す）
 */
async function registerEvents(env: Bindings, cal: CalendarRow, settings: CalendarSettings, b: BookingRow, hostIds: string[]): Promise<{ meetingUrl: string | null; external: Map<string, ExternalEvent> }> {
  const [conns, members] = await Promise.all([listConnectionsForMembers(env.DB, hostIds), getMembersByIds(env.DB, hostIds)]);
  const connOf = (id: string) => conns.find((c) => c.member_id === id && c.status === 'active');
  const external = new Map<string, ExternalEvent>();
  let meetingUrl: string | null = null;

  const leadId = hostIds.find((id) => connOf(id));
  if (leadId) {
    const lead = connOf(leadId)!;
    const others = hostIds.filter((id) => id !== leadId).map((id) => connOf(id)?.account_email ?? members.find((u) => u.id === id)?.email);
    try {
      const ev = await insertGoogleEvent(env, lead, {
        summary: eventTitle(settings, cal, b),
        description: eventDescription(env.APP_NAME, b),
        start: b.start_at,
        end: b.end_at,
        attendees: [b.guest_email, ...others.filter((e): e is string => Boolean(e))],
        location: b.location_type === 'google_meet' ? undefined : b.location_text || undefined,
        private: settings.eventPrivate,
        withMeet: b.location_type === 'google_meet',
      });
      meetingUrl = ev.meetUrl;
      external.set(leadId, { connectionId: lead.id, calendarId: lead.write_calendar_id, eventId: ev.id, bufferEventIds: [] });
    } catch (err) {
      console.log(`[event] 予定の登録に失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (settings.bufferBeforeMin > 0 || settings.bufferAfterMin > 0) {
    for (const uid of hostIds) {
      const conn = connOf(uid);
      if (!conn) continue;
      const rec = external.get(uid) ?? { connectionId: conn.id, calendarId: conn.write_calendar_id, eventId: null, bufferEventIds: [] };
      const ranges = [
        settings.bufferBeforeMin > 0 ? [b.block_start_at, b.start_at] : null,
        settings.bufferAfterMin > 0 ? [b.end_at, b.block_end_at] : null,
      ].filter((r): r is string[] => r !== null);
      for (const [start, end] of ranges) {
        try {
          const ev = await insertGoogleEvent(env, conn, { summary: settings.bufferEventTitle, description: '', start: start!, end: end!, attendees: [], private: true, withMeet: false });
          rec.bufferEventIds.push(ev.id);
        } catch (err) {
          console.log(`[event] 確保時間の登録に失敗: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      external.set(uid, rec);
    }
  }
  return { meetingUrl, external };
}

async function removeEvents(env: Bindings, hosts: { member_id: string; external_event: string | null }[]): Promise<void> {
  const recs = hosts.map((h) => parseJson<ExternalEvent | null>(h.external_event, null)).filter((r): r is ExternalEvent => r !== null);
  if (recs.length === 0) return;
  const conns = await listConnectionsForMembers(env.DB, hosts.map((h) => h.member_id));
  for (const rec of recs) {
    const conn = conns.find((c) => c.id === rec.connectionId);
    if (!conn) continue;
    for (const id of [rec.eventId, ...rec.bufferEventIds]) {
      if (!id) continue;
      try {
        await deleteGoogleEvent(env, conn, rec.calendarId, id);
      } catch (err) {
        console.log(`[event] 予定の削除に失敗: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

async function saveExternal(env: Bindings, bookingId: string, meetingUrl: string | null, locationText: string, external: Map<string, ExternalEvent>): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE bookings SET meeting_url = ?, location_text = ?, updated_at = ? WHERE id = ?').bind(meetingUrl, locationText, nowIso(), bookingId),
    ...[...external].map(([uid, rec]) =>
      env.DB.prepare('UPDATE booking_hosts SET external_event = ? WHERE booking_id = ? AND member_id = ?').bind(JSON.stringify(rec), bookingId, uid),
    ),
  ]);
}

function locationTextOf(settings: CalendarSettings, meetingUrl: string | null): string {
  if (settings.location.type === 'google_meet') return meetingUrl ?? '';
  return settings.location.detail;
}

// ---- 通知 ----

async function messageContext(env: Bindings, base: string, cal: CalendarRow, b: BookingRow): Promise<{ ctx: MessageContext; hostEmails: string[] }> {
  const settings = parseSettings(cal.settings);
  const hosts = await listBookingHosts(env.DB, [b.id]);
  const active = b.status === 'confirmed' ? hosts.filter((h) => h.active === 1) : hosts;
  return {
    ctx: {
      appName: env.APP_NAME,
      calendarName: cal.name,
      calendarKind: cal.kind,
      settings,
      booking: b,
      hostNames: active.map((h) => h.name),
      manageUrl: manageUrl(base, b.manage_token),
      icsUrl: `${base}/api/public/bookings/${b.manage_token}/ics`,
    },
    hostEmails: active.map((h) => h.email),
  };
}

function webhookPayload(event: string, cal: CalendarRow, ctx: MessageContext) {
  const b = ctx.booking;
  return {
    event,
    sentAt: nowIso(),
    calendar: { id: cal.id, name: cal.name, slug: cal.slug },
    booking: {
      id: b.id,
      status: b.status,
      startAt: b.start_at,
      endAt: b.end_at,
      guest: { name: b.guest_name, email: b.guest_email, company: b.guest_company, comment: b.guest_comment, timezone: b.guest_timezone },
      answers: parseJson<Answer[]>(b.answers, []),
      urlParams: parseJson<Record<string, string>>(b.url_params, {}),
      hosts: ctx.hostNames,
      location: { type: b.location_type, text: b.location_text },
      meetingUrl: b.meeting_url,
      manageUrl: ctx.manageUrl,
      cancelReason: b.cancel_reason,
    },
  };
}

function hostRecipients(settings: CalendarSettings, hostEmails: string[]): string[] {
  return settings.hostEmails ? [...hostEmails, ...settings.notifyEmails] : [];
}

// ---- 確定 ----

/** 担当メンバーの行。メンバーを後で削除しても誰の予定だったか分かるよう、名前とメールを控えておく */
async function hostInserts(env: Bindings, bookingId: string, hostIds: string[], startAt: string): Promise<D1PreparedStatement[]> {
  const members = await getMembersByIds(env.DB, hostIds);
  return Promise.all(
    hostIds.map(async (id) => {
      const m = members.find((x) => x.id === id);
      return env.DB.prepare('INSERT INTO booking_hosts (booking_id, member_id, member_name, member_email_enc, start_at, active) VALUES (?, ?, ?, ?, ?, 1)').bind(
        bookingId,
        id,
        m?.name ?? '',
        await seal(m?.email ?? ''),
        startAt,
      );
    }),
  );
}

export async function confirmBooking(env: Bindings, defer: Defer, base: string, cal: CalendarRow, input: BookingCreateInput): Promise<BookingRow> {
  const settings = parseSettings(cal.settings);
  if (cal.status !== 'open') throw new HttpError(410, cal.kind === 'candidates' ? 'この日程調整はすでに完了しています' : '現在、日程調整を受け付けていません');
  if (input.oneTimeToken) {
    const link = await getOneTimeLink(env.DB, input.oneTimeToken);
    if (!link || link.calendar_id !== cal.id) throw new HttpError(404, 'この URL は無効です');
    if (link.used_at) throw new HttpError(410, 'この URL はすでに使用済みです');
  }
  const start = new Date(input.start);
  if (Number.isNaN(start.getTime())) throw new HttpError(400, '日時が正しくありません');
  const guest = validateAnswers(settings.questions, input.answers ?? {});
  const guestTz = isValidTimeZone(input.timezone) ? input.timezone : settings.timezone;

  const memberRows = await listMembers(env.DB, cal.id);
  const candidateStarts = cal.kind === 'candidates' ? await listCandidateSlots(env.DB, cal.id) : undefined;
  const { slots, members } = await findSlots(env, cal, settings, memberRows, start, new Date(start.getTime() + 1), { candidateStarts });
  const slot = slots.find((s) => s.start === start.toISOString());
  if (!slot) throw new HttpError(409, 'この日時は選べなくなりました。別の日時を選んでください');
  const hostIds = pickHosts(slot, members, settings);

  const now = nowIso();
  const end = new Date(slot.end);
  const b: BookingRow = {
    id: newId(),
    calendar_id: cal.id,
    status: 'confirmed',
    start_at: slot.start,
    end_at: slot.end,
    block_start_at: new Date(start.getTime() - settings.bufferBeforeMin * 60_000).toISOString(),
    block_end_at: new Date(end.getTime() + settings.bufferAfterMin * 60_000).toISOString(),
    guest_name: guest.name,
    guest_email: guest.email,
    guest_company: guest.company,
    guest_comment: guest.comment,
    guest_timezone: guestTz,
    answers: JSON.stringify(guest.answers),
    url_params: JSON.stringify(sanitizeParams(input.urlParams)),
    location_type: settings.location.type,
    location_text: locationTextOf(settings, null),
    meeting_url: null,
    manage_token: newToken(),
    one_time_token: input.oneTimeToken ?? null,
    reschedule_count: 0,
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    reminder_sent_at: null,
    created_at: now,
    updated_at: now,
  };

  const db = env.DB;
  const pii = await sealBookingPii(b);
  const statements = [
    db
      .prepare(
        `INSERT INTO bookings (id, calendar_id, status, start_at, end_at, block_start_at, block_end_at, guest_name, guest_email_enc, guest_email_hash, guest_company, guest_comment,
          guest_timezone, answers_enc, url_params, location_type, location_text, meeting_url, manage_token, one_time_token, reschedule_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(b.id, b.calendar_id, b.status, b.start_at, b.end_at, b.block_start_at, b.block_end_at, b.guest_name, pii.guestEmailEnc, pii.guestEmailHash, b.guest_company, b.guest_comment, b.guest_timezone, pii.answersEnc, b.url_params, b.location_type, b.location_text, null, b.manage_token, b.one_time_token, now, now),
    ...(await hostInserts(env, b.id, hostIds, b.start_at)),
  ];
  // ワンタイム URL・候補を選ぶ方式は1回きり。「まだ使われていなければ」の条件つきで閉じ、閉じられなかったら（同時に別の人が確定した）取り消す
  const guards: number[] = [];
  if (input.oneTimeToken) {
    guards.push(statements.length);
    statements.push(db.prepare('UPDATE one_time_links SET used_at = ? WHERE token = ? AND used_at IS NULL').bind(now, input.oneTimeToken));
  }
  if (cal.kind === 'candidates') {
    guards.push(statements.length);
    statements.push(db.prepare("UPDATE booking_calendars SET status = 'closed', updated_at = ? WHERE id = ? AND status = 'open'").bind(now, cal.id));
  }
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) throw new HttpError(409, 'この日時は直前に埋まりました。別の日時を選んでください');
    throw err;
  }
  if (guards.some((i) => (results[i]?.meta.changes ?? 0) === 0)) {
    await db.prepare('DELETE FROM bookings WHERE id = ?').bind(b.id).run();
    throw new HttpError(410, 'この URL はすでに使用済みです');
  }

  // 連携カレンダーに登録して Meet の URL を受け取る（完了画面に出すため、ここは待つ）
  const { meetingUrl, external } = await registerEvents(env, cal, settings, b, hostIds);
  b.meeting_url = meetingUrl;
  b.location_text = locationTextOf(settings, meetingUrl);
  await saveExternal(env, b.id, meetingUrl, b.location_text, external);

  defer(
    (async () => {
      const { ctx, hostEmails } = await messageContext(env, base, cal, b);
      const mails: Mail[] = [];
      if (settings.sendGuestConfirmation) mails.push({ kind: 'guest_confirmed', to: b.guest_email, bookingId: b.id, ...guestConfirmedMail(ctx) });
      for (const to of hostRecipients(settings, hostEmails)) mails.push({ kind: 'host_confirmed', to, bookingId: b.id, replyTo: b.guest_email, ...hostConfirmedMail(ctx) });
      await sendMails(env, mails);
      await postWebhook(settings.webhookUrl, webhookPayload('booking.confirmed', cal, ctx));
      await postSlack(settings.slackWebhookUrl, `:calendar: 日程確定: ${b.guest_name}様（${cal.name}）\n${hostConfirmedMail(ctx).subject}`);
    })(),
  );
  return b;
}

/** URL パラメータは文字列だけ、最大 30 個・各 500 文字まで保存する */
function sanitizeParams(params: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params ?? {}).slice(0, 30)) {
    if (typeof v === 'string' && /^[\w.-]{1,64}$/.test(k)) out[k] = v.slice(0, 500);
  }
  return out;
}

// ---- キャンセル ----

export async function cancelBooking(env: Bindings, defer: Defer, base: string, cal: CalendarRow, b: BookingRow, by: 'guest' | 'host', reason: string): Promise<BookingRow> {
  if (b.status === 'cancelled') return b;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?").bind(now, by, reason.slice(0, 1000) || null, now, b.id),
    env.DB.prepare('UPDATE booking_hosts SET active = 0 WHERE booking_id = ?').bind(b.id),
  ]);
  const updated = (await getBooking(env.DB, b.id))!;
  const hosts = await listBookingHosts(env.DB, [b.id]);
  defer(
    (async () => {
      await removeEvents(env, hosts);
      const settings = parseSettings(cal.settings);
      const { ctx, hostEmails } = await messageContext(env, base, cal, updated);
      const mails: Mail[] = [{ kind: 'cancelled', to: updated.guest_email, bookingId: b.id, ...cancelledMail(ctx, true) }];
      for (const to of hostRecipients(settings, hostEmails)) mails.push({ kind: 'cancelled', to, bookingId: b.id, ...cancelledMail(ctx, false) });
      await sendMails(env, mails);
      await postWebhook(settings.webhookUrl, webhookPayload('booking.cancelled', cal, ctx));
      await postSlack(settings.slackWebhookUrl, `:x: キャンセル: ${updated.guest_name}様（${cal.name}）\n${cancelledMail(ctx, false).subject}`);
    })(),
  );
  return updated;
}

// ---- リスケジュール ----

export async function rescheduleBooking(env: Bindings, defer: Defer, base: string, cal: CalendarRow, b: BookingRow, newStart: string): Promise<BookingRow> {
  const settings = parseSettings(cal.settings);
  const start = new Date(newStart);
  if (Number.isNaN(start.getTime())) throw new HttpError(400, '日時が正しくありません');
  const memberRows = await listMembers(env.DB, cal.id);
  const { slots, members } = await findSlots(env, cal, settings, memberRows, start, new Date(start.getTime() + 1), { exclude: b });
  const slot = slots.find((s) => s.start === start.toISOString());
  if (!slot) throw new HttpError(409, 'この日時は選べなくなりました。別の日時を選んでください');
  const hostIds = pickHosts(slot, members, settings);
  const oldHosts = await listBookingHosts(env.DB, [b.id]);
  const old = { start_at: b.start_at, end_at: b.end_at };

  const now = nowIso();
  const end = new Date(slot.end);
  const blockStart = new Date(start.getTime() - settings.bufferBeforeMin * 60_000).toISOString();
  const blockEnd = new Date(end.getTime() + settings.bufferAfterMin * 60_000).toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM booking_hosts WHERE booking_id = ?').bind(b.id),
      ...(await hostInserts(env, b.id, hostIds, slot.start)),
      env.DB.prepare(
        `UPDATE bookings SET start_at = ?, end_at = ?, block_start_at = ?, block_end_at = ?, reschedule_count = reschedule_count + 1,
           reminder_sent_at = NULL, meeting_url = NULL, location_text = ?, updated_at = ? WHERE id = ?`,
      ).bind(slot.start, slot.end, blockStart, blockEnd, locationTextOf(settings, null), now, b.id),
    ]);
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) throw new HttpError(409, 'この日時は直前に埋まりました。別の日時を選んでください');
    throw err;
  }

  // 古い予定を消して、新しい日時で登録し直す（Meet の URL も新しくなる）
  await removeEvents(env, oldHosts);
  const updated = (await getBooking(env.DB, b.id))!;
  const { meetingUrl, external } = await registerEvents(env, cal, settings, updated, hostIds);
  updated.meeting_url = meetingUrl;
  updated.location_text = locationTextOf(settings, meetingUrl);
  await saveExternal(env, b.id, meetingUrl, updated.location_text, external);

  defer(
    (async () => {
      const { ctx, hostEmails } = await messageContext(env, base, cal, updated);
      // 担当から外れた人にも知らせる
      const emails = [...new Set([...hostEmails, ...oldHosts.map((h) => h.email)])];
      const mails: Mail[] = [{ kind: 'rescheduled', to: updated.guest_email, bookingId: b.id, ...rescheduledMail(ctx, old, true) }];
      for (const to of hostRecipients(settings, emails)) mails.push({ kind: 'rescheduled', to, bookingId: b.id, ...rescheduledMail(ctx, old, false) });
      await sendMails(env, mails);
      await postWebhook(settings.webhookUrl, webhookPayload('booking.rescheduled', cal, ctx));
      await postSlack(settings.slackWebhookUrl, `:arrows_counterclockwise: 日程変更: ${updated.guest_name}様（${cal.name}）\n${rescheduledMail(ctx, old, false).subject}`);
    })(),
  );
  return updated;
}
