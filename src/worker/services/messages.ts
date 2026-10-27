/**
 * メールの件名・本文（テキストメール）。docs/00「7. メール」。
 * 応募者宛ては応募者のタイムゾーン、面接官宛てはカレンダーのタイムゾーンで日時を書く
 */
import type { Answer } from '../../shared/api';
import { type CalendarSettings, LOCATION_LABELS } from '../../shared/schema';
import { formatRangeJa } from '../../shared/time';
import type { BookingRow } from '../db/bookings';
import { parseJson } from '../lib/util';

export interface MessageContext {
  appName: string;
  calendarName: string;
  calendarKind: 'standard' | 'candidates';
  settings: CalendarSettings;
  booking: BookingRow;
  hostNames: string[];
  manageUrl: string;
  icsUrl: string;
}

/** ゲストの予定確認ページの案内文。候補を選ぶ方式・リスケ不可の設定では「日程変更」を書かない */
function manageLine(ctx: MessageContext): string {
  const canReschedule = ctx.calendarKind === 'standard' && ctx.settings.allowGuestReschedule;
  const actions = ['確認', ctx.settings.allowGuestCancel ? 'キャンセル' : '', canReschedule ? '日程変更' : ''].filter(Boolean).join('・');
  return `予定の${actions}はこちら:\n${ctx.manageUrl}`;
}

const tzLabel = (tz: string) => (tz === 'Asia/Tokyo' ? '日本時間' : tz);
const when = (b: { start_at: string; end_at: string }, tz: string) => `${formatRangeJa(b.start_at, b.end_at, tz)}（${tzLabel(tz)}）`;

/** 場所の行。ゲスト宛てで Web 会議 URL を非公開にしている場合は URL を出さない */
function placeLine(ctx: MessageContext, forGuest: boolean): string {
  const b = ctx.booking;
  const label = LOCATION_LABELS[b.location_type];
  if (b.location_type === 'none') return '';
  if (b.location_type === 'google_meet') {
    if (forGuest && ctx.settings.hideMeetingUrl) return `場所: ${label}（URL は別途ご案内します）`;
    return `場所: ${label} ${b.meeting_url ?? '（URL は別途ご案内します）'}`;
  }
  return `場所: ${label}${b.location_text ? ` ${b.location_text}` : ''}`;
}

function answersBlock(b: BookingRow): string {
  const answers = parseJson<Answer[]>(b.answers, []);
  const lines = answers.filter((a) => a.value !== '').map((a) => `${a.label}: ${a.value}`);
  return lines.length ? `■ ご入力内容\n${lines.join('\n')}` : '';
}

function footer(ctx: MessageContext): string {
  return `--\nこのメールは ${ctx.appName} から自動送信されています。`;
}

const join = (parts: string[]) => parts.filter((p) => p !== '').join('\n\n') + '\n';

function summary(ctx: MessageContext, tz: string, forGuest: boolean): string {
  const host = ctx.settings.displayName || ctx.hostNames.join('、');
  return [`■ ${ctx.calendarName}`, `日時: ${when(ctx.booking, tz)}`, placeLine(ctx, forGuest), host ? `担当: ${host}` : ''].filter(Boolean).join('\n');
}

export function guestConfirmedMail(ctx: MessageContext) {
  const b = ctx.booking;
  return {
    subject: `【日程確定】${ctx.calendarName} ${formatRangeJa(b.start_at, b.end_at, b.guest_timezone)}`,
    body: join([
      `${b.guest_name} 様`,
      '日程調整が完了しました。当日はよろしくお願いいたします。',
      summary(ctx, b.guest_timezone, true),
      ctx.settings.completeMessage,
      answersBlock(b),
      manageLine(ctx),
      `カレンダーに追加（ICS ファイル）:\n${ctx.icsUrl}`,
      footer(ctx),
    ]),
  };
}

export function hostConfirmedMail(ctx: MessageContext) {
  const b = ctx.booking;
  const tz = ctx.settings.timezone;
  return {
    subject: `【日程確定】${b.guest_name}様 ${formatRangeJa(b.start_at, b.end_at, tz)}（${ctx.calendarName}）`,
    body: join([
      `${b.guest_name}様（${b.guest_email}）との日程調整が完了しました。`,
      summary(ctx, tz, false),
      answersBlock(b),
      footer(ctx),
    ]),
  };
}

export function cancelledMail(ctx: MessageContext, forGuest: boolean) {
  const b = ctx.booking;
  const tz = forGuest ? b.guest_timezone : ctx.settings.timezone;
  const by = b.cancelled_by === 'host' ? '管理者' : '応募者';
  return {
    subject: `【キャンセル】${ctx.calendarName} ${formatRangeJa(b.start_at, b.end_at, tz)}`,
    body: join([
      forGuest ? `${b.guest_name} 様` : '',
      forGuest
        ? '以下の予定はキャンセルされました。'
        : `${b.guest_name}様（${b.guest_email}）との予定が${by}によりキャンセルされました。`,
      summary(ctx, tz, forGuest),
      b.cancel_reason ? `キャンセル理由: ${b.cancel_reason}` : '',
      footer(ctx),
    ]),
  };
}

export function rescheduledMail(ctx: MessageContext, old: { start_at: string; end_at: string }, forGuest: boolean) {
  const b = ctx.booking;
  const tz = forGuest ? b.guest_timezone : ctx.settings.timezone;
  return {
    subject: `【日程変更】${ctx.calendarName} ${formatRangeJa(b.start_at, b.end_at, tz)}`,
    body: join([
      forGuest ? `${b.guest_name} 様` : `${b.guest_name}様（${b.guest_email}）との予定の日時が変更されました。`,
      forGuest ? '予定の日時を変更しました。' : '',
      `変更前: ${when(old, tz)}`,
      summary(ctx, tz, forGuest),
      forGuest ? manageLine(ctx) : '',
      forGuest ? `カレンダーに追加（ICS ファイル）:\n${ctx.icsUrl}` : '',
      footer(ctx),
    ]),
  };
}

export function reminderMail(ctx: MessageContext) {
  const b = ctx.booking;
  return {
    subject: `【リマインド】${ctx.calendarName} ${formatRangeJa(b.start_at, b.end_at, b.guest_timezone)}`,
    body: join([
      `${b.guest_name} 様`,
      'ご予約の日程が近づいてまいりましたので、お知らせいたします。',
      summary(ctx, b.guest_timezone, true),
      ctx.settings.reminder.message,
      answersBlock(b),
      manageLine(ctx),
      footer(ctx),
    ]),
  };
}

export function noSlotMail(appName: string, calendarName: string, input: { name: string; email: string; message: string }) {
  return {
    subject: `【都合の良い日程がありません】${input.name}様（${calendarName}）`,
    body: join([
      `${input.name}様（${input.email}）から、「${calendarName}」に都合の良い日程がないとの連絡がありました。`,
      `■ メッセージ\n${input.message || '（なし）'}`,
      '受付時間を広げるか、応募者に直接ご連絡ください。',
      `--\nこのメールは ${appName} から自動送信されています。`,
    ]),
  };
}
