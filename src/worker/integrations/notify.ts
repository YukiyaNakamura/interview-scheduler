/**
 * 通知（メール・Webhook・Slack）。
 * メールは EMAIL_PROVIDER で送り方を切り替える: 'log' は送らずに email_outbox に残すだけ（開発用）、'resend' は Resend API で送る。
 * 'resend' では email_outbox が送信待ちを兼ねる: 送る前に 'pending' で入れ、送れなければ定時実行（retryMails）が間隔を空けて送り直す。
 * 同じメールを2通送らないよう、Resend には送信ログの id を Idempotency-Key として渡す
 */
import { claimOutbox, insertOutbox, listDueOutbox, recordOutboxAttempt } from '../db/bookings';
import type { Bindings } from '../env';
import { newId, nowIso } from '../lib/util';

export interface Mail {
  kind:
    | 'guest_confirmed'
    | 'host_confirmed'
    | 'cancelled'
    | 'rescheduled'
    | 'reminder'
    | 'no_slot'
    | 'guest_links' // 応募者への予定確認 URL の再送
    | 'signup_verify' // 新規登録のメール確認
    | 'signup_exists' // 登録済みのメールアドレスで新規登録されたときの知らせ
    | 'signup_request' // 管理者への承認依頼
    | 'signup_approved' // 承認の知らせ
    | 'password_reset'; // パスワード再設定のリンク
  to: string;
  subject: string;
  body: string;
  bookingId?: string | null;
  replyTo?: string;
}

async function sendViaResend(env: Bindings, mail: Mail, idempotencyKey: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('RESEND_API_KEY と EMAIL_FROM を設定してください');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.body, ...(mail.replyTo ? { reply_to: mail.replyTo } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** 送り直すのは最初の1回を含めて5回まで */
export const MAX_MAIL_ATTEMPTS = 5;
/** 最初の1回の結果が残らなかったとき（処理が途中で止まったなど）に、定時実行が拾うまでの時間 */
const FIRST_RETRY_MS = 5 * 60_000;

/** n 回目に失敗したあと、次に送るまでの時間（5分・15分・1時間・3時間） */
export function retryDelayMs(attempts: number): number {
  return [5, 15, 60, 180][Math.min(attempts, 4) - 1]! * 60_000;
}

/** 送信待ちに入れたメール（deliverMails に渡す） */
export interface QueuedMail {
  id: string;
  mail: Mail;
  attempts: number;
}

/**
 * メールを送信ログに入れる（まだ送らない）。'resend' では 'pending'、'log' では 'logged'（これで終わり）。
 * 同じ宛先に同じ件名を2通入れない（担当者と通知先が重なったときなど）
 */
export async function queueMails(env: Bindings, mails: Mail[]): Promise<QueuedMail[]> {
  const seen = new Set<string>();
  const queued: QueuedMail[] = [];
  const now = Date.now();
  for (const mail of mails) {
    const key = `${mail.to.toLowerCase()}|${mail.subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = newId();
    const pending = env.EMAIL_PROVIDER === 'resend';
    await insertOutbox(env.DB, {
      id,
      kind: mail.kind,
      to: mail.to,
      subject: mail.subject,
      body: mail.body,
      replyTo: mail.replyTo ?? null,
      bookingId: mail.bookingId ?? null,
      status: pending ? 'pending' : 'logged',
      nextAttemptAt: pending ? new Date(now + FIRST_RETRY_MS).toISOString() : null,
      createdAt: new Date(now).toISOString(),
    });
    if (pending) queued.push({ id, mail, attempts: 0 });
  }
  return queued;
}

/** 1回送ってみて結果を残す。失敗しても例外にしない（1通の失敗で予約の処理を止めない） */
async function attempt(env: Bindings, q: QueuedMail): Promise<void> {
  const attempts = q.attempts + 1;
  try {
    await sendViaResend(env, q.mail, q.id);
    await recordOutboxAttempt(env.DB, q.id, { status: 'sent', attempts, error: null, nextAttemptAt: null });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const giveUp = attempts >= MAX_MAIL_ATTEMPTS;
    console.log(`[mail] ${q.mail.kind} の送信に失敗（${attempts}回目${giveUp ? '。送り直しをやめます' : ''}）: ${error}`);
    await recordOutboxAttempt(env.DB, q.id, {
      status: giveUp ? 'failed' : 'pending',
      attempts,
      error,
      nextAttemptAt: giveUp ? null : new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
    });
  }
}

/** queueMails で入れたメールを送る（レスポンスを返した後の waitUntil の中で呼ぶ） */
export async function deliverMails(env: Bindings, queued: QueuedMail[]): Promise<void> {
  for (const q of queued) await attempt(env, q);
}

/** 1通送る（送信ログに入れてから送る） */
export async function sendMail(env: Bindings, mail: Mail): Promise<void> {
  await deliverMails(env, await queueMails(env, [mail]));
}

export async function sendMails(env: Bindings, mails: Mail[]): Promise<void> {
  await deliverMails(env, await queueMails(env, mails));
}

/** 送り直す時刻を過ぎた送信待ちを送る（定時実行）。送ったら件数を返す */
export async function retryMails(env: Bindings, now = new Date()): Promise<number> {
  if (env.EMAIL_PROVIDER !== 'resend') return 0;
  let n = 0;
  for (const r of await listDueOutbox(env.DB, now.toISOString())) {
    // 定時実行が重なっても同じメールを同時に送らないよう、先に次の時刻を進めて取る
    if (!(await claimOutbox(env.DB, r.id, r.nextAttemptAt, new Date(now.getTime() + FIRST_RETRY_MS).toISOString()))) continue;
    const mail: Mail = { kind: r.kind as Mail['kind'], to: r.to, subject: r.subject, body: r.body, bookingId: r.bookingId, ...(r.replyTo ? { replyTo: r.replyTo } : {}) };
    await attempt(env, { id: r.id, mail, attempts: r.attempts });
    n++;
  }
  return n;
}

/** ログに出す URL はホスト名だけにする（Slack の Webhook URL などは URL そのものが秘密） */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(URL が正しくありません)';
  }
}

/** Webhook に JSON を POST する。10 秒で打ち切る。失敗はログだけ */
export async function postWebhook(url: string, payload: unknown): Promise<void> {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Aiteru-Webhook/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.log(`[webhook] ${hostOf(url)} が ${res.status} を返しました`);
  } catch (err) {
    console.log(`[webhook] ${hostOf(url)} への送信に失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Slack の Incoming Webhook にテキストを送る */
export async function postSlack(url: string, text: string): Promise<void> {
  if (!url) return;
  await postWebhook(url, { text });
}
