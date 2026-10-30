/**
 * 管理画面のログイン（/api/auth/*。docs/01「ログイン」）。
 * - ログイン: パスワード → 2段階認証（未登録なら登録）→ 仮パスワードなら変更。段階が進むたびにセッションの値を作り直す
 * - 新規登録: 登録 → メールのリンクを開いてパスワードを入れる（メールアドレスの確認）→ 既存の管理者が承認 → ログインできる
 * - パスワードを忘れた: メールのリンクから再設定（30分・1回だけ）。2段階認証はそのまま必要
 * 回数の上限は lib/limits.ts。メールアドレスの有無は応答から分からないようにする
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AdminUserInfo, AuthState, MessageResponse, MfaEnrollInfo } from '../../shared/api';
import { passwordProblem } from '../../shared/password';
import {
  type AdminUserRow,
  changeStatus,
  claimTotpStep,
  clearFailures,
  consumeAuthToken,
  consumePasswordStageSession,
  countActiveAdmins,
  createAuthToken,
  createSession,
  deleteSession,
  deleteSessionsForUser,
  getAdmin,
  getAdminByEmail,
  insertAdmin,
  listActiveAdmins,
  logAuthEvent,
  peekAuthToken,
  recordLogin,
  releaseAttempt,
  setPassword,
  setPendingTotp,
  setTotpSecret,
  updatePendingSignup,
} from '../db/auth';
import type { AppEnv } from '../env';
import { sendMail, sendMails } from '../integrations/notify';
import { decrypt, encrypt } from '../lib/crypto';
import { LIMITS, reserveAll } from '../lib/limits';
import { burnPasswordCheck, hashPassword, timingSafeEqual, verifyPassword } from '../lib/password';
import { emailIndex } from '../lib/pii';
import { clearSessionCookie, clientInfo, currentSession, type CurrentSession, SESSION_TTL, setSessionCookie } from '../lib/session';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp';
import { appUrl, HttpError } from '../lib/util';
import { passwordResetMail, signupExistsMail, signupRequestMail, signupVerifyMail } from '../services/messages';

export const auth = new Hono<AppEnv>();

const VERIFY_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 30 * 60_000;

const emailSchema = z.email('メールアドレスが正しくありません').max(254).transform((v) => v.trim().toLowerCase());
const passwordInput = z.string().min(1, 'パスワードを入力してください').max(200);
const codeSchema = z.object({ code: z.string().max(20) });
const tokenSchema = z.string().min(1).max(100);

const userInfo = (u: AdminUserRow): AdminUserInfo => ({ id: u.id, name: u.name, email: u.email });

async function stateFor(c: Context<AppEnv>, s: CurrentSession | null): Promise<AuthState> {
  if ((await countActiveAdmins(c.env.DB)) === 0) return { step: 'setup' };
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

/** 上限に達して新しくロックしたことを記録する */
const logLocked = (c: Context<AppEnv>, who: { userId?: string | null; email?: string | null }) => () =>
  logAuthEvent(c.env.DB, { kind: 'login_locked', userId: who.userId, email: who.email, ...clientInfo(c) });

function assertPasswordOk(password: string, email: string): void {
  const problem = passwordProblem(password, email);
  if (problem) throw new HttpError(400, problem, [{ path: 'password', message: problem }]);
}

/** メールは応答を返したあとに送る（送る・送らないで応答時間が変わり、登録の有無が分からないように） */
const later = (c: Context<AppEnv>, task: Promise<unknown>) => c.executionCtx.waitUntil(task);

// ---- 今の段階 ----

auth.get('/session', async (c) => c.json<AuthState>(await stateFor(c, await currentSession(c))));

// ---- 初期設定（最初の管理者を作る） ----

auth.post('/setup', async (c) => {
  const input = z
    .object({ setupToken: z.string().max(200), name: z.string().trim().min(1, '名前を入力してください').max(100), email: emailSchema, password: z.string().max(200) })
    .parse(await c.req.json());
  if ((await countActiveAdmins(c.env.DB)) > 0) throw new HttpError(409, '初期設定は済んでいます。ログインしてください');
  const expected = c.env.ADMIN_SETUP_TOKEN;
  if (!expected) throw new HttpError(400, '初期設定用の合言葉（ADMIN_SETUP_TOKEN）がサーバーに設定されていません。README の「最初の管理者を作る」を見てください');
  const { ip, userAgent } = clientInfo(c);
  const attempt = await reserveAll(c, [LIMITS.ip(ip)]);
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
  return c.json<AuthState>({ step: 'mfa_enroll', email: input.email });
});

// ---- パスワード ----

