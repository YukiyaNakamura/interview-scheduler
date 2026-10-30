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

// ---- 応募者への予定確認 URL の再送 ----

export function guestLinksMail(appName: string, bookings: { calendarName: string; booking: Pick<BookingRow, 'start_at' | 'end_at' | 'guest_timezone' | 'guest_name'>; manageUrl: string }[]) {
  return {
    subject: `【${appName}】ご予約中の面接の確認`,
    body: join([
      `${bookings[0]?.booking.guest_name ?? ''} 様`,
      'ご予約中の面接は次のとおりです。それぞれの URL から、予定の確認・キャンセル・日程変更ができます。',
      ...bookings.map((x) => `■ ${x.calendarName}\n日時: ${when(x.booking, x.booking.guest_timezone)}\n${x.manageUrl}`),
      'このメールに心当たりがない場合は、破棄してください。',
      `--\nこのメールは ${appName} から自動送信されています。`,
    ]),
  };
}

// ---- 管理者の新規登録・パスワード再設定 ----

const adminFooter = (appName: string) => `--\nこのメールは ${appName}（面接の日程調整）の管理画面から自動送信されています。`;

export function signupVerifyMail(appName: string, name: string, verifyUrl: string) {
  return {
    subject: `【${appName}】メールアドレスの確認`,
    body: join([
      `${name} 様`,
      `${appName} の管理画面への新規登録を受け付けました。次の URL を開き、登録したときのパスワードを入れると、メールアドレスの確認が終わります（24時間有効）。`,
      verifyUrl,
      '確認のあと、管理者が承認すると使えるようになります。',
      '心当たりがない場合は、このメールを無視してください（URL を開かなければ登録は進みません）。',
      adminFooter(appName),
    ]),
  };
}

export function signupExistsMail(appName: string, loginUrl: string, forgotUrl: string) {
  return {
    subject: `【${appName}】新規登録について`,
    body: join([
      `このメールアドレスで ${appName} の管理画面への新規登録がありましたが、すでに登録されています。`,
      `ログイン: ${loginUrl}`,
      `パスワードを忘れた場合: ${forgotUrl}`,
      '心当たりがない場合は、このメールを無視してください。',
      adminFooter(appName),
    ]),
  };
}

export function signupRequestMail(appName: string, applicant: { name: string; email: string }, accountsUrl: string) {
  return {
    subject: `【${appName}】新規登録の承認依頼: ${applicant.name}様`,
    body: join([
      `${applicant.name}様（${applicant.email}）が管理画面に新規登録し、メールアドレスの確認が済みました。`,
      '管理画面では応募者の名前・メールアドレスが見られます。社内の人か確かめてから承認してください。',
      `承認・却下はこちら: ${accountsUrl}`,
      adminFooter(appName),
    ]),
  };
}

export function signupApprovedMail(appName: string, name: string, loginUrl: string) {
  return {
    subject: `【${appName}】管理画面の利用が承認されました`,
    body: join([`${name} 様`, '管理画面の利用が承認されました。初回のログインでは、スマホの認証アプリで2段階認証を登録します。', `ログイン: ${loginUrl}`, adminFooter(appName)]),
  };
}

export function passwordResetMail(appName: string, name: string, resetUrl: string) {
  return {
    subject: `【${appName}】パスワードの再設定`,
    body: join([
      `${name} 様`,
      'パスワードを再設定するには、次の URL を開いて新しいパスワードを入れてください（30分有効・1回だけ使えます）。',
      resetUrl,
      '再設定しても、ログインには今までどおり2段階認証のコードが必要です。',
      '心当たりがない場合は、このメールを無視してください（パスワードは変わりません）。',
      adminFooter(appName),
    ]),
  };
}
