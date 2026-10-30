/**
 * 管理画面のログイン（/api/auth/*。docs/01「ログイン」）。
 * パスワード → 2段階認証（未登録なら登録）→ 仮パスワードなら変更 の順に進み、段階が進むたびにセッションの値を作り直す。
 * 総当たり対策: パスワードやコードを確かめる「前に」1回分を数え（reserveAttempt）、成功したら戻す。
 * 同時に大量に送られても上限を超えては試せない。上限は LIMITS
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AdminUserInfo, AuthState, MfaEnrollInfo } from '../../shared/api';
import { passwordProblem } from '../../shared/password';
import {
  type AdminUserRow,
  type AttemptLimit,
  claimTotpStep,
  clearFailures,
  consumePasswordStageSession,
  countAdmins,
  createSession,
  deleteSession,
  deleteSessionsForUser,
  getAdmin,
  getAdminByEmail,
  insertAdmin,
  logAuthEvent,
  recordLogin,
  releaseAttempt,
  reserveAttempt,
  setPassword,
  setPendingTotp,
  setTotpSecret,
} from '../db/auth';
import type { AppEnv } from '../env';
import { decrypt, encrypt } from '../lib/crypto';
import { burnPasswordCheck, hashPassword, timingSafeEqual, verifyPassword } from '../lib/password';
import { clearSessionCookie, clientInfo, currentSession, type CurrentSession, SESSION_TTL, setSessionCookie } from '../lib/session';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp';
import { HttpError } from '../lib/util';

export const auth = new Hono<AppEnv>();

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/**
 * 試行回数の上限。
 * - パスワードはメールアドレスごと（15分に5回）と IP ごと（15分に20回）
 * - 2段階認証は管理者ごと（24時間に10回、超えたら24時間ロック）。パスワードとは別に数えるので、
 *   パスワードを当てずっぽうで試す人がいても、パスワードを通った本人のコード入力は止まらない
 */
export const LIMITS = {
  email: (email: string): AttemptLimit => ({ key: `email:${email.toLowerCase()}`, max: 5, windowMs: 15 * MIN, lockMs: 15 * MIN }),
  ip: (ip: string): AttemptLimit => ({ key: `ip:${ip}`, max: 20, windowMs: 15 * MIN, lockMs: 15 * MIN }),
  mfa: (userId: string): AttemptLimit => ({ key: `mfa:${userId}`, max: 10, windowMs: DAY, lockMs: DAY }),
  passwordChange: (userId: string): AttemptLimit => ({ key: `pw:${userId}`, max: 5, windowMs: 15 * MIN, lockMs: 15 * MIN }),
};

const emailSchema = z.email('メールアドレスが正しくありません').max(254).transform((v) => v.toLowerCase());
const passwordInput = z.string().min(1, 'パスワードを入力してください').max(200);
const codeSchema = z.object({ code: z.string().max(20) });

const userInfo = (u: AdminUserRow): AdminUserInfo => ({ id: u.id, name: u.name, email: u.email });

async function stateFor(c: Context<AppEnv>, s: CurrentSession | null): Promise<AuthState> {
  if ((await countAdmins(c.env.DB)) === 0) return { step: 'setup' };
  if (!s) return { step: 'login' };
  if (s.session.stage === 'password') return s.user.totp_secret_enc ? { step: 'mfa_verify', email: s.user.email } : { step: 'mfa_enroll', email: s.user.email };
  if (s.user.must_change_password === 1) return { step: 'change_password', user: userInfo(s.user) };
  return { step: 'done', user: userInfo(s.user) };
}

/** 新しいセッションに入れ替える。前の値（oldHash）は消し、盗まれていても使えなくする（セッション固定攻撃の対策） */
async function startSession(c: Context<AppEnv>, userId: string, stage: 'password' | 'full', oldHash?: string): Promise<void> {
  if (oldHash) await deleteSession(c.env.DB, oldHash);
  const ttl = stage === 'password' ? SESSION_TTL.passwordStageMs : SESSION_TTL.absoluteMs;
  const { token } = await createSession(c.env.DB, userId, stage, ttl, clientInfo(c));
  setSessionCookie(c, token, ttl);
}

function lockedError(until: string | null): HttpError {
  const minutes = until ? Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / MIN)) : 15;
  const wait = minutes >= 120 ? `${Math.ceil(minutes / 60)} 時間` : `${minutes} 分`;
  return new HttpError(429, `失敗が続いたため、一時的にロックしています。${wait}ほど待ってからお試しください（急ぐときは、ほかの管理者にリセットを頼んでください）`);
}

/**
 * 確かめる前に、limits のすべてで1回分を予約する。どれかが上限なら、予約した分を戻して 429。
 * 戻り値の release() は「成功したので数えない」ときに呼ぶ。失敗のときは呼ばない（そのまま1回として残る）
 */
async function reserve(c: Context<AppEnv>, limits: AttemptLimit[], who: { userId?: string | null; email?: string | null }): Promise<{ release: () => Promise<void> }> {
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
    if (r.justLocked) await logAuthEvent(c.env.DB, { kind: 'login_locked', userId: who.userId, email: who.email, ...clientInfo(c) });
    throw lockedError(r.lockedUntil);
  }
  return { release };
}