auth.post('/login', async (c) => {
  const input = z.object({ email: emailSchema, password: passwordInput }).parse(await c.req.json());
  const { ip } = clientInfo(c);
  const user = await getAdminByEmail(c.env.DB, input.email);
  const attempt = await reserveAll(c, [LIMITS.ip(ip), LIMITS.email(await emailIndex(input.email))], logLocked(c, { userId: user?.id, email: input.email }));
  const ok = user ? await verifyPassword(input.password, user.password_hash) : await burnPasswordCheck(input.password);
  if (!user || !ok) {
    await logAuthEvent(c.env.DB, { kind: 'login_failed', userId: user?.id, email: input.email, ...clientInfo(c) });
    // メールアドレスが無いのかパスワードが違うのかは言わない（登録されているメールアドレスを探られないように）
    throw new HttpError(401, 'メールアドレスまたはパスワードが違います');
  }
  // パスワードは合っていたので数えない（2段階認証の回数は別に数える）
  await attempt.release();
  // 新規登録の途中の人。パスワードを知っている本人にだけ、今どこで止まっているかを伝える
  if (user.status === 'pending_email') {
    const token = await createAuthToken(c.env.DB, user.id, 'verify_email', VERIFY_TTL_MS);
    later(c, sendMail(c.env, { kind: 'signup_verify', to: user.email, ...signupVerifyMail(c.env.APP_NAME, user.name, `${appUrl(c.env, c)}/login/verify?token=${token}`) }));
    throw new HttpError(403, 'メールアドレスの確認が済んでいません。確認メールをもう一度送ったので、メールのリンクを開いてください');
  }
  if (user.status === 'pending_approval') throw new HttpError(403, '管理者の承認待ちです。承認されるとメールでお知らせします');
  await startSession(c, user.id, 'password', (await currentSession(c))?.session.id_hash);
  return c.json<AuthState>(user.totp_secret_enc ? { step: 'mfa_verify', email: user.email } : { step: 'mfa_enroll', email: user.email });
});

// ---- 2段階認証 ----

/** パスワードだけ通った段階のセッション */
async function passwordStage(c: Context<AppEnv>): Promise<CurrentSession> {
  const s = await currentSession(c);
  if (!s || s.session.stage !== 'password' || s.user.status !== 'active') throw new HttpError(401, '時間が経ったため、最初からログインし直してください');
  return s;
}

/** コードを確かめる前に、管理者ごと・IP ごとに1回分を予約する */
const reserveMfa = (c: Context<AppEnv>, s: CurrentSession) =>
  reserveAll(c, [LIMITS.ip(clientInfo(c).ip), LIMITS.mfa(s.user.id)], logLocked(c, { userId: s.user.id, email: s.user.email }));

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

// ---- パスワードの変更（ログイン中。仮パスワードからの変更もここ） ----

