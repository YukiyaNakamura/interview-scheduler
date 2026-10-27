/**
 * 通知（メール・Webhook・Slack）。
 * メールは EMAIL_PROVIDER で送り方を切り替える: 'log' は送らずに email_outbox に残すだけ（開発用）、'resend' は Resend API で送る。
 * どちらの場合も email_outbox に記録する（送信ログ画面で確認できる）
 */
import type { Bindings } from '../env';
import { newId, nowIso } from '../lib/util';

export interface Mail {
  kind: 'guest_confirmed' | 'host_confirmed' | 'cancelled' | 'rescheduled' | 'reminder' | 'no_slot';
  to: string;
  subject: string;
  body: string;
  bookingId?: string | null;
  replyTo?: string;
}

async function sendViaResend(env: Bindings, mail: Mail): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('RESEND_API_KEY と EMAIL_FROM を設定してください');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.body, ...(mail.replyTo ? { reply_to: mail.replyTo } : {}) }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** 1通送る。失敗しても例外にせず、送信ログに failed として残す（1通の失敗で予約の処理を止めない） */
export async function sendMail(env: Bindings, mail: Mail): Promise<void> {
  let status: 'logged' | 'sent' | 'failed' = 'logged';
  let error: string | null = null;
  if (env.EMAIL_PROVIDER === 'resend') {
    try {
      await sendViaResend(env, mail);
      status = 'sent';
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      console.log(`[mail] ${mail.to} への送信に失敗: ${error}`);
    }
  }
  await env.DB.prepare('INSERT INTO email_outbox (id, kind, to_addr, subject, body, booking_id, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), mail.kind, mail.to, mail.subject, mail.body, mail.bookingId ?? null, status, error, nowIso())
    .run();
}

export async function sendMails(env: Bindings, mails: Mail[]): Promise<void> {
  // 同じ宛先に同じ件名を2通送らない（担当者と通知先が重なったときなど）
  const seen = new Set<string>();
  for (const m of mails) {
    const key = `${m.to.toLowerCase()}|${m.subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await sendMail(env, m);
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
    if (!res.ok) console.log(`[webhook] ${url} が ${res.status} を返しました`);
  } catch (err) {
    console.log(`[webhook] ${url} への送信に失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Slack の Incoming Webhook にテキストを送る */
export async function postSlack(url: string, text: string): Promise<void> {
  if (!url) return;
  await postWebhook(url, { text });
}