function assertPasswordOk(password: string, email: string): void {
  const problem = passwordProblem(password, email);
  if (problem) throw new HttpError(400, problem, [{ path: 'password', message: problem }]);
}

// ---- 今の段階 ----

auth.get('/session', async (c) => c.json<AuthState>(await stateFor(c, await currentSession(c))));

// ---- 初期設定（最初の管理者を作る） ----

auth.post('/setup', async (c) => {
  const input = z
    .object({ setupToken: z.string().max(200), name: z.string().trim().min(1, '名前を入力してください').max(100), email: emailSchema, password: z.string().max(200) })
    .parse(await c.req.json());
  if ((await countAdmins(c.env.DB)) > 0) throw new HttpError(409, '初期設定は済んでいます。ログインしてください');
  const expected = c.env.ADMIN_SETUP_TOKEN;
  if (!expected) throw new HttpError(400, '初期設定用の合言葉（ADMIN_SETUP_TOKEN）がサーバーに設定されていません。README の「最初の管理者を作る」を見てください');
  const { ip, userAgent } = clientInfo(c);
  const attempt = await reserve(c, [LIMITS.ip(ip)], { email: input.email });
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  if (!timingSafeEqual(await digest(input.setupToken), await digest(expected))) {
    throw new HttpError(401, '初期設定用の合言葉が違います', [{ path: 'setupToken', message: '初期設定用の合言葉が違います' }]);
  }
  await attempt.release();
  assertPasswordOk(input.password, input.email);
  const id = await insertAdmin(c.env.DB, { name: input.name, email: input.email, passwordHash: await hashPassword(input.password), mustChangePassword: false }, true);
  if (!id) throw new HttpError(409, '初期設定は済んでいます。ログインしてください');
  await logAuthEvent(c.env.DB, { kind: 'setup', userId: id, email: input.email, ip, userAgent });
  // 続けて2段階認証を登録させる
  await startSession(c, id, 'password');
  const user = (await getAdmin(c.env.DB, id))!;
  return c.json<AuthState>({ step: 'mfa_enroll', email: user.email });
});

// ---- パスワード ----

auth.post('/login', async (c) => {
  const input = z.object({ email: emailSchema, password: passwordInput }).parse(await c.req.json());
  const { ip } = clientInfo(c);
  const user = await getAdminByEmail(c.env.DB, input.email);
  const attempt = await reserve(c, [LIMITS.ip(ip), LIMITS.email(input.email)], { userId: user?.id, email: input.email });
  const ok = user ? await verifyPassword(input.password, user.password_hash) : await burnPasswordCheck(input.password);
  if (!user || !ok) {
    await logAuthEvent(c.env.DB, { kind: 'login_failed', userId: user?.id, email: input.email, ...clientInfo(c) });
    // メールアドレスが無いのかパスワードが違うのかは言わない（登録されているメールアドレスを探られないように）
    throw new HttpError(401, 'メールアドレスまたはパスワードが違います');
  }
  // パスワードは合っていたので数えない（2段階認証の回数は別に数える）
  await attempt.release();
  await startSession(c, user.id, 'password', (await currentSession(c))?.session.id_hash);
  return c.json<AuthState>(user.totp_secret_enc ? { step: 'mfa_verify', email: user.email } : { step: 'mfa_enroll', email: user.email });
});

// ---- 2段階認証 ----

/** パスワードだけ通った段階のセッション */
async function passwordStage(c: Context<AppEnv>): Promise<CurrentSession> {
  const s = await currentSession(c);
  if (!s || s.session.stage !== 'password') throw new HttpError(401, '時間が経ったため、最初からログインし直してください');
  return s;
}

/** コードを確かめる前に、管理者ごと・IP ごとに1回分を予約する */
const reserveMfa = (c: Context<AppEnv>, s: CurrentSession) => reserve(c, [LIMITS.ip(clientInfo(c).ip), LIMITS.mfa(s.user.id)], { userId: s.user.id, email: s.user.email });

async function mfaFailed(c: Context<AppEnv>, s: CurrentSession): Promise<never> {
  await logAuthEvent(c.env.DB, { kind: 'mfa_failed', userId: s.user.id, email: s.user.email, ...clientInfo(c) });
  throw new HttpError(400, 'コードが違います。認証アプリに出ている最新の6桁を入れてください', [{ path: 'code', message: 'コードが違います' }]);
}

/**
 * 2段階認証まで通った。回数を戻し、パスワード段階のセッションを使い切ってから full のセッションを作る。
 * 同じセッションで同時に送られた別のリクエストは、使い切れずに 401 になる
 */