auth.post('/password', async (c) => {
  const input = z.object({ currentPassword: passwordInput, newPassword: z.string().max(200) }).parse(await c.req.json());
  const s = await currentSession(c);
  if (!s || s.session.stage !== 'full' || s.user.status !== 'active') throw new HttpError(401, 'ログインしてください');
  const attempt = await reserveAll(c, [LIMITS.ip(clientInfo(c).ip), LIMITS.passwordChange(s.user.id)], logLocked(c, { userId: s.user.id, email: s.user.email }));
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

// ---- 新規登録 ----

auth.post('/signup', async (c) => {
  const input = z
    .object({ name: z.string().trim().min(1, '名前を入力してください').max(100), email: emailSchema, password: z.string().max(200) })
    .parse(await c.req.json());
  if ((await countActiveAdmins(c.env.DB)) === 0) throw new HttpError(400, 'まだ初期設定が済んでいません。最初の管理者は初期設定で作ってください');
  assertPasswordOk(input.password, input.email);
  const { ip, userAgent } = clientInfo(c);
  // 登録はメールを送るので、成功しても数える（他人のメールアドレスに確認メールを大量に送らせないように）
  await reserveAll(c, [LIMITS.signupIp(ip), LIMITS.signupEmail(await emailIndex(input.email))]);
  const base = appUrl(c.env, c);
  const name = c.env.APP_NAME;
  const passwordHash = await hashPassword(input.password);
  const existing = await getAdminByEmail(c.env.DB, input.email);
  let userId: string | null = existing?.id ?? null;
  if (existing && existing.status !== 'pending_email') {
    // すでに登録済み。応答は同じにして、本人のメールにだけ知らせる
    later(c, sendMail(c.env, { kind: 'signup_exists', to: input.email, ...signupExistsMail(name, `${base}/login`, `${base}/login?mode=forgot`) }));
  } else {
    if (existing) await updatePendingSignup(c.env.DB, existing.id, input.name, passwordHash);
    else userId = await insertAdmin(c.env.DB, { name: input.name, email: input.email, passwordHash, mustChangePassword: false, status: 'pending_email' }).catch(() => null); // 同時に同じメールで登録されたら後の方は何もしない
    if (userId) {
      const token = await createAuthToken(c.env.DB, userId, 'verify_email', VERIFY_TTL_MS);
      later(c, sendMail(c.env, { kind: 'signup_verify', to: input.email, ...signupVerifyMail(name, input.name, `${base}/login/verify?token=${token}`) }));
    }
  }
  await logAuthEvent(c.env.DB, { kind: 'signup_requested', userId, email: input.email, ip, userAgent });
  return c.json<MessageResponse>(
    { message: `${input.email} に確認メールを送りました。メールの URL を開き、登録したパスワードを入れてください（24時間有効）。そのあと管理者が承認すると使えるようになります。` },
    202,
  );
});

/**
 * メールアドレスの確認。リンクのトークンに加えて、登録したときのパスワードも確かめる
 * （他人が勝手に登録した確認メールのリンクを、本人がうっかり開いても登録が進まないように）
 */
auth.post('/verify-email', async (c) => {
  const input = z.object({ token: tokenSchema, password: passwordInput }).parse(await c.req.json());
  const attempt = await reserveAll(c, [LIMITS.ip(clientInfo(c).ip)]);
  const expired = new HttpError(400, 'このリンクは期限切れか、使用済みです。もう一度新規登録するか、ログインすると確認メールを送り直します');
  const userId = await peekAuthToken(c.env.DB, input.token, 'verify_email');
  const user = userId ? await getAdmin(c.env.DB, userId) : null;
  if (!user || user.status !== 'pending_email') throw expired;
  if (!(await verifyPassword(input.password, user.password_hash))) throw new HttpError(400, 'パスワードが違います', [{ path: 'password', message: '登録したときのパスワードを入れてください' }]);
  await attempt.release();
  if (!(await consumeAuthToken(c.env.DB, input.token, 'verify_email')) || !(await changeStatus(c.env.DB, user.id, 'pending_email', 'pending_approval'))) throw expired;
  await logAuthEvent(c.env.DB, { kind: 'email_verified', userId: user.id, email: user.email, ...clientInfo(c) });
  // 使える管理者全員に承認を頼む
  const admins = await listActiveAdmins(c.env.DB);
  const mail = signupRequestMail(c.env.APP_NAME, { name: user.name, email: user.email }, `${appUrl(c.env, c)}/admin/accounts`);
  later(c, sendMails(c.env, admins.map((a) => ({ kind: 'signup_request' as const, to: a.email, ...mail }))));
  return c.json<MessageResponse>({ message: 'メールアドレスを確認しました。管理者が承認すると、メールでお知らせします。' });
});

// ---- パスワードを忘れた ----

auth.post('/password-reset/request', async (c) => {
  const { email } = z.object({ email: emailSchema }).parse(await c.req.json());
  const { ip, userAgent } = clientInfo(c);
  await reserveAll(c, [LIMITS.resetIp(ip), LIMITS.resetEmail(await emailIndex(email))]);
  const user = await getAdminByEmail(c.env.DB, email);
  if (user && user.status !== 'pending_email') {
    const token = await createAuthToken(c.env.DB, user.id, 'reset_password', RESET_TTL_MS);
    later(c, sendMail(c.env, { kind: 'password_reset', to: user.email, ...passwordResetMail(c.env.APP_NAME, user.name, `${appUrl(c.env, c)}/login/reset?token=${token}`) }));
    await logAuthEvent(c.env.DB, { kind: 'password_reset_requested', userId: user.id, email, ip, userAgent });
  }
  return c.json<MessageResponse>({ message: 'そのメールアドレスが登録されていれば、パスワードを再設定するためのメールを送りました（30分有効）。届かないときは迷惑メールフォルダも確認してください。' });
});

auth.post('/password-reset/confirm', async (c) => {
  const input = z.object({ token: tokenSchema, newPassword: z.string().max(200) }).parse(await c.req.json());
  const attempt = await reserveAll(c, [LIMITS.ip(clientInfo(c).ip)]);
  const expired = new HttpError(400, 'このリンクは期限切れか、使用済みです。もう一度「パスワードを忘れた」からやり直してください');
  const userId = await peekAuthToken(c.env.DB, input.token, 'reset_password');
  const user = userId ? await getAdmin(c.env.DB, userId) : null;
  if (!user || user.status === 'pending_email') throw expired;
  await attempt.release();
  assertPasswordOk(input.newPassword, user.email);
  if (!(await consumeAuthToken(c.env.DB, input.token, 'reset_password'))) throw expired;
  await setPassword(c.env.DB, user.id, await hashPassword(input.newPassword), false);
  // ログイン中の端末はすべて切り、パスワードのロックも解く（2段階認証のロックはそのまま）
  await deleteSessionsForUser(c.env.DB, user.id);
  await clearFailures(c.env.DB, LIMITS.email(user.email_hash).key);
  await clearFailures(c.env.DB, LIMITS.passwordChange(user.id).key);
  await logAuthEvent(c.env.DB, { kind: 'password_reset_by_email', userId: user.id, email: user.email, ...clientInfo(c) });
  return c.json<MessageResponse>({ message: 'パスワードを変更しました。新しいパスワードでログインしてください（2段階認証のコードも必要です）。' });
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
