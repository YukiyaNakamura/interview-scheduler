/**
 * 管理画面にログインできる人（管理者）の管理と、ログインの記録（/api/admin/accounts・/api/admin/auth-events。docs/01「ログイン」）。
 * 管理者どうしの権限の差はない。追加・パスワード再発行・2段階認証のやり直しでは仮パスワードを1回だけ返し、
 * 受け取った人は次のログインで必ず自分のパスワードに変える。新規登録した人はここで承認（または削除して却下）する
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AccountInfo, AuthEventItem, TempPasswordResponse } from '../../shared/api';
import {
  type AdminUserRow,
  changeStatus,
  clearFailures,
  deleteAdminIfNotLast,
  deleteSessionsForUser,
  getAdmin,
  getAdminByEmail,
  insertAdmin,
  listAdmins,
  listAuthEvents,
  logAuthEvent,
  setPassword,
  setTotpSecret,
  toAccountInfo,
} from '../db/auth';
import type { AppEnv } from '../env';
import { sendMail } from '../integrations/notify';
import { LIMITS } from '../lib/limits';
import { generateTempPassword, hashPassword } from '../lib/password';
import { clientInfo } from '../lib/session';
import { appUrl, HttpError } from '../lib/util';
import { signupApprovedMail } from '../services/messages';

export const accounts = new Hono<AppEnv>();

/** リセットしたら、その人のロック（パスワード・2段階認証・パスワード変更）も解く。本人がすぐにログインし直せるように */
async function unlock(db: D1Database, user: AdminUserRow): Promise<void> {
  for (const limit of [LIMITS.email(user.email_hash), LIMITS.mfa(user.id), LIMITS.passwordChange(user.id)]) await clearFailures(db, limit.key);
}

async function otherAccountOr404(c: Context<AppEnv>): Promise<AdminUserRow> {
  const user = await getAdmin(c.env.DB, c.req.param('id') ?? '');
  if (!user) throw new HttpError(404, 'アカウントが見つかりません');
  if (user.id === c.var.admin.id) throw new HttpError(400, '自分のアカウントはこの操作の対象にできません（パスワードは「パスワードを変更」から変えてください）');
  return user;
}

/** パスワード再発行・2段階認証のやり直しは、使えるアカウントだけ（承認待ちの人は承認か削除） */
async function activeOtherAccountOr404(c: Context<AppEnv>): Promise<AdminUserRow> {
  const user = await otherAccountOr404(c);
  if (user.status !== 'active') throw new HttpError(400, 'まだ承認されていないアカウントです。承認するか、削除してください');
  return user;
}

accounts.get('/accounts', async (c) => {
  const rows = await listAdmins(c.env.DB);
  return c.json<AccountInfo[]>(rows.map((u) => toAccountInfo(u, c.var.admin.id)));
});

accounts.post('/accounts', async (c) => {
  const input = z
    .object({ name: z.string().trim().min(1, '名前を入力してください').max(100), email: z.email('メールアドレスが正しくありません').max(254).transform((v) => v.toLowerCase()) })
    .parse(await c.req.json());
  if (await getAdminByEmail(c.env.DB, input.email)) throw new HttpError(409, 'このメールアドレスのアカウントはすでにあります');
  const tempPassword = generateTempPassword();
  const id = (await insertAdmin(c.env.DB, { name: input.name, email: input.email, passwordHash: await hashPassword(tempPassword), mustChangePassword: true }))!;
  await logAuthEvent(c.env.DB, { kind: 'account_created', userId: id, actorId: c.var.admin.id, email: input.email, ...clientInfo(c) });
  return c.json<TempPasswordResponse>({ account: toAccountInfo((await getAdmin(c.env.DB, id))!, c.var.admin.id), tempPassword }, 201);
});

/** パスワードを忘れたとき。仮パスワードを発行し、その人のセッションを全部切ってロックを解く。2段階認証はそのまま */
accounts.post('/accounts/:id/reset-password', async (c) => {
  const user = await activeOtherAccountOr404(c);
  const tempPassword = generateTempPassword();
  await setPassword(c.env.DB, user.id, await hashPassword(tempPassword), true);
  await deleteSessionsForUser(c.env.DB, user.id);
  await unlock(c.env.DB, user);
  await logAuthEvent(c.env.DB, { kind: 'password_reset', userId: user.id, actorId: c.var.admin.id, email: user.email, ...clientInfo(c) });
  return c.json<TempPasswordResponse>({ account: toAccountInfo((await getAdmin(c.env.DB, user.id))!, c.var.admin.id), tempPassword });
});

/**
 * スマホをなくした・機種変更したとき。2段階認証を消し、次のログインで登録し直させる。
 * パスワードを知っている第三者に先に登録されないよう、仮パスワードも同時に発行し直す
 */
accounts.post('/accounts/:id/reset-mfa', async (c) => {
  const user = await activeOtherAccountOr404(c);
  const tempPassword = generateTempPassword();
  await setTotpSecret(c.env.DB, user.id, null, null);
  await setPassword(c.env.DB, user.id, await hashPassword(tempPassword), true);
  await deleteSessionsForUser(c.env.DB, user.id);
  await unlock(c.env.DB, user);
  await logAuthEvent(c.env.DB, { kind: 'mfa_reset', userId: user.id, actorId: c.var.admin.id, email: user.email, ...clientInfo(c) });
  return c.json<TempPasswordResponse>({ account: toAccountInfo((await getAdmin(c.env.DB, user.id))!, c.var.admin.id), tempPassword });
});

/** 新規登録した人を承認する（メールアドレスの確認が済んだ人だけ）。本人にメールで知らせる */
accounts.post('/accounts/:id/approve', async (c) => {
  const user = await otherAccountOr404(c);
  if (!(await changeStatus(c.env.DB, user.id, 'pending_approval', 'active'))) throw new HttpError(400, 'この人は承認待ちではありません（メールアドレスの確認がまだか、承認済みです）');
  await logAuthEvent(c.env.DB, { kind: 'account_approved', userId: user.id, actorId: c.var.admin.id, email: user.email, ...clientInfo(c) });
  c.executionCtx.waitUntil(sendMail(c.env, { kind: 'signup_approved', to: user.email, ...signupApprovedMail(c.env.APP_NAME, user.name, `${appUrl(c.env, c)}/login`) }));
  return c.json<AccountInfo>(toAccountInfo((await getAdmin(c.env.DB, user.id))!, c.var.admin.id));
});

/** 削除（承認待ちの人の却下もこれ）。使える管理者が自分だけになる削除はできない */
accounts.delete('/accounts/:id', async (c) => {
  const user = await otherAccountOr404(c);
  if (!(await deleteAdminIfNotLast(c.env.DB, user.id))) throw new HttpError(400, '使える管理者が自分だけになるため、削除できません');
  await logAuthEvent(c.env.DB, { kind: 'account_deleted', actorId: c.var.admin.id, email: user.email, ...clientInfo(c) });
  return c.json({ ok: true });
});

accounts.get('/auth-events', async (c) => c.json<AuthEventItem[]>(await listAuthEvents(c.env.DB, 100)));