async function finishLogin(c: Context<AppEnv>, s: CurrentSession): Promise<AuthState> {
  const { ip, userAgent } = clientInfo(c);
  await clearFailures(c.env.DB, LIMITS.mfa(s.user.id).key);
  await releaseAttempt(c.env.DB, LIMITS.ip(ip).key);
  if (!(await consumePasswordStageSession(c.env.DB, s.session.id_hash))) throw new HttpError(401, '最初からログインし直してください');
  await recordLogin(c.env.DB, s.user.id, ip);
  await logAuthEvent(c.env.DB, { kind: 'login_success', userId: s.user.id, email: s.user.email, ip, userAgent });
  await startSession(c, s.user.id, 'full');
  return s.user.must_change_password === 1 ? { step: 'change_password', user: userInfo(s.user) } : { step: 'done', user: userInfo(s.user) };
}

/** 認証アプリに登録する秘密鍵。再読み込みしても同じものを返す（読み取った QR コードが無駄にならないように） */
auth.get('/mfa/enroll', async (c) => {
  const s = await passwordStage(c);
  if (s.user.totp_secret_enc) throw new HttpError(400, '2段階認証はすでに登録されています');
  let secret: string;
  if (s.session.pending_totp_enc) {
    secret = await decrypt(s.session.pending_totp_enc, c.env.TOKEN_ENC_KEY);
  } else {
    secret = newTotpSecret();
    await setPendingTotp(c.env.DB, s.session.id_hash, await encrypt(secret, c.env.TOKEN_ENC_KEY));
  }
  return c.json<MfaEnrollInfo>({ secret, otpauthUrl: otpauthUrl(c.env.APP_NAME, s.user.email, secret) });
});

/** 登録: 認証アプリに出た最初のコードを確かめてから保存する（読み取りに失敗したまま保存しないように） */
auth.post('/mfa/enroll', async (c) => {
  const { code } = codeSchema.parse(await c.req.json());
  const s = await passwordStage(c);
  if (s.user.totp_secret_enc) throw new HttpError(400, '2段階認証はすでに登録されています');
  if (!s.session.pending_totp_enc) throw new HttpError(400, 'QR コードを表示し直してください');
  await reserveMfa(c, s);
  const step = await verifyTotp(await decrypt(s.session.pending_totp_enc, c.env.TOKEN_ENC_KEY), code, Date.now(), null);
  if (step === null) return mfaFailed(c, s);
  await setTotpSecret(c.env.DB, s.user.id, s.session.pending_totp_enc, step);
  await logAuthEvent(c.env.DB, { kind: 'mfa_enrolled', userId: s.user.id, email: s.user.email, ...clientInfo(c) });
  return c.json<AuthState>(await finishLogin(c, s));
});

auth.post('/mfa/verify', async (c) => {
  const { code } = codeSchema.parse(await c.req.json());
  const s = await passwordStage(c);
  if (!s.user.totp_secret_enc) throw new HttpError(400, '2段階認証が登録されていません。最初からログインし直してください');
  await reserveMfa(c, s);
  const step = await verifyTotp(await decrypt(s.user.totp_secret_enc, c.env.TOKEN_ENC_KEY), code, Date.now(), s.user.totp_last_step);
  // 同じコードが同時に2回送られても、ステップを先に記録できた1回だけを通す
  if (step === null || !(await claimTotpStep(c.env.DB, s.user.id, step))) return mfaFailed(c, s);
  return c.json<AuthState>(await finishLogin(c, s));
});

// ---- パスワードの変更（仮パスワードからの変更もここ） ----

auth.post('/password', async (c) => {
  const input = z.object({ currentPassword: passwordInput, newPassword: z.string().max(200) }).parse(await c.req.json());
  const s = await currentSession(c);
  if (!s || s.session.stage !== 'full') throw new HttpError(401, 'ログインしてください');
  const attempt = await reserve(c, [LIMITS.ip(clientInfo(c).ip), LIMITS.passwordChange(s.user.id)], { userId: s.user.id, email: s.user.email });
  if (!(await verifyPassword(input.currentPassword, s.user.password_hash))) {
    throw new HttpError(400, '今のパスワードが違います', [{ path: 'currentPassword', message: '今のパスワードが違います' }]);
  }
  await attempt.release();
  assertPasswordOk(input.newPassword, s.user.email);
  if (input.newPassword === input.currentPassword) throw new HttpError(400, '今と同じパスワードは使えません', [{ path: 'password', message: '今と同じパスワードは使えません' }]);
  await setPassword(c.env.DB, s.user.id, await hashPassword(input.newPassword), false);
  // ほかの端末のセッションもすべて切る（パスワードが漏れて変えた場合に、ログイン中の第三者を追い出す）
  await deleteSessionsForUser(c.env.DB, s.user.id);
  await logAuthEvent(c.env.DB, { kind: 'password_changed', userId: s.user.id, email: s.user.email, ...clientInfo(c) });
  await startSession(c, s.user.id, 'full');
  return c.json<AuthState>({ step: 'done', user: userInfo(s.user) });
});

// ---- ログアウト ----

auth.post('/logout', async (c) => {
  const s = await currentSession(c);
  if (s) {
    await deleteSession(c.env.DB, s.session.id_hash);
    await logAuthEvent(c.env.DB, { kind: 'logout', userId: s.user.id, email: s.user.email, ...clientInfo(c) });
  }
  clearSessionCookie(c);
  return c.json<AuthState>({ step: 'login' });
});
