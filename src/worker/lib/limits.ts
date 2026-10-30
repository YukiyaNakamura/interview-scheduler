/**
 * 試行回数・送信回数の上限（総当たり・メールの大量送信の対策。docs/01「ログイン」）。
 * パスワードやコードを確かめる「前に」1回分を数え（reserveAttempt）、成功したら戻す。同時に大量に送られても上限を超えては試せない。
 * メールアドレスはキーにも平文で入れず、目印（lib/pii.ts の emailIndex）を使う
 */
import type { Context } from 'hono';
import { type AttemptLimit, releaseAttempt, reserveAttempt } from '../db/auth';
import type { AppEnv } from '../env';
import { HttpError } from './util';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * 回数を数えるときの IP。IPv6 は /64（先頭の4ブロック）でまとめる。
 * 1つの回線に /64 が丸ごと割り当てられることが多く、アドレスを替えるだけで上限をすり抜けられてしまうため
 */
export function ipBlock(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head = '', tail] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * - パスワードはメールアドレスごと（15分に5回）と IP ごと（15分に20回）
 * - 2段階認証は管理者ごと（24時間に10回、超えたら24時間ロック）。パスワードとは別に数えるので、
 *   パスワードを当てずっぽうで試す人がいても、パスワードを通った本人のコード入力は止まらない
 * - メールを送るもの（新規登録・パスワード再設定・予定確認 URL の再送）は、送り先ごと・IP ごとに1時間の回数を絞る
 * - 応募画面（ログインなし）: 予約の確定は IP ごとに1時間30回（大学や会社の回線で同じ IP の応募者が重なっても止まりにくいように）。「都合の合う日がない」の連絡は面接官全員にメールが届くので
 *   IP ごとに1時間3回・カレンダーごとに1時間20回。閲覧パスワードは IP×カレンダーで15分に20回まで試せる（正しければ数えない）
 */
export const LIMITS = {
  email: (emailHash: string): AttemptLimit => ({ key: `email:${emailHash}`, max: 5, windowMs: 15 * MIN, lockMs: 15 * MIN }),
  ip: (ip: string): AttemptLimit => ({ key: `ip:${ipBlock(ip)}`, max: 20, windowMs: 15 * MIN, lockMs: 15 * MIN }),
  mfa: (userId: string): AttemptLimit => ({ key: `mfa:${userId}`, max: 10, windowMs: DAY, lockMs: DAY }),
  passwordChange: (userId: string): AttemptLimit => ({ key: `pw:${userId}`, max: 5, windowMs: 15 * MIN, lockMs: 15 * MIN }),
  signupIp: (ip: string): AttemptLimit => ({ key: `signup-ip:${ipBlock(ip)}`, max: 5, windowMs: HOUR, lockMs: HOUR }),
  signupEmail: (emailHash: string): AttemptLimit => ({ key: `signup-email:${emailHash}`, max: 3, windowMs: HOUR, lockMs: HOUR }),
  resetIp: (ip: string): AttemptLimit => ({ key: `reset-ip:${ipBlock(ip)}`, max: 5, windowMs: HOUR, lockMs: HOUR }),
  resetEmail: (emailHash: string): AttemptLimit => ({ key: `reset-email:${emailHash}`, max: 3, windowMs: HOUR, lockMs: HOUR }),
  linksIp: (ip: string): AttemptLimit => ({ key: `links-ip:${ipBlock(ip)}`, max: 5, windowMs: HOUR, lockMs: HOUR }),
  linksEmail: (emailHash: string): AttemptLimit => ({ key: `links-email:${emailHash}`, max: 3, windowMs: HOUR, lockMs: HOUR }),
  bookingIp: (ip: string): AttemptLimit => ({ key: `booking-ip:${ipBlock(ip)}`, max: 30, windowMs: HOUR, lockMs: HOUR }),
  noSlotIp: (ip: string): AttemptLimit => ({ key: `noslot-ip:${ipBlock(ip)}`, max: 3, windowMs: HOUR, lockMs: HOUR }),
  noSlotCalendar: (calendarId: string): AttemptLimit => ({ key: `noslot-cal:${calendarId}`, max: 20, windowMs: HOUR, lockMs: HOUR }),
  calendarPassword: (ip: string, calendarId: string): AttemptLimit => ({ key: `calpw:${ipBlock(ip)}:${calendarId}`, max: 20, windowMs: 15 * MIN, lockMs: 15 * MIN }),
};

/** guest は応募画面の API（/api/public）。管理者向けの案内（ほかの管理者にリセットを頼む）は出さない */
function tooManyError(until: string | null, guest: boolean): HttpError {
  const minutes = until ? Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / MIN)) : 15;
  const wait = minutes >= 120 ? `${Math.ceil(minutes / 60)} 時間` : `${minutes} 分`;
  return new HttpError(429, `回数が多すぎるため、一時的に止めています。${wait}ほど待ってからお試しください${guest ? '' : '（管理者の方は、ほかの管理者にリセットを頼むこともできます）'}`);
}

/**
 * 確かめる前に、limits のすべてで1回分を予約する。どれかが上限なら、予約した分を戻して 429。
 * 戻り値の release() は「成功したので数えない」ときに呼ぶ。失敗のときは呼ばない（そのまま1回として残る）。
 * onLocked は、この呼び出しで新しくロックがかかったときに呼ばれる（記録を残すため）
 */
export async function reserveAll(c: Context<AppEnv>, limits: AttemptLimit[], onLocked?: () => Promise<void>): Promise<{ release: () => Promise<void> }> {
  const reserved: string[] = [];
  const release = async () => {
    for (const key of reserved) await releaseAttempt(c.env.DB, key);
  };
  for (const limit of limits) {
    const r = await reserveAttempt(c.env.DB, limit);
    if (r.allowed) {
      reserved.push(limit.key);
      continue;
    }
    await release();
    if (r.justLocked && onLocked) await onLocked();
    throw tooManyError(r.lockedUntil, c.req.path.startsWith('/api/public/'));
  }
  return { release };
}
