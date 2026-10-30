/**
 * 管理画面にログインできる人（管理者）の管理と、ログインの記録（/api/admin/accounts・/api/admin/auth-events。docs/01「ログイン」）。
 * 管理者どうしの権限の差はない。追加・パスワード再発行・2段階認証のやり直しでは仮パスワードを1回だけ返し、
 * 受け取った人は次のログインで必ず自分のパスワードに変える
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AccountInfo, AuthEventItem, TempPasswordResponse } from '../../shared/api';
import {
  type AdminUserRow,
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
import { generateTempPassword, hashPassword } from '../lib/password';
import { clientInfo } from '../lib/session';
import { HttpError } from '../lib/util';
import { LIMITS } from './auth';

export const accounts = new Hono<AppEnv>();

/** リセットしたら、その人のロック（パスワード・2段階認証・パスワード変更）も解く。本人がすぐにログインし直せるように */
async function unlock(db: D1Database, user: AdminUserRow): Promise<void> {
  for (const limit of [LIMITS.email(user.email), LIMITS.mfa(user.id), LIMITS.passwordChange(user.id)]) await clearFailures(db, limit.key);
}

async function otherAccountOr404(c: Context<AppEnv>): Promise<AdminUserRow> {
  const user = await getAdmin(c.env.DB, c.req.param('id') ?? '');
  if (!user) throw new HttpError(404, 'アカウントが見つかりません');
  if (user.id === c.var.admin.id) throw new HttpError(400, '自分のアカウントはこの操作の対象にできません（パスワードは「パスワードを変更」から変えてください）');
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
  const user = await otherAccountOr404(c);
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
  const user = await otherAccountOr404(c);
  const tempPassword = generateTempPassword();
  await setTotpSecret(c.env.DB, user.id, null, null);
  await setPassword(c.env.DB, user.id, await hashPassword(tempPassword), true);
  await deleteSessionsForUser(c.env.DB, user.id);
  await unlock(c.env.DB, user);
  await logAuthEvent(c.env.DB, { kind: 'mfa_reset', userId: user.id, actorId: c.var.admin.id, email: user.email, ...clientInfo(c) });
  return c.json<TempPasswordResponse>({ account: toAccountInfo((await getAdmin(c.env.DB, user.id))!, c.var.admin.id), tempPassword });
});

accounts.delete('/accounts/:id', async (c) => {
  const user = await otherAccountOr404(c);
  if (!(await deleteAdminIfNotLast(c.env.DB, user.id))) throw new HttpError(400, '最後の1人のアカウントは削除できません');
  await logAuthEvent(c.env.DB, { kind: 'account_deleted', actorId: c.var.admin.id, email: user.email, ...clientInfo(c) });
  return c.json({ ok: true });
});

accounts.get('/auth-events', async (c) => c.json<AuthEventItem[]>(await listAuthEvents(c.env.DB, 100)));
